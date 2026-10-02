import { Inject, Injectable, Logger, OnModuleInit, Optional, forwardRef } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { stripTypeScriptTypes } from 'module';

import { ChangeSetEntry, CodeExecution, CodeExecutionStatus } from '../../entities/code-execution.entity';
import { Tool } from '../../entities/tool.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import type { ExecutionPrincipal } from '../../common/authorization/execution-access.service';
import { ApprovalRequest } from '../../entities/approval-request.entity';
import { ApprovalsService } from '../approvals/approvals.service';
import { withTruncationMarker } from '../agents/persist-cap';
import { NodeSandboxService } from '../tools/node-sandbox/node-sandbox.service';
import { QuickJsSandboxService } from '../tools/node-sandbox/quickjs-sandbox.service';
import type { CodeCall } from '../tools/node-sandbox/types';
import { ToolExecutorService } from '../tools/tool-executor.service';
import { ToolApprovalGateService } from '../tools/tool-approval-gate.service';
import type { ToolExecutionResult } from '../tools/tool-execution.types';
import { ToolDiscoveryService } from '../tool-discovery/tool-discovery.service';
import { BrokeredCall, CodeBroker, ExtractFn } from './code-broker';
import { CodeModeLimits, codeModeLimits, scriptTimeoutMs } from './code-mode.settings';
import { CodeResultForModel, changeSetOutcomeForModel, codeResultForModel } from './code-result';
import { CodeModeConfig, grantsLeftFor } from './code-write-policy';
import { Gateway } from '../../entities/gateway.entity';
import { Organization } from '../../entities/organization.entity';
import { gatewayPrincipal } from '../../common/authorization/execution-access.service';
import { LlmProvidersService } from '../llm-providers/llm-providers.service';
import { buildExtract } from './code-extract';
import { Agent } from '../../entities/agent.entity';
import { ToolStatus } from '../../entities/tool.entity';
import { agentApiIds } from '../agents/agent-capabilities';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { servableToolsOnGateway } from '../gateways/gateway-servable';
import { GatewayExposure, effectiveExposure } from './code-exposure';

/** Who a script runs for, as every brokered call is made: the outer call's principal and scope. */
export interface CodeCallContext {
  organizationId: string;
  userId?: string | null;
  principal?: ExecutionPrincipal;
  runId?: string | null;
  agentId?: string | null;
  agentTeamId?: string | null;
  gatewayId?: string | null;
  scopes?: string[];
  runnerLabels?: Record<string, string>;
  retries?: number;
}

export interface RunCodeInput {
  code: unknown;
  timeoutMs?: unknown;
  /** The tools the script may use: exactly the caller's executable tools, with API names attached. */
  scope: Tool[];
  context: CodeCallContext;
  policy: CodeModeConfig | null | undefined;
  grantsLeft: Map<string, number>;
  limits: CodeModeLimits;
  extract?: ExtractFn;
  signal?: AbortSignal;
  /** The script's `context` global (a workflow step's input and earlier steps); absent for agents and gateways. */
  scriptContext?: unknown;
  /** Where the script runs: the Node code profile (agents, workflows; the default) or QuickJS (outside clients). */
  runtime?: 'node' | 'quickjs';
}

/** What a script did, for the caller and (through forModel) for the model. */
export interface RunCodeOutcome {
  codeExecutionId: string;
  status: CodeExecutionStatus;
  /** The return value (parsed JSON), or its capped text with the truncation marker. */
  result: unknown;
  /** log() output, capped with the truncation marker. */
  logs: string;
  error?: { message: string; line?: number; tool?: string };
  calls: BrokeredCall[];
  /** The change set: calls staged for a person, not run. */
  staged: ChangeSetEntry[];
  /** Writes and deletes that ran and succeeded before the script ended. */
  committed: Array<{ tool: string; toolId: string; arguments: Record<string, any> }>;
  grantsUsed: Record<string, number>;
  extractCost: number;
  extractTokens: number;
  cpuMs: number;
  durationMs: number;
}

