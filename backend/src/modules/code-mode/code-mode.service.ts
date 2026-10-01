import { Inject, Injectable, Logger, Optional, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { stripTypeScriptTypes } from 'module';

import { ChangeSetEntry, CodeExecution, CodeExecutionStatus } from '../../entities/code-execution.entity';
import { Tool } from '../../entities/tool.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import type { ExecutionPrincipal } from '../../common/authorization/execution-access.service';
import { withTruncationMarker } from '../agents/persist-cap';
import { NodeSandboxService } from '../tools/node-sandbox/node-sandbox.service';
import { ToolExecutorService } from '../tools/tool-executor.service';
import type { ToolExecutionResult } from '../tools/tool-execution.types';
import { ToolDiscoveryService } from '../tool-discovery/tool-discovery.service';
import { BrokeredCall, CodeBroker, ExtractFn } from './code-broker';
import { CodeModeLimits, scriptTimeoutMs } from './code-mode.settings';
import { CodeModeConfig } from './code-write-policy';

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

/**
 * Code mode's `run_code` (docs/design/code-mode.md, part C): one script,
 * run in the sandbox's `code` profile, its calls brokered (code-broker.ts),
 * its trace kept in `code_executions` with each brokered call an ordinary
 * `tool_executions` row pointing at it.
 */
@Injectable()
export class CodeModeService {
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

    const sandboxed = await this.sandbox.executeCode({
      code: body,
      namespaces: broker.namespaces(),
      organizationId: context.organizationId,
      timeoutMs: scriptTimeoutMs(input.timeoutMs, limits),
      memoryLimitMb: limits.memoryMb,
      logCapChars: limits.logCapChars,
      resultCapChars: limits.resultCapChars,
      onCall: (call) => broker.handle(call),
      signal: input.signal,
    });
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
