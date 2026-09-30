import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { createHash } from 'crypto';

import { ApprovalPolicy, ApprovalToolAmountTrigger } from '../../entities/approval-policy.entity';
import { ApprovalRequest } from '../../entities/approval-request.entity';
import { Agent } from '../../entities/agent.entity';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { AuditLogService } from '../audit-log/audit-log.service';

/**
 * A tool call an approval policy's amount rule holds for a person:
 * which rule, and what the call asked for.
 */
export interface ApprovalGateHit {
  policyId: string;
  policyName: string;
  /** The rule in plain words: "Ask before issue_refund when amount is over 500". */
  summary: string;
  toolId: string;
  toolName: string;
  argument: string;
  /** The argument's value on this call; null when it was there but not a number. */
  value: number | null;
  op: 'gt' | 'gte';
  amount: number;
  /** A fingerprint of the call's parameters, so an approval covers this call and no other. */
  paramsHash: string;
}

/** Where a gated call came from, for the audit row and the team scoping of the rules. */
export interface GateContext {
  organizationId: string;
  userId?: string | null;
  agentId?: string | null;
  runId?: string | null;
  /** The team of the agent making the call; a team's rule applies to its agents only. */
  teamId?: string | null;
}

/** A value at a dot path of the call's input (`amount`, `refund.total`). */
export function readArgument(params: unknown, path: string): unknown {
  let at: any = params;
  for (const key of path.split('.')) {
    if (at == null || typeof at !== 'object') return undefined;
    at = at[key];
  }
  return at;
}

/**
 * The number an argument carries: a number, or a string that is one
 * ("820", "1,250.00", "$820"). Null when it is present but not a number.
 */
export function numericValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const cleaned = value.trim().replace(/^[^\d+-.]+/, '').replace(/,/g, '');
    if (!cleaned || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(cleaned)) return null;
    return Number(cleaned);
  }
  return null;
}

/**
 * Whether a call trips an amount rule. A call without the argument does
 * not (there is no amount to be over); one whose argument is there but is
 * not a number does, because a rule that could be walked around by
 * sending "eight hundred" is not a rule.
 */
export function tripsRule(
  trigger: Pick<ApprovalToolAmountTrigger, 'argument' | 'op' | 'amount'>,
  params: unknown,
): { value: number | null } | null {
  const raw = readArgument(params, trigger.argument);
  if (raw === undefined || raw === null || raw === '') return null;
  const value = numericValue(raw);
  if (value === null) return { value: null };
  const over = trigger.op === 'gte' ? value >= trigger.amount : value > trigger.amount;
  return over ? { value } : null;
}

