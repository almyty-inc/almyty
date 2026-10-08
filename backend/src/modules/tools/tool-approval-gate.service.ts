import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { createHash } from 'crypto';

import { ApprovalPolicy, ApprovalToolAmountTrigger } from '../../entities/approval-policy.entity';
import { ApprovalRequest } from '../../entities/approval-request.entity';
import { Agent } from '../../entities/agent.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { ApprovalsService } from '../approvals/approvals.service';
import type { ExecutionPrincipal } from '../../common/authorization/execution-access.service';
import { ToolExecutorService } from './tool-executor.service';
import { NamedTool, readableToolName } from './tool-readable-name';

/**
 * A tool call an approval policy's amount rule holds for a person:
 * which rule, and what the call asked for.
 */
export interface ApprovalGateHit {
  /**
   * What held the call: an approval policy's amount rule, or the calling
   * always-on agent's ask-first list (its `tool_call` rule; the amount
   * fields are then empty).
   */
  kind?: 'tool_amount' | 'tool_call';
  /** The policy's id; for the ask-first list, `always-on:<agentId>`. */
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

/**
 * Emitted on ApprovalsService once an approved held call has been made and
 * its outcome kept on the request (runHeld), with the request row: workflow
 * runs waiting on it carry on (agents/workflow-approval-resume.service.ts).
 */
export const HELD_CALL_SETTLED = 'approval.held_call_settled';

/** What about this call tripped the rule, in words: "amount is 820", "it is on the ask-first list". */
export function hitDetail(hit: Pick<ApprovalGateHit, 'kind' | 'argument' | 'value'>): string {
  if (hit.kind === 'tool_call') return 'it is on the list of things to ask about first';
  return hit.value === null ? `${hit.argument} is not a number` : `${hit.argument} is ${hit.value}`;
}

/**
 * Whether an always-on run must ask before this tool (docs/always-on.md,
 * "Act or propose"): in `propose`, before anything that is not read-only;
 * in `act`, before the tools on the agent's ask-first list.
 */
export function asksFirst(
  config: { enabled?: boolean; actMode?: string; askFirstToolIds?: string[] } | null | undefined,
  tool: { id: string; sideEffect?: string | null },
): boolean {
  if (!config) return false;
  if (config.actMode === 'act') return Array.isArray(config.askFirstToolIds) && config.askFirstToolIds.includes(tool.id);
  return tool.sideEffect !== 'read';
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
 * What a held call needs to run later exactly as it was asked: who asked,
 * in which scope, through which gateway.
 */
export interface HeldCallContext {
  userId: string | null;
  principal: ExecutionPrincipal | null;
  gatewayId: string | null;
  scopes: string[] | null;
  runnerLabels: Record<string, string> | null;
  pinnedRunnerId?: string | null;
  agentTeamId: string | null;
}

/** Where a held call stands, for a caller that comes back with its approval id. */
export type HeldCallState =
  | { status: 'waiting' }
  | { status: 'refused'; reason: string }
  | { status: 'done'; result: Record<string, any> };

/**
 * The amount rules of approval policies, enforced where a tool is called.
 *
 * ToolExecutorService asks `check` before it runs anything. A call over a
 * rule's amount does not run. The autonomous runtime asks a person itself
 * (its run pauses) and calls again with `approvedGate` once they approve.
 * Every other caller cannot wait, so the call is held here (`hold`): it
 * waits in Approvals as a request with no run, and once approved it runs
 * once, exactly as asked (`runHeld`, on the 'approval.decided' event), and
 * what it returned is kept on the request for the caller to collect.
 * `approved` is how the executor tells an approval that really covers a
 * call -- the same tool, the same parameters, decided "approved" -- from
 * anything else.
 */
@Injectable()
export class ToolApprovalGateService implements OnModuleInit {
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
    // The approvals service and the executor, reached lazily: the approvals
    // module imports the agents module, which imports this one, and the
    // executor injects this service.
    @Optional() private readonly moduleRef?: ModuleRef,
    // The run a call belongs to: an always-on run's ask-first list holds it.
    @Optional()
    @InjectRepository(AgentRun)
    private readonly runs?: Repository<AgentRun>,
  ) {}

  private approvalsService(): ApprovalsService | null {
    try {
      return (this.moduleRef?.get(ApprovalsService, { strict: false }) as ApprovalsService) ?? null;
    } catch {
      return null;
    }
  }

  onModuleInit(): void {
    const approvals = this.approvalsService();
    approvals?.on('approval.decided', (row: ApprovalRequest) => {
      if (!row?.toolId || row.runId || row.status !== 'approved') return;
      this.runHeld(row.id, row.organizationId).catch((err: any) =>
        this.logger.error(`Could not run the approved call ${row.id}: ${err?.message ?? err}`),
      );
    });
  }

  /**
   * Hold a call nobody can wait for: ask a person. The same call held
   * twice while the first is still pending is one request.
   */
  async hold(
    tool: { id: string; name: string },
    parameters: Record<string, any>,
    hit: ApprovalGateHit,
    context: GateContext,
    call: HeldCallContext,
  ): Promise<ApprovalRequest | null> {
    const pending = await this.requests.findOne({
      where: { organizationId: context.organizationId, toolId: tool.id, fingerprint: hit.paramsHash, status: 'pending' },
    });
    if (pending) return pending;
    const approvals = this.approvalsService();
    if (!approvals) return null;
    const why = hitDetail(hit);
    const row = await approvals.create({
      organizationId: context.organizationId,
      teamId: call.agentTeamId ?? null,
      runId: null,
      agentId: context.agentId ?? null,
      toolId: tool.id,
      fingerprint: hit.paramsHash,
      reason: `${hit.summary}. On this call ${why}.`,
      payload: {
        tool: readableToolName(tool as NamedTool),
        parameters,
        _gate: {
          kind: hit.kind ?? 'tool_amount',
          policyId: hit.policyId,
          toolId: hit.toolId,
          argument: hit.argument,
          value: hit.value,
          op: hit.op,
          amount: hit.amount,
          paramsHash: hit.paramsHash,
          rule: hit.summary,
          call,
        },
      },
      principal: call.principal,
    });
    await this.record(hit, context, 'held');
    return row;
  }

  /** Where a held call stands, for the caller that comes back with its approval id. */
  async stateOf(approvalId: string, hit: ApprovalGateHit, organizationId: string): Promise<HeldCallState | null> {
    const row = await this.requests.findOne({ where: { id: approvalId, organizationId } }).catch(() => null);
    if (!row || row.toolId !== hit.toolId || row.fingerprint !== hit.paramsHash) return null;
    if (row.status === 'pending') return { status: 'waiting' };
    if (row.status === 'rejected' || row.status === 'expired') {
      return { status: 'refused', reason: row.status === 'expired' ? 'nobody decided in time' : row.decisionReason || 'a person rejected it' };
    }
    if (row.resultAt && row.result) return { status: 'done', result: row.result };
    // Approved, and running now (or about to).
    return { status: 'waiting' };
  }

  /**
   * Run an approved held call, once. `resultAt` is claimed before it runs,
   * so the event and a retry arriving together cannot both run it.
   */
  async runHeld(approvalId: string, organizationId: string): Promise<void> {
    const row = await this.requests.findOne({ where: { id: approvalId, organizationId } });
    if (!row || row.status !== 'approved' || !row.toolId || row.runId) return;
    const claim = await this.requests.update(
      { id: row.id, status: 'approved', resultAt: IsNull() },
      { resultAt: new Date() },
    );
    if (!claim.affected) return;
    const call = (row.payload?._gate?.call ?? {}) as Partial<HeldCallContext>;
    const executor = this.moduleRef?.get(ToolExecutorService, { strict: false });
    if (!executor) return;
    let result: { success: boolean; data?: unknown; error?: string };
    try {
      result = await executor.executeTool(row.toolId, row.payload?.parameters ?? {}, {
        organizationId,
        userId: call.userId ?? (undefined as any),
        ...(call.principal ? { principal: call.principal } : {}),
        ...(call.gatewayId ? { gatewayId: call.gatewayId } : {}),
        ...(call.scopes ? { scopes: call.scopes } : {}),
        ...(call.runnerLabels ? { runnerLabels: call.runnerLabels } : {}),
        ...(call.pinnedRunnerId ? { pinnedRunnerId: call.pinnedRunnerId } : {}),
        agentId: row.agentId ?? null,
        agentTeamId: call.agentTeamId ?? null,
        approvedGate: { approvalId: row.id },
      });
    } catch (err: any) {
      // Kept as the call's outcome, so whoever waits on it hears that it failed instead of waiting forever.
      result = { success: false, error: err?.message ?? 'The call failed' };
    }
    const kept = { success: result.success, data: result.data ?? null, error: result.error ?? null };
    await this.requests.update({ id: row.id }, { result: kept as any });
    // Whoever waits on this call (a workflow run, WorkflowApprovalResumeService) carries on now.
    try {
      this.approvalsService()?.emit(HELD_CALL_SETTLED, { ...row, result: kept });
    } catch (err: any) {
      this.logger.error(`Could not announce the outcome of the approved call ${row.id}: ${err?.message ?? err}`);
    }
  }

  /** The first enabled rule on this tool the call is over, highest priority first. */
  async check(
    tool: NamedTool & { id: string },
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
        // The tool as people know it (its summary), in quotes: the sentence goes on the approval request.
        summary: describeToolAmountRule({ ...trigger, toolName: `“${readableToolName(tool)}”` }),
        toolId: tool.id,
        toolName: tool.name,
        argument: trigger.argument,
        value: trip.value,
        op: trigger.op,
        amount: trigger.amount,
        paramsHash: paramsHash(params),
      };
    }
    return this.askFirstHit(tool, params, context);
  }

  /**
   * The ask-first rule of an always-on run: the run's agent is always on,
   * this run is one of its standing thread's, and the tool is one it asks
   * about first (asksFirst). Other runs of the same agent (a visitor's chat,
   * a scheduled run) are not held by it.
   */
  private async askFirstHit(
    tool: NamedTool & { id: string; sideEffect?: string | null },
    params: unknown,
    context: GateContext,
  ): Promise<ApprovalGateHit | null> {
    if (!context.runId || !context.agentId || !this.runs || !this.agents) return null;
    const run = await this.runs
      .findOne({ where: { id: context.runId, organizationId: context.organizationId }, select: { id: true, agentId: true, metadata: true } as any })
      .catch(() => null);
    if (!run || run.metadata?.triggerType !== 'always_on' || run.agentId !== context.agentId) return null;
    const agent = await this.agents
      .findOne({ where: { id: context.agentId, organizationId: context.organizationId }, select: { id: true, name: true, alwaysOn: true } as any })
      .catch(() => null);
    const config = (agent as any)?.alwaysOn ?? null;
    if (!asksFirst(config, tool)) return null;
    const name = readableToolName(tool);
    return {
      kind: 'tool_call',
      policyId: `always-on:${context.agentId}`,
      policyName: 'Ask first',
      summary:
        config?.actMode === 'act'
          ? `Ask before “${name}” (it is on the ask-first list)`
          : `Ask before “${name}” (it changes something, and this agent asks before it changes anything)`,
      toolId: tool.id,
      toolName: tool.name,
      argument: '',
      value: null,
      op: 'gt',
      amount: 0,
      paramsHash: paramsHash(params),
    };
  }

  /**
   * Whether `approvalId` is an approved request that covers exactly this
   * call (same tool, same parameters) in this organization: one raised by
   * this rule for the call, or a script's change set with the call in it
   * (docs/design/code-mode.md, part D: the person saw the call and its rule
   * in the set and approved the set as a whole).
   */
  async approved(approvalId: string, hit: ApprovalGateHit, organizationId: string): Promise<boolean> {
    const row = await this.requests.findOne({ where: { id: approvalId, organizationId } });
    if (!row || row.status !== 'approved') return false;
    const gate = row.payload?._gate;
    if (gate && gate.toolId === hit.toolId && gate.paramsHash === hit.paramsHash) return true;
    const changeSet = row.payload?.changeSet;
    return (
      row.payload?.kind === 'change_set' &&
      Array.isArray(changeSet) &&
      changeSet.some((entry: any) => entry?.toolId === hit.toolId && entry?.paramsHash === hit.paramsHash)
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
          kind: hit.kind ?? 'tool_amount',
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