/** Who a held change set runs as once approved: the caller of the script, as a held tool call keeps it. */
export interface HeldChangeSetCall {
  userId: string | null;
  principal: ExecutionPrincipal | null;
  gatewayId: string | null;
  scopes: string[] | null;
  runnerLabels: Record<string, string> | null;
  agentTeamId: string | null;
}

/** What a held change set needs of ApprovalsService (reached lazily: approvals imports agents, which imports this). */
export type HeldChangeSetApprovals = Pick<ApprovalsService, 'create' | 'findInOrganization' | 'on'>;

/** What a caller that cannot pause hands back to its client for one run_code. */
export interface UnattendedRunAnswer {
  forModel: Record<string, unknown>;
  isError: boolean;
  /** Present while changes wait for a person, and on the answer that reports them. */
  approvalId?: string;
  codeExecutionId?: string;
}

/**
 * Code mode's `run_code` (docs/design/code-mode.md, part C): one script,
 * run in the sandbox's `code` profile, its calls brokered (code-broker.ts),
 * its trace kept in `code_executions` with each brokered call an ordinary
 * `tool_executions` row pointing at it.
 */
@Injectable()
export class CodeModeService implements OnModuleInit {
  private readonly logger = new Logger(CodeModeService.name);

  constructor(
    @InjectRepository(CodeExecution)
    private readonly executions: Repository<CodeExecution>,
    @InjectRepository(ToolExecution)
    private readonly toolExecutions: Repository<ToolExecution>,
    private readonly sandbox: NodeSandboxService,
    @Inject(forwardRef(() => ToolExecutorService))
    private readonly executor: ToolExecutorService,
    @Optional() discovery?: ToolDiscoveryService,
    // Names the amount rule a staged call would also trip (part D: one decision covers both).
    @Optional() @Inject(forwardRef(() => ToolApprovalGateService)) private readonly gate?: ToolApprovalGateService,
    // ApprovalsService for held change sets, reached lazily (see HeldChangeSetApprovals).
    @Optional() private readonly moduleRef?: ModuleRef,
    // The QuickJS runtime for scripts from outside clients (gateway run_code).
    @Optional() private readonly quickjs?: QuickJsSandboxService,
  ) {
    this.discovery = discovery ?? new ToolDiscoveryService();
  }

  private readonly discovery: ToolDiscoveryService;

  async run(input: RunCodeInput): Promise<RunCodeOutcome> {
    const started = Date.now();
    const { context, limits } = input;
    const source = typeof input.code === 'string' ? input.code : '';
    const row = await this.executions.save(
      this.executions.create({
        organizationId: context.organizationId,
        runId: context.runId ?? null,
        agentId: context.agentId ?? null,
        gatewayId: context.gatewayId ?? null,
        userId: context.userId ?? null,
        code: source.slice(0, limits.maxCodeChars + 1),
        status: 'running',
        changeSet: [],
      }),
    );

    const broker = new CodeBroker({
      scope: input.scope,
      organizationId: context.organizationId,
      policy: input.policy,
      grantsLeft: input.grantsLeft,
      limits,
      discovery: this.discovery,
      extract: input.extract,
      ...(this.gate
        ? {
            ruleFor: async (tool: Tool, args: Record<string, any>) =>
              (
                await this.gate!.check(tool, args, {
                  organizationId: context.organizationId,
                  userId: context.userId ?? null,
                  agentId: context.agentId ?? null,
                  runId: context.runId ?? null,
                  teamId: context.agentTeamId,
                })
              )?.summary ?? null,
          }
        : {}),
      execute: (tool, args) => this.execute(tool, args, context, row.id, input.signal),
    });

    const fail = (message: string) =>
      this.finish(row, broker, input, started, { success: false, logs: '', error: { message }, cpuMs: 0 });

    if (!source.trim()) return fail('The script is empty.');
    if (source.length > limits.maxCodeChars) return fail(`The script is longer than ${limits.maxCodeChars} characters.`);
    let body: string;
    try {
      body = stripTypes(source);
    } catch (err: any) {
      return fail(`The script is not valid TypeScript or JavaScript: ${err?.message ?? err}`);
    }

    const request = {
      code: body,
      namespaces: broker.namespaces(),
      organizationId: context.organizationId,
      timeoutMs: scriptTimeoutMs(input.timeoutMs, limits),
      memoryLimitMb: limits.memoryMb,
      logCapChars: limits.logCapChars,
      resultCapChars: limits.resultCapChars,
      onCall: (call: CodeCall) => broker.handle(call),
      signal: input.signal,
      ...(input.scriptContext !== undefined ? { context: input.scriptContext } : {}),
    };
    // Scripts from outside clients run in QuickJS (decision 1 as taken);
    // agents and workflows inside almyty keep the Node code profile.
    if (input.runtime === 'quickjs') {
      if (!this.quickjs) return fail('Scripts from outside clients are not available on this server.');
      const sandboxed = await this.quickjs.executeCode({ ...request, cpuBudgetMs: limits.cpuBudgetMs });
      return this.finish(row, broker, input, started, sandboxed);
    }
    const sandboxed = await this.sandbox.executeCode(request);
    return this.finish(row, broker, input, started, sandboxed);
  }

