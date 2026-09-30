import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';

import { ApprovalPolicy, ApprovalStep, ApprovalToolAmountTrigger } from '../../entities/approval-policy.entity';
import { Tool } from '../../entities/tool.entity';
import { OrgLicenseResolver } from '../licensing/org-license.resolver';
import { EE_ENTITLEMENTS } from '../licensing/license.constants';

/** A dot path into a tool's input: `amount`, `refund.total`. */
const ARGUMENT_PATH = /^[A-Za-z_$][\w$-]*(?:\.[A-Za-z_$][\w$-]*)*$/;

/** Anyone who may approve: one approval from an owner, an admin or the team's lead. */
export const SINGLE_APPROVER_STEPS: ApprovalStep[] = Object.freeze([
  { name: 'Approval', approverRole: '*', minApprovals: 1 },
]) as ApprovalStep[];

/**
 * An amount rule in its stored shape, or null. The tool has to be one of
 * the organization's, and its name is taken from the tool row (it is what
 * the rule's plain-language summary says). Shared by the free rules
 * endpoints here and the Business policy editor (ee/).
 */
export async function checkAmountRule(
  tools: Repository<Tool>,
  organizationId: string,
  trigger: ApprovalToolAmountTrigger | null | undefined,
): Promise<ApprovalToolAmountTrigger | null> {
  if (trigger == null) return null;
  if (trigger.kind !== 'tool_amount') throw new BadRequestException('the rule must be a tool amount rule');
  const tool =
    typeof trigger.toolId === 'string' && trigger.toolId
      ? await tools.findOne({ where: { id: trigger.toolId, organizationId }, select: { id: true, name: true } })
      : null;
  if (!tool) throw new BadRequestException('Choose one of your tools for the rule.');
  const argument = typeof trigger.argument === 'string' ? trigger.argument.trim() : '';
  if (!ARGUMENT_PATH.test(argument)) throw new BadRequestException('Choose the number the rule compares.');
  if (trigger.op !== 'gt' && trigger.op !== 'gte') throw new BadRequestException('The comparison must be over, or at or over.');
  const amount = Number(trigger.amount);
  if (!Number.isFinite(amount) || amount < 0) throw new BadRequestException('The amount must be a number of 0 or more.');
  return { kind: 'tool_amount', toolId: tool.id, toolName: tool.name, argument, op: trigger.op, amount };
}

export interface AmountRuleInput {
  name?: string;
  description?: string | null;
  teamId?: string | null;
  enabled?: boolean;
  trigger?: ApprovalToolAmountTrigger;
  steps?: ApprovalStep[];
}

/**
 * Amount rules ("ask before issue_refund when amount is over 500") for
 * every organization, free. They are approval policies with a `trigger`;
 * a rule is decided by one approval from anyone who may approve (an owner,
 * an admin or, for a team's rule, its lead). Sign-off in several steps or
 * by a quorum is the Business approval-policy feature: an organization
 * with it may give a rule its own steps, one without it keeps the single
 * approver and is told so.
 */
@Injectable()
export class AmountRulesService {
  constructor(
    @InjectRepository(ApprovalPolicy)
    private readonly policies: Repository<ApprovalPolicy>,
    @InjectRepository(Tool)
    private readonly tools: Repository<Tool>,
    @Optional() private readonly licenses?: OrgLicenseResolver,
  ) {}

  list(organizationId: string): Promise<ApprovalPolicy[]> {
    return this.policies.find({
      where: { organizationId, trigger: Not(IsNull()) },
      order: { createdAt: 'ASC' },
    });
  }

  async get(organizationId: string, id: string): Promise<ApprovalPolicy> {
    const row = await this.policies.findOne({ where: { id, organizationId, trigger: Not(IsNull()) } });
    if (!row) throw new NotFoundException('Approval rule not found');
    return row;
  }

  async create(organizationId: string, input: AmountRuleInput): Promise<ApprovalPolicy> {
    const name = input.name?.trim();
    if (!name) throw new BadRequestException('Give the rule a name.');
    const trigger = await checkAmountRule(this.tools, organizationId, input.trigger);
    if (!trigger) throw new BadRequestException('Say when to ask: the tool, the number and the amount.');
    const row = this.policies.create({
      organizationId,
      name: name.slice(0, 128),
      description: input.description ?? null,
      teamId: input.teamId ?? null,
      match: [],
      steps: await this.stepsFor(organizationId, input.steps),
      priority: 0,
      enabled: input.enabled ?? true,
      trigger,
    });
    return this.policies.save(row);
  }

  async update(organizationId: string, id: string, input: AmountRuleInput): Promise<ApprovalPolicy> {
    const row = await this.get(organizationId, id);
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new BadRequestException('Give the rule a name.');
      row.name = name.slice(0, 128);
    }
    if (input.description !== undefined) row.description = input.description ?? null;
    if (input.teamId !== undefined) row.teamId = input.teamId ?? null;
    if (input.enabled !== undefined) row.enabled = input.enabled;
    if (input.trigger !== undefined) {
      const trigger = await checkAmountRule(this.tools, organizationId, input.trigger);
      if (!trigger) throw new BadRequestException('Say when to ask: the tool, the number and the amount.');
      row.trigger = trigger;
    }
    if (input.steps !== undefined) row.steps = await this.stepsFor(organizationId, input.steps);
    return this.policies.save(row);
  }

  async remove(organizationId: string, id: string): Promise<void> {
    await this.policies.remove(await this.get(organizationId, id));
  }

  /** The single approver, unless the organization has Business approval policies and set its own steps. */
  private async stepsFor(organizationId: string, steps: ApprovalStep[] | undefined): Promise<ApprovalStep[]> {
    if (!steps || JSON.stringify(steps) === JSON.stringify(SINGLE_APPROVER_STEPS)) return [...SINGLE_APPROVER_STEPS];
    const entitled = this.licenses
      ? await this.licenses.hasForOrg(organizationId, EE_ENTITLEMENTS.APPROVAL_POLICY).catch(() => false)
      : false;
    if (!entitled) {
      throw new BadRequestException('Sign-off in several steps comes with the Business plan. Without it, one approval decides.');
    }
    if (!Array.isArray(steps) || steps.length === 0) throw new BadRequestException('Add at least one approval step.');
    for (const step of steps) {
      if (!step?.name?.trim()) throw new BadRequestException('Each step needs a name.');
      if (!step.approverRole?.trim()) throw new BadRequestException(`Step "${step.name}" needs an approver role.`);
      if (!Number.isInteger(step.minApprovals) || step.minApprovals < 1) {
        throw new BadRequestException(`Step "${step.name}" needs at least one approval.`);
      }
    }
    return steps.map((s) => ({ name: s.name.trim(), approverRole: s.approverRole.trim(), minApprovals: s.minApprovals }));
  }
}
