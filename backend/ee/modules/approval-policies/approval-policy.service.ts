import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  ApprovalPolicy,
  ApprovalStep,
  ApprovalMatchCondition,
  ApprovalToolAmountTrigger,
} from '../../../src/entities/approval-policy.entity';
import { Tool } from '../../../src/entities/tool.entity';
import {
  ApprovalContext,
  ApprovalPolicyEvaluator,
  CollectedApproval,
  PolicyProgress,
} from './approval-policy.evaluator';

export interface CreateApprovalPolicyInput {
  organizationId: string;
  name: string;
  description?: string;
  teamId?: string | null;
  match?: ApprovalMatchCondition[];
  steps?: ApprovalStep[];
  priority?: number;
  enabled?: boolean;
  /** An amount rule: the policy asks on its own when the tool is called over the amount. Null clears it. */
  trigger?: ApprovalToolAmountTrigger | null;
}

/** A dot path into a tool's input: `amount`, `refund.total`. */
const ARGUMENT_PATH = /^[A-Za-z_$][\w$-]*(\.[A-Za-z_$][\w$-]*)*$/;

/**
 * EE (approval_policy): CRUD for multi-step / conditional / quorum
 * approval policies, plus the resolve + score helpers the approvals
 * runtime calls. The OSS single-gate approval stays in the approvals
 * module; this only fires when a request matches a configured policy.
 */
@Injectable()
export class ApprovalPolicyService {
  constructor(
    @InjectRepository(ApprovalPolicy)
    private readonly policies: Repository<ApprovalPolicy>,
    private readonly evaluator: ApprovalPolicyEvaluator,
    @InjectRepository(Tool)
    private readonly tools: Repository<Tool>,
  ) {}

  async create(input: CreateApprovalPolicyInput): Promise<ApprovalPolicy> {
    if (!input.name?.trim()) throw new BadRequestException('policy name is required');
    this.validateSteps(input.steps ?? []);
    const trigger = await this.checkTrigger(input.organizationId, input.trigger);
    const row = this.policies.create({
      organizationId: input.organizationId,
      name: input.name.trim(),
      description: input.description ?? null,
      teamId: input.teamId ?? null,
      match: input.match ?? [],
      steps: input.steps ?? [],
      priority: input.priority ?? 0,
      enabled: input.enabled ?? true,
      trigger,
    });
    return this.policies.save(row);
  }

  async list(organizationId: string): Promise<ApprovalPolicy[]> {
    return this.policies.find({
      where: { organizationId },
      order: { priority: 'DESC', createdAt: 'ASC' },
    });
  }

  async get(organizationId: string, id: string): Promise<ApprovalPolicy> {
    const row = await this.policies.findOne({ where: { id, organizationId } });
    if (!row) throw new NotFoundException('approval policy not found');
    return row;
  }

  async update(
    organizationId: string,
    id: string,
    patch: Partial<CreateApprovalPolicyInput>,
  ): Promise<ApprovalPolicy> {
    const row = await this.get(organizationId, id);
    if (patch.steps !== undefined) {
      this.validateSteps(patch.steps);
      row.steps = patch.steps;
    }
    if (patch.name !== undefined) row.name = patch.name.trim();
    if (patch.description !== undefined) row.description = patch.description ?? null;
    if (patch.teamId !== undefined) row.teamId = patch.teamId ?? null;
    if (patch.match !== undefined) row.match = patch.match;
    if (patch.priority !== undefined) row.priority = patch.priority;
    if (patch.enabled !== undefined) row.enabled = patch.enabled;
    if (patch.trigger !== undefined) row.trigger = await this.checkTrigger(organizationId, patch.trigger);
    return this.policies.save(row);
  }

  async remove(organizationId: string, id: string): Promise<void> {
    const row = await this.get(organizationId, id);
    await this.policies.remove(row);
  }

  /**
   * Resolve which policy (if any) governs a request context. Returns null
   * when no policy matches — the caller then applies the OSS single-gate.
   */
  async resolveForContext(
    organizationId: string,
    ctx: ApprovalContext,
  ): Promise<ApprovalPolicy | null> {
    const policies = await this.policies.find({
      where: { organizationId, enabled: true },
    });
    return this.evaluator.resolvePolicy(policies, ctx);
  }

  /** Score collected approvals against a policy (delegates to evaluator). */
  scoreProgress(policy: ApprovalPolicy, approvals: CollectedApproval[]): PolicyProgress {
    return this.evaluator.progress(policy, approvals);
  }

  /**
   * An amount rule in its stored shape, or null. The tool has to be one
   * of the organization's, and its name is taken from the tool row (it is
   * what the rule's plain-language summary says).
   */
  private async checkTrigger(
    organizationId: string,
    trigger: ApprovalToolAmountTrigger | null | undefined,
  ): Promise<ApprovalToolAmountTrigger | null> {
    if (trigger == null) return null;
    if (trigger.kind !== 'tool_amount') throw new BadRequestException('the rule must be a tool amount rule');
    const tool =
      typeof trigger.toolId === 'string' && trigger.toolId
        ? await this.tools.findOne({ where: { id: trigger.toolId, organizationId }, select: { id: true, name: true } })
        : null;
    if (!tool) throw new BadRequestException('Choose one of your tools for the rule.');
    const argument = typeof trigger.argument === 'string' ? trigger.argument.trim() : '';
    if (!ARGUMENT_PATH.test(argument)) throw new BadRequestException('Choose the number the rule compares.');
    if (trigger.op !== 'gt' && trigger.op !== 'gte') throw new BadRequestException('The comparison must be over, or at or over.');
    const amount = Number(trigger.amount);
    if (!Number.isFinite(amount) || amount < 0) throw new BadRequestException('The amount must be a number of 0 or more.');
    return { kind: 'tool_amount', toolId: tool.id, toolName: tool.name, argument, op: trigger.op, amount };
  }
  private validateSteps(steps: ApprovalStep[]): void {
    if (!Array.isArray(steps)) throw new BadRequestException('steps must be an array');
    for (const step of steps) {
      if (!step.name?.trim()) throw new BadRequestException('each step needs a name');
      if (!step.approverRole?.trim())
        throw new BadRequestException(`step "${step.name}" needs an approverRole`);
      if (!Number.isInteger(step.minApprovals) || step.minApprovals < 1) {
        throw new BadRequestException(`step "${step.name}" needs minApprovals >= 1`);
      }
    }
  }
}