  /** One brokered call: the executor, as the outer call, recorded under this script. */
  private execute(tool: Tool, args: Record<string, any>, context: CodeCallContext, codeExecutionId: string, signal?: AbortSignal): Promise<ToolExecutionResult> {
    return this.executor.executeTool(tool.id, args, {
      userId: context.userId ?? (undefined as any),
      ...(context.principal ? { principal: context.principal } : {}),
      organizationId: context.organizationId,
      ...(context.gatewayId ? { gatewayId: context.gatewayId } : {}),
      ...(context.scopes ? { scopes: context.scopes } : {}),
      ...(context.runnerLabels ? { runnerLabels: context.runnerLabels } : {}),
      ...(context.retries !== undefined ? { retries: context.retries } : {}),
      runId: context.runId ?? undefined,
      agentId: context.agentId ?? null,
      agentTeamId: context.agentTeamId ?? null,
      // A caller that can pause asks the person itself: an amount rule's
      // hold comes back as approvalRequired, which the broker stages.
      holdForApproval: 'caller',
      codeExecutionId,
      ...(signal ? { signal } : {}),
    });
  }

  private async finish(
    row: CodeExecution,
    broker: CodeBroker,
    input: RunCodeInput,
    started: number,
    sandboxed: {
      success: boolean;
      resultJson?: string;
      resultChars?: number;
      logs: string;
      logChars?: number;
      error?: { message: string; line?: number; tool?: string };
      cpuMs: number;
    },
  ): Promise<RunCodeOutcome> {
    const logs = sandboxed.logChars ? withTruncationMarker(sandboxed.logs, sandboxed.logChars) : sandboxed.logs;
    let result: unknown = null;
    if (sandboxed.success && sandboxed.resultJson !== undefined) {
      if (sandboxed.resultChars) {
        result = withTruncationMarker(sandboxed.resultJson, sandboxed.resultChars);
      } else {
        try {
          result = JSON.parse(sandboxed.resultJson);
        } catch {
          result = sandboxed.resultJson;
        }
      }
    }
    const error = sandboxed.success ? undefined : sandboxed.error ?? { message: 'The script failed' };
    // A script that failed hands nothing to a person: its staged calls are
    // reported as not run, and the model decides what to do next.
    const staged = broker.changeSet;
    const status: CodeExecutionStatus = error ? 'failed' : staged.length ? 'waiting_approval' : 'completed';
    const committed = await this.committed(row.id, input.scope);
    const durationMs = Date.now() - started;
    await this.executions.update(
      { id: row.id },
      {
        logs,
        result: result as any,
        error: error ?? null,
        status,
        changeSet: staged as any,
        callCount: broker.calls.length,
        cpuMs: sandboxed.cpuMs,
        durationMs,
      },
    );
    return {
      codeExecutionId: row.id,
      status,
      result,
      logs,
      ...(error ? { error } : {}),
      calls: broker.calls,
      staged,
      committed,
      grantsUsed: broker.grantsUsed,
      extractCost: broker.extractCost,
      extractTokens: broker.extractTokens,
      cpuMs: sandboxed.cpuMs,
      durationMs,
    };
  }