function plainAmount(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** "Ask before issue_refund when amount is over 500" / "... is 500 or more". */
export function describeToolAmountRule(trigger: ApprovalToolAmountTrigger): string {
  const tool = trigger.toolName || 'this tool';
  const limit = trigger.op === 'gte' ? `is ${plainAmount(trigger.amount)} or more` : `is over ${plainAmount(trigger.amount)}`;
  return `Ask before ${tool} when ${trigger.argument} ${limit}`;
}

/** A stable fingerprint of a call's parameters: key order does not change it. */
export function paramsHash(params: unknown): string {
  const stable = (v: any): any =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === 'object'
        ? Object.keys(v)
            .sort()
            .reduce((o, k) => ({ ...o, [k]: stable(v[k]) }), {} as Record<string, any>)
        : v;
  return createHash('sha256').update(JSON.stringify(stable(params ?? {}))).digest('hex');
}

/**
 * The amount rules of approval policies, enforced where a tool is called.
 *
 * ToolExecutorService asks `check` before it runs anything. A call over a
 * rule's amount does not run: the executor answers with the hit instead,
 * and the caller decides what that means. The autonomous runtime asks a
 * person (an approval request, the run paused until they decide) and runs
 * the call with `approvedGate` once they approve; every other caller has
 * no one to wait for, so the call stays refused. `approved` is how the
 * executor tells an approval that really covers this call -- the same
 * tool, the same parameters, decided "approved" -- from anything else.
 */
@Injectable()
export class ToolApprovalGateService {
  private readonly logger = new Logger(ToolApprovalGateService.name);

  constructor(
    @InjectRepository(ApprovalPolicy)
    private readonly policies: Repository<ApprovalPolicy>,
    @InjectRepository(ApprovalRequest)
    private readonly requests: Repository<ApprovalRequest>,
    @Optional() private readonly audit?: AuditLogService,
    @Optional()
    @InjectRepository(Agent)
    private readonly agents?: Repository<Agent>,
  ) {}

  /** The first enabled rule on this tool the call is over, highest priority first. */
  async check(
    tool: { id: string; name: string },
    params: unknown,
    context: GateContext,
  ): Promise<ApprovalGateHit | null> {
    // The organization's enabled amount rules (a handful at most; the
    // partial index on approval_policies covers the lookup), then the ones
    // on this tool.
    const rules = (
      await this.policies.find({
        where: { organizationId: context.organizationId, enabled: true, trigger: Not(IsNull()) },
        order: { priority: 'DESC' },
      })
    ).filter((p) => p.trigger?.toolId === tool.id);
    // The calling agent's team, read only if a team's rule is in play and
    // the caller did not say (a workflow's model node calling tools).
    let teamId = context.teamId;
    if (teamId === undefined && context.agentId && this.agents && rules.some((p) => p.teamId)) {
      const agent = await this.agents
        .findOne({ where: { id: context.agentId, organizationId: context.organizationId }, select: { id: true, teamId: true } })
        .catch(() => null);
      teamId = agent ? (agent.teamId ?? null) : undefined;
    }
    for (const policy of rules) {
      const trigger = policy.trigger;
      if (!trigger || trigger.kind !== 'tool_amount' || trigger.toolId !== tool.id) continue;
      // A team's rule governs that team's agents; an org-wide one, everyone.
      // With no agent behind the call to ask, every rule on the tool holds it.
      if (policy.teamId && teamId !== undefined && teamId !== policy.teamId) continue;
      const trip = tripsRule(trigger, params);
      if (!trip) continue;
      return {
        policyId: policy.id,
        policyName: policy.name,
        summary: describeToolAmountRule({ ...trigger, toolName: tool.name }),
        toolId: tool.id,
        toolName: tool.name,
        argument: trigger.argument,
        value: trip.value,
        op: trigger.op,
        amount: trigger.amount,
        paramsHash: paramsHash(params),
      };
    }
    return null;
  }

  /**
   * Whether `approvalId` is an approved request raised by this rule for
   * exactly this call (same tool, same parameters) in this organization.
   */
  async approved(approvalId: string, hit: ApprovalGateHit, organizationId: string): Promise<boolean> {
    const row = await this.requests.findOne({ where: { id: approvalId, organizationId } });
    const gate = row?.payload?._gate;
    return (
      !!row &&
      row.status === 'approved' &&
      !!gate &&
      gate.toolId === hit.toolId &&
      gate.paramsHash === hit.paramsHash
    );
  }

  /** One audit row when a rule holds a call (it did not run: a person is asked, or it stays refused where nobody can be), and one when an approved call runs. */
  async record(hit: ApprovalGateHit, context: GateContext, outcome: 'held' | 'approved'): Promise<void> {
    if (!this.audit) return;
    await this.audit
      .log({
        organizationId: context.organizationId,
        userId: context.userId ?? undefined,
        action: AuditAction.APPROVAL_GATE,
        resourceType: AuditResource.TOOL,
        resourceId: hit.toolId,
        resourceName: hit.toolName,
        status: outcome,
        details: {
          rule: hit.summary,
          policyId: hit.policyId,
          policyName: hit.policyName,
          argument: hit.argument,
          value: hit.value,
          amount: hit.amount,
          op: hit.op,
          agentId: context.agentId ?? null,
          runId: context.runId ?? null,
        },
      })
      .catch((err: any) => this.logger.warn(`Could not audit a held tool call: ${err?.message ?? err}`));
  }
}