  /**
   * The writes and deletes this script made that succeeded, read from its
   * tool_executions rows: what already happened, whatever the script did
   * after.
   */
  async committed(codeExecutionId: string, scope: Tool[]): Promise<RunCodeOutcome['committed']> {
    const rows = await this.toolExecutions.find({
      where: { codeExecutionId, success: true },
      select: { id: true, toolId: true, parameters: true, createdAt: true },
      order: { createdAt: 'ASC' },
    });
    const byId = new Map(scope.map((t) => [t.id, t]));
    return rows
      .filter((r) => {
        const cls = byId.get(r.toolId)?.sideEffect;
        return cls === 'write' || cls === 'destructive';
      })
      .map((r) => ({ tool: byId.get(r.toolId)!.name, toolId: r.toolId, arguments: r.parameters }));
  }

  /** The script's change set and its approval, once the caller asked a person. */
  async attachApproval(codeExecutionId: string, approvalRequestId: string): Promise<void> {
    await this.executions.update({ id: codeExecutionId }, { approvalRequestId });
  }

  /**
   * Run an approved change set (decision 7): the entries in order, each a
   * normal call through the executor with the approval, recorded under the
   * script; stop at the first failure, report what ran and what did not, roll
   * nothing back.
   */
  async applyChangeSet(
    codeExecutionId: string,
    approvalId: string,
    scope: Tool[],
    context: CodeCallContext,
  ): Promise<ChangeSetEntry[]> {
    const row = await this.executions.findOne({ where: { id: codeExecutionId, organizationId: context.organizationId } });
    if (!row) return [];
    const byId = new Map(scope.map((t) => [t.id, t]));
    const entries: ChangeSetEntry[] = (row.changeSet ?? []).map((e) => ({ ...e }));
    let stopped = false;
    for (const entry of entries) {
      if (stopped) {
        entry.outcome = 'not_run';
        continue;
      }
      const tool = byId.get(entry.toolId);
      const result: ToolExecutionResult = tool
        ? await this.executor.executeTool(tool.id, entry.arguments, {
            userId: context.userId ?? (undefined as any),
            ...(context.principal ? { principal: context.principal } : {}),
            organizationId: context.organizationId,
            ...(context.gatewayId ? { gatewayId: context.gatewayId } : {}),
            ...(context.scopes ? { scopes: context.scopes } : {}),
            ...(context.runnerLabels ? { runnerLabels: context.runnerLabels } : {}),
            runId: context.runId ?? undefined,
            agentId: context.agentId ?? null,
            agentTeamId: context.agentTeamId ?? null,
            approvedGate: { approvalId },
            holdForApproval: 'caller',
            codeExecutionId,
          })
        : { success: false, error: `${entry.codeName} is no longer available here`, executionTime: 0, cached: false, rateLimited: false, retryCount: 0 };
      if (result.success) {
        entry.outcome = 'ran';
      } else {
        entry.outcome = 'failed';
        entry.error = result.approvalRequired ? `Still needs approval: ${result.approvalRequired.summary}` : (result.error ?? 'failed');
        stopped = true;
      }
    }
    await this.executions.update({ id: row.id }, { status: 'approved', changeSet: entries as any });
    return entries;
  }

  /** A rejected or expired change set: nothing in it ran. */
  async rejectChangeSet(codeExecutionId: string, organizationId: string): Promise<ChangeSetEntry[]> {
    const row = await this.executions.findOne({ where: { id: codeExecutionId, organizationId } });
    if (!row) return [];
    const entries = (row.changeSet ?? []).map((e) => ({ ...e, outcome: 'not_run' as const }));
    await this.executions.update({ id: row.id }, { status: 'rejected', changeSet: entries as any });
    return entries;
  }

  // ── Held change sets: callers that cannot wait (a gateway client, a workflow step) ──

  private approvalsService(): HeldChangeSetApprovals | null {
    try {
      return (this.moduleRef?.get(ApprovalsService, { strict: false }) as unknown as HeldChangeSetApprovals) ?? null;
    } catch {
      return null;
    }
  }

  onModuleInit(): void {
    this.approvalsService()?.on('approval.decided', (row: ApprovalRequest) => {
      if (!row || row.runId || row.payload?.kind !== 'change_set') return;
      this.decideHeld(row).catch((err: any) => this.logger.error(`Could not settle the change set of approval ${row.id}: ${err?.message ?? err}`));
    });
  }

  /**
   * Hold a script's change set for a caller that cannot pause (part D,
   * "Gateway or MCP client"): one approval request for the whole set, run
   * once a person approves it (decideHeld). The caller is told it is
   * waiting and comes back with the approval id (heldState).
   */
  async holdChangeSet(outcome: RunCodeOutcome, context: CodeCallContext): Promise<{ approvalId: string } | null> {
    const approvals = this.approvalsService();
    if (!approvals || !outcome.staged.length) return null;
    const n = outcome.staged.length;
    const call: HeldChangeSetCall = {
      userId: context.userId ?? null,
      principal: context.principal ?? null,
      gatewayId: context.gatewayId ?? null,
      scopes: context.scopes ?? null,
      runnerLabels: context.runnerLabels ?? null,
      agentTeamId: context.agentTeamId ?? null,
    };
    const row = await approvals.create({
      organizationId: context.organizationId,
      teamId: context.agentTeamId ?? null,
      runId: null,
      agentId: context.agentId ?? null,
      reason: `A script wants to make ${n} change${n === 1 ? '' : 's'}. Approve to make all of them, or reject to make none.`,
      payload: { kind: 'change_set', tool: 'run_code', codeExecutionId: outcome.codeExecutionId, changeSet: outcome.staged, _call: call },
      principal: context.principal ?? null,
    });
    await this.attachApproval(outcome.codeExecutionId, row.id);
    return { approvalId: row.id };
  }

  /**
   * A held change set, decided: approved, it runs once (the script row is
   * claimed first, so the event and a retry cannot both run it), in order,
   * through the executor with the approval and the caller's gateway, which
   * re-checks every tool; rejected or expired, none of it runs.
   */
  async decideHeld(row: Pick<ApprovalRequest, 'id' | 'organizationId' | 'status' | 'payload'>): Promise<void> {
    const codeExecutionId = row.payload?.codeExecutionId;
    if (typeof codeExecutionId !== 'string') return;
    if (row.status !== 'approved') {
      if (row.status === 'rejected' || row.status === 'expired') await this.rejectChangeSet(codeExecutionId, row.organizationId);
      return;
    }
    const claim = await this.executions.update(
      { id: codeExecutionId, organizationId: row.organizationId, status: 'waiting_approval', approvalRequestId: row.id },
      { status: 'running' },
    );
    if (!claim.affected) return;
    const execution = await this.executions.findOne({ where: { id: codeExecutionId, organizationId: row.organizationId } });
    const ids = [...new Set((execution?.changeSet ?? []).map((e) => e.toolId))];
    const scope = ids.length
      ? await this.toolExecutions.manager.getRepository(Tool).find({ where: { id: In(ids), organizationId: row.organizationId } })
      : [];
    const call = (row.payload?._call ?? {}) as Partial<HeldChangeSetCall>;
    await this.applyChangeSet(codeExecutionId, row.id, scope, {
      organizationId: row.organizationId,
      userId: call.userId ?? null,
      ...(call.principal ? { principal: call.principal } : {}),
      gatewayId: call.gatewayId ?? null,
      ...(call.scopes ? { scopes: call.scopes } : {}),
      ...(call.runnerLabels ? { runnerLabels: call.runnerLabels } : {}),
      agentId: execution?.agentId ?? null,
      agentTeamId: call.agentTeamId ?? null,
    });
  }

  /**
   * Where a held change set stands, for the caller that comes back with its
   * approval id. Only the gateway (or, with none, the organization surface)
   * the script ran on may ask; anything else is "not found".
   */
  async heldState(
    approvalId: string,
    organizationId: string,
    gatewayId: string | null,
  ): Promise<
    | { status: 'waiting'; codeExecutionId: string }
    | { status: 'decided'; decision: 'approved' | 'rejected' | 'expired'; entries: ChangeSetEntry[]; reason: string | null; codeExecutionId: string }
    | null
  > {
    const execution = await this.executions.findOne({ where: { approvalRequestId: approvalId, organizationId } });
    if (!execution || (execution.gatewayId ?? null) !== (gatewayId ?? null)) return null;
    const approval = await this.approvalsService()?.findInOrganization(approvalId, organizationId);
    if (!approval) return null;
    if (approval.status === 'pending' || (approval.status === 'approved' && execution.status !== 'approved')) {
      return { status: 'waiting', codeExecutionId: execution.id };
    }
    const decision = approval.status === 'approved' ? 'approved' : approval.status === 'expired' ? 'expired' : 'rejected';
    return { status: 'decided', decision, entries: execution.changeSet ?? [], reason: approval.decisionReason ?? null, codeExecutionId: execution.id };
  }

  /**
   * run_code for a caller that cannot pause (a gateway client, a workflow
   * step): the script runs as for an agent; staged changes are held in
   * Approvals as one request and the answer carries its approvalId. Called
   * again with only that approvalId, it answers with what happened to them.
   */
  async runUnattended(input: Omit<RunCodeInput, 'code' | 'timeoutMs'> & { params: Record<string, any> }): Promise<UnattendedRunAnswer> {
    const { params, context } = input;
    const approvalId = typeof params?.approvalId === 'string' ? params.approvalId.trim() : '';
    if (approvalId && (params.code === undefined || params.code === null || params.code === '')) {
      const state = await this.heldState(approvalId, context.organizationId, context.gatewayId ?? null).catch(() => null);
      if (!state) return { forModel: { error: 'There is no change set with that approvalId here.' }, isError: true };
      if (state.status === 'waiting') {
        return {
          forModel: { status: 'waiting_for_approval', approvalId, note: 'A person has not decided yet. None of the changes has run. Call again later.' },
          isError: false,
          approvalId,
          codeExecutionId: state.codeExecutionId,
        };
      }
      const n = state.entries.length;
      // The calls here are the change set's: how many there were, and what became of them.
      const count = (o: string) => state.entries.filter((e) => e.outcome === o).length;
      const before: CodeResultForModel = { status: 'completed', calls: { made: n, ran: count('ran'), failed: count('failed'), staged: n, refused: 0 } };
      const answer = changeSetOutcomeForModel(before, state.decision, state.entries, state.reason);
      return { forModel: answer, isError: state.decision === 'approved' && state.entries.some((e) => e.outcome === 'failed'), approvalId, codeExecutionId: state.codeExecutionId };
    }

    const outcome = await this.run({ ...input, code: params?.code, timeoutMs: params?.timeoutMs });
    const forModel: Record<string, unknown> = { ...codeResultForModel(outcome, input.limits.resultCapChars + input.limits.logCapChars + 8_192) };
    if (outcome.status !== 'waiting_approval') {
      return { forModel, isError: outcome.status === 'failed', codeExecutionId: outcome.codeExecutionId };
    }
    const held = await this.holdChangeSet(outcome, context);
    if (!held) {
      await this.rejectChangeSet(outcome.codeExecutionId, context.organizationId);
      return {
        forModel: { ...forModel, status: 'failed', note: 'The changes need a person to approve them, and nobody can be asked here. None of them ran.' },
        isError: true,
        codeExecutionId: outcome.codeExecutionId,
      };
    }
    const n = outcome.staged.length;
    return {
      forModel: {
        ...forModel,
        approvalId: held.approvalId,
        note: `${n} change${n === 1 ? '' : 's'} wait for a person in Approvals. None has run yet. Call run_code again with { "approvalId": "${held.approvalId}" } for the outcome once they decide.`,
      },
      isError: false,
      approvalId: held.approvalId,
      codeExecutionId: outcome.codeExecutionId,
    };
  }

  /** A gateway and what it serves (code-mode/code-exposure.ts), for surfaces outside the MCP handler. */
  async gatewayExposure(gatewayId: string, organizationId: string): Promise<{ exposure: GatewayExposure; gateway: Gateway | null }> {
    const gateway = await this.executions.manager
      .getRepository(Gateway)
      .findOne({ where: { id: gatewayId, organizationId }, relations: { authConfigs: true } })
      .catch(() => null);
    return { exposure: gateway ? effectiveExposure(gateway) : 'tools', gateway };
  }

  /** Exactly what a gateway serves (gateway-servable.ts), with what code names and signatures need. */
  gatewayScope(gatewayId: string): Promise<Tool[]> {
    return servableToolsOnGateway(this.executions.manager.getRepository(GatewayTool), gatewayId, { api: true, outputSchema: true, operation: true });
  }


  /**
   * run_code on a tool gateway in `code` or `both` exposure (part E): the
   * scope is exactly what the gateway serves (`scope`, the tools/list set),
   * every brokered call runs as the gateway with the caller and its
   * gatewayId, so the executor re-checks servability, security policy and
   * amount rules. The write policy is the gateway's
   * (`configuration.codeMode`); grants count per script, since a gateway
   * has no run. extract() is available only when the gateway names a
   * provider connection (decision 11).
   */
  async runOnGateway(input: {
    gateway: Pick<Gateway, 'id' | 'organizationId' | 'configuration' | 'visibility' | 'teamId' | 'ownerUserId' | 'isSystem'>;
    userId: string | null;
    scope: Tool[];
    params: Record<string, any>;
    signal?: AbortSignal;
    /** Who the calls run as: the gateway's scope with the caller (default), or a member running it as themselves (Skills). */
    principal?: ExecutionPrincipal;
  }): Promise<UnattendedRunAnswer> {
    const { gateway, userId } = input;
    const organization = await this.executions.manager
      .getRepository(Organization)
      .findOne({ where: { id: gateway.organizationId }, select: { id: true, settings: true } })
      .catch(() => null);
    const policy: CodeModeConfig | undefined = gateway.configuration?.codeMode;
    const principal = input.principal ?? gatewayPrincipal(gateway as Gateway, userId);
    const extractor = policy?.extractor?.providerId ? policy.extractor : null;
    const llm = extractor ? this.llmProviders() : null;
    return this.runUnattended({
      params: input.params,
      scope: input.scope,
      context: { organizationId: gateway.organizationId, userId, principal, gatewayId: gateway.id },
      policy,
      grantsLeft: grantsLeftFor(policy, {}),
      limits: codeModeLimits((organization?.settings as any)?.codeMode),
      // Outside clients: QuickJS in a worker of its own (decision 1 as taken).
      runtime: 'quickjs',
      ...(llm && extractor
        ? { extract: buildExtract({ chat: (providerId, request) => llm.chat(providerId as string, request as any, gateway.organizationId, principal), extractor }) }
        : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  /**
   * An agent's tools as a script sees them (a workflow Code step): its
   * chosen tools and the active tools of its APIs, with what code names
   * and signatures need. Every call is still checked by the executor
   * against the run's principal.
   */
  async agentScope(agent: Pick<Agent, 'organizationId' | 'toolIds' | 'agentConfig'>): Promise<Tool[]> {
    const apiIds = agentApiIds(agent);
    const where: any[] = [];
    if (agent.toolIds?.length) where.push({ id: In(agent.toolIds), organizationId: agent.organizationId });
    if (apiIds.length) where.push({ apiId: In(apiIds), organizationId: agent.organizationId, status: ToolStatus.ACTIVE });
    if (!where.length) return [];
    const rows = await this.executions.manager.getRepository(Tool).find({ where, relations: { api: true, outputSchema: true } });
    const seen = new Set<string>();
    return rows.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
  }

  /**
   * A workflow's Code step (part E): the script over the agent's tools, the
   * step's input as its `context`, run as the workflow run. A workflow
   * cannot pause, so changes that need a person are held in Approvals as
   * one request and run once approved; the step reports that it is waiting.
   */
  async runWorkflowStep(input: {
    agent: Pick<Agent, 'id' | 'organizationId' | 'toolIds' | 'agentConfig' | 'teamId'>;
    runId: string | null;
    userId: string | null;
    principal?: ExecutionPrincipal;
    code: string;
    timeoutMs?: number;
    scriptContext: unknown;
    runnerLabels?: Record<string, string>;
    maxCalls?: number;
    signal?: AbortSignal;
  }): Promise<UnattendedRunAnswer> {
    const { agent } = input;
    const organization = await this.executions.manager
      .getRepository(Organization)
      .findOne({ where: { id: agent.organizationId }, select: { id: true, settings: true } })
      .catch(() => null);
    const policy: CodeModeConfig | undefined = agent.agentConfig?.codeMode;
    const limits = codeModeLimits((organization?.settings as any)?.codeMode);
    const llm = this.llmProviders();
    return this.runUnattended({
      params: { code: input.code, ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}) },
      scope: await this.agentScope(agent),
      context: {
        organizationId: agent.organizationId,
        userId: input.userId,
        ...(input.principal ? { principal: input.principal } : {}),
        runId: input.runId,
        agentId: agent.id,
        agentTeamId: agent.teamId ?? null,
        ...(input.runnerLabels ? { runnerLabels: input.runnerLabels } : {}),
      },
      policy,
      grantsLeft: grantsLeftFor(policy, {}),
      limits: input.maxCalls !== undefined ? { ...limits, maxCalls: Math.min(limits.maxCalls, Math.max(0, input.maxCalls)) } : limits,
      scriptContext: input.scriptContext,
      ...(llm
        ? {
            extract: buildExtract({
              chat: (providerId, request) => llm.chat(providerId as string, request as any, agent.organizationId, input.principal),
              extractor: policy?.extractor ?? null,
              routing: (organization?.settings as any)?.defaultRouting ?? null,
            }),
          }
        : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  private llmProviders(): { chat: (...args: any[]) => Promise<any> } | null {
    try {
      return (this.moduleRef?.get(LlmProvidersService, { strict: false }) as any) ?? null;
    } catch {
      return null;
    }
  }

  /** A script and its call tree, for the run view. */
  async withCalls(id: string, organizationId: string): Promise<{ execution: CodeExecution; calls: Array<ToolExecution & { toolName: string | null }> } | null> {
    const execution = await this.executions.findOne({ where: { id, organizationId } });
    if (!execution) return null;
    const calls = await this.toolExecutions.find({
      where: { codeExecutionId: id, organizationId },
      select: { id: true, toolId: true, parameters: true, result: true, success: true, error: true, executionTime: true, createdAt: true },
      order: { createdAt: 'ASC' },
      take: 1000,
    });
    // The tools' names, for a call tree a person can read; a tool deleted since shows none.
    const ids = [...new Set(calls.map((c) => c.toolId))];
    const tools = ids.length
      ? await this.toolExecutions.manager.getRepository(Tool).find({ where: { id: In(ids), organizationId }, select: { id: true, name: true } })
      : [];
    const names = new Map(tools.map((t) => [t.id, t.name]));
    return { execution, calls: calls.map((c) => Object.assign(c, { toolName: names.get(c.toolId) ?? null })) };
  }

  /** The scripts of a run, newest last. */
  async forRun(runId: string, organizationId: string): Promise<CodeExecution[]> {
    return this.executions.find({ where: { runId, organizationId }, order: { createdAt: 'ASC' }, take: 500 });
  }
}

/**
 * Strip TypeScript types (Node's stripTypeScriptTypes: no transpile, no type
 * check), keeping every line where it was so an error's line number is the
 * script's. The body is wrapped in an async function first, because a
 * script uses top-level `await` and `return`.
 */
export function stripTypes(source: string): string {
  const open = 'async function __script__() {\n';
  const wrapped = `${open}${source}\n}`;
  const stripped = stripTypeScriptTypes(wrapped, { mode: 'strip' });
  return stripped.slice(open.length, stripped.lastIndexOf('\n}'));
}
