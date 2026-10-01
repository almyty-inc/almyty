/**
 * Autonomous agent runs over MCP 2026-07-28 (docs/design/mcp-2026-07-28.md,
 * "Agent runs as tasks and input_required").
 *
 * invoke_agent starts a run that may take minutes and may stop to ask a
 * person something (ask_user) or wait for an approval. Three ways to follow
 * it, by what the client can do:
 *
 *  - **Tasks extension** (the request declared `io.modelcontextprotocol/tasks`):
 *    invoke_agent answers with a task handle whose id is the run's id;
 *    `tasks/get` reports it, carries the question or the approval as an
 *    `elicitation/create` input request, `tasks/update` delivers the answer,
 *    `tasks/cancel` cancels it.
 *  - **Multi round-trip requests** (a 2026 client that declares elicitation
 *    but not tasks): invoke_agent waits for the run up to MCP_INVOKE_WAIT_MS.
 *    If it finishes, the result is returned; if it stops for a person, the
 *    call answers `input_required` with the question and a sealed
 *    `requestState`; the retry carries the answer, the run resumes, and the
 *    call waits again.
 *  - **Everyone else**: invoke_agent returns the run id, and the management
 *    tools `get_run` and `answer_run` follow it (owner decision 7).
 *
 * Run status to task status: pending, running and sleeping are `working`;
 * waiting_input and waiting_approval are `input_required` when the caller
 * can be asked (else `working` with a status message saying who decides
 * where); completed, failed and timeout are `completed` (a run that failed
 * is a tool result with isError, not a JSON-RPC error, which is all the
 * spec's `failed` may carry); cancelled is `cancelled`.
 *
 * A task is readable, answerable and cancellable only by the user who
 * started it through this surface, checked on every call; anyone else gets
 * the same "Task not found" as for an id that does not exist.
 */
import { Repository } from 'typeorm';

import { AgentRun, AgentRunStatus } from '../../../entities/agent-run.entity';
import { ApprovalRequest } from '../../../entities/approval-request.entity';
import { JsonRpcErrorCode } from '../types/mcp.types';
import {
  McpCallContext,
  McpPolymorphicResult,
  McpToolResult,
  declaresElicitation,
  mcpError,
} from '../core/mcp-protocol-core';
import { mcpProtocolSettings } from '../core/mcp-settings';
import { REQUEST_STATE_REFUSAL_MESSAGE, openRequestState, sealRequestState } from '../core/mcp-request-state';
import {
  ElicitInputRequest,
  applyApprovalAnswer,
  approvalIdFromKey,
  approvalInputKey,
  approvalInputRequest,
  parseElicitAnswer,
} from './mcp-approval-input';

/** Where invoke_agent records that a run is followed as a task, and by whom. */
export const MCP_TASK_METADATA_KEY = 'mcpTask';

/** The requestState kind of a run waiting for a person, retried on invoke_agent. */
const RUN_STATE_KIND = 'agent_run';

const QUESTION_KEY_PREFIX = 'question-';

const PEOPLE_WAIT_STATUSES: ReadonlySet<string> = new Set([AgentRunStatus.WAITING_INPUT, AgentRunStatus.WAITING_APPROVAL]);
const ENDED_STATUSES: ReadonlySet<string> = new Set([
  AgentRunStatus.COMPLETED,
  AgentRunStatus.FAILED,
  AgentRunStatus.TIMEOUT,
  AgentRunStatus.CANCELLED,
]);

export interface McpAgentRunsDeps {
  runs: Pick<Repository<AgentRun>, 'findOne'>;
  runtime: {
    sendInput(runId: string, organizationId: string, input: string): Promise<unknown>;
    cancelRun(runId: string, organizationId: string, agentId?: string, userId?: string): Promise<unknown>;
  };
  approvals: {
    listForRun(runId: string): Promise<ApprovalRequest[]>;
    canDecide(row: ApprovalRequest, caller: { id: string } | null | undefined): Promise<boolean>;
    approve(id: string, d: { decidedBy: string; decisionReason?: string }, caller: { id: string }, org: string): Promise<ApprovalRequest>;
    reject(id: string, d: { decidedBy: string; decisionReason?: string }, caller: { id: string }, org: string): Promise<ApprovalRequest>;
  };
  /** Days a finished run is kept in this organization, or null for no limit (retention policy). */
  runRetentionDays(organizationId: string): Promise<number | null>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** What a run waiting for a person asks this caller, and what to say when it cannot ask them. */
interface PendingInput {
  inputRequests: Record<string, ElicitInputRequest>;
  statusMessage?: string;
}

function iso(value: Date | string | undefined | null): string {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

/** The question an ask_user step put to the person: the latest waiting_input step's. */
export function pendingQuestion(run: Pick<AgentRun, 'steps'>): string {
  const steps = Array.isArray(run.steps) ? run.steps : [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const out = steps[i]?.output;
    if (out && typeof out === 'object' && out.status === 'waiting_input') {
      return typeof out.question === 'string' && out.question.trim() ? out.question : 'Please provide input';
    }
  }
  return 'Please provide input';
}

/** The ask_user form: one free-text answer. */
export function questionInputRequest(question: string): ElicitInputRequest {
  return {
    method: 'elicitation/create',
    params: {
      mode: 'form',
      message: question,
      requestedSchema: {
        type: 'object',
        properties: { answer: { type: 'string', title: 'Answer' } },
        required: ['answer'],
      },
    },
  };
}

/**
 * What invoke_agent would have answered for a finished run: the output as
 * text, and the run summary as structured content. A run that failed or ran
 * out of time is a tool error the model can read.
 */
export function runToolResult(run: AgentRun): McpToolResult {
  const output = run.output ?? null;
  const summary = {
    mode: 'autonomous',
    agentId: run.agentId,
    runId: run.id,
    status: run.status,
    output,
    error: run.error ?? null,
    totalCost: run.totalCost ?? null,
    totalTokens: run.totalTokens ?? null,
  };
  if (run.status === AgentRunStatus.FAILED || run.status === AgentRunStatus.TIMEOUT) {
    const why = run.status === AgentRunStatus.TIMEOUT ? 'ran out of time' : 'failed';
    return {
      content: [{ type: 'text', text: `The agent run ${why}${run.error ? `: ${run.error}` : '.'}` }],
      structuredContent: summary,
      isError: true,
    };
  }
  const text = output === null ? '' : typeof output === 'string' ? output : JSON.stringify(output, null, 2);
  return { content: [{ type: 'text', text }], structuredContent: summary, isError: false };
}

export class McpAgentRuns {
  constructor(private readonly deps: McpAgentRunsDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Metadata to start a run with when it is to be followed as a task by `userId`. */
  static taskMetadata(userId: string): Record<string, unknown> {
    return { [MCP_TASK_METADATA_KEY]: { startedBy: userId } };
  }

  private taskNotFound(): never {
    throw mcpError(JsonRpcErrorCode.INVALID_PARAMS, 'Failed to retrieve task: Task not found');
  }

  /** The run behind a task id, if the caller started it as a task here; otherwise "not found". */
  private async taskRun(taskId: string, organizationId: string, userId: string | null | undefined): Promise<AgentRun> {
    if (!userId || typeof taskId !== 'string' || !/^[0-9a-f-]{36}$/i.test(taskId)) this.taskNotFound();
    const run = await this.deps.runs.findOne({ where: { id: taskId, organizationId } });
    const startedBy = (run?.metadata as any)?.[MCP_TASK_METADATA_KEY]?.startedBy;
    if (!run || !startedBy || startedBy !== userId) this.taskNotFound();
    return run;
  }

  private async ttlMs(organizationId: string): Promise<number | null> {
    const days = await this.deps.runRetentionDays(organizationId).catch(() => null);
    return typeof days === 'number' && days > 0 ? days * 86_400_000 : null;
  }

  /** The Task fields every task answer carries. */
  private async taskFields(run: AgentRun): Promise<Record<string, unknown>> {
    return {
      taskId: run.id,
      createdAt: iso(run.createdAt),
      lastUpdatedAt: iso(run.updatedAt),
      ttlMs: await this.ttlMs(run.organizationId),
      pollIntervalMs: mcpProtocolSettings().taskPollIntervalMs,
    };
  }

  /** invoke_agent's answer for a run followed as a task (`resultType: "task"`). */
  async createTaskResult(run: AgentRun): Promise<McpPolymorphicResult> {
    return {
      resultType: 'task',
      ...(await this.taskFields(run)),
      status: 'working',
      statusMessage: 'The agent run has started.',
    };
  }

  /**
   * What a run waiting for a person asks this caller: its question (only
   * the user who started it is asked), or the approvals they could decide
   * in Approvals. Without elicitation nothing can be asked; the message
   * says where it is answered instead.
   */
  private async pendingInput(run: AgentRun, userId: string, ctx: McpCallContext): Promise<PendingInput> {
    const canAsk = declaresElicitation(ctx);
    if (run.status === AgentRunStatus.WAITING_INPUT) {
      if (!canAsk) {
        return {
          inputRequests: {},
          statusMessage: `The agent asks: ${pendingQuestion(run)} Answer with answer_run or in the almyty dashboard.`,
        };
      }
      return { inputRequests: { [`${QUESTION_KEY_PREFIX}${run.currentStep}`]: questionInputRequest(pendingQuestion(run)) } };
    }
    const pending = (await this.deps.approvals.listForRun(run.id)).filter((row) => row.status === 'pending');
    const inputRequests: Record<string, ElicitInputRequest> = {};
    if (canAsk) {
      for (const row of pending) {
        if (await this.deps.approvals.canDecide(row, { id: userId })) {
          inputRequests[approvalInputKey(row.id)] = approvalInputRequest(row);
        }
      }
    }
    if (Object.keys(inputRequests).length) return { inputRequests };
    return {
      inputRequests: {},
      statusMessage: 'Waiting for approval. A person who may approve it decides in Approvals in the almyty dashboard.',
    };
  }

  /** tasks/get. */
  async getTask(taskId: string, organizationId: string, userId: string | null | undefined, ctx: McpCallContext): Promise<Record<string, unknown>> {
    const run = await this.taskRun(taskId, organizationId, userId);
    const fields = await this.taskFields(run);
    if (run.status === AgentRunStatus.CANCELLED) {
      return { ...fields, status: 'cancelled', ...(run.error ? { statusMessage: run.error } : {}) };
    }
    if (ENDED_STATUSES.has(run.status)) {
      return { ...fields, status: 'completed', result: runToolResult(run) };
    }
    if (PEOPLE_WAIT_STATUSES.has(run.status)) {
      const pending = await this.pendingInput(run, userId as string, ctx);
      if (Object.keys(pending.inputRequests).length) {
        return { ...fields, status: 'input_required', inputRequests: pending.inputRequests };
      }
      return { ...fields, status: 'working', statusMessage: pending.statusMessage };
    }
    return {
      ...fields,
      status: 'working',
      statusMessage: run.status === AgentRunStatus.SLEEPING ? 'The agent is waiting before its next step.' : 'The agent is working.',
    };
  }

  /**
   * Apply `inputResponses` to a run: an answer to its current question, a
   * decision on an approval the caller may decide. Keys that are not
   * outstanding are ignored (Tasks, "Task Update Requests"). Reports whether
   * anything was applied, and whether the person closed a form without
   * answering ("cancel") -- then a waiting call stops asking.
   */
  private async applyInputResponses(
    run: AgentRun,
    userId: string,
    inputResponses: Record<string, unknown>,
  ): Promise<{ applied: boolean; dismissed: boolean }> {
    let applied = false;
    let dismissed = false;
    for (const [key, value] of Object.entries(inputResponses)) {
      const answer = parseElicitAnswer(value);
      if (!answer) {
        throw mcpError(JsonRpcErrorCode.INVALID_PARAMS, `inputResponses["${key.slice(0, 64)}"] is not an elicitation result`);
      }
      if (key.startsWith(QUESTION_KEY_PREFIX)) {
        const step = Number(key.slice(QUESTION_KEY_PREFIX.length));
        if (run.status !== AgentRunStatus.WAITING_INPUT || step !== run.currentStep) continue;
        if (answer.action === 'cancel') {
          dismissed = true;
          continue;
        }
        const text = answer.action === 'decline'
          ? 'The person declined to answer.'
          : typeof answer.content?.answer === 'string'
            ? answer.content.answer
            : null;
        if (text === null) {
          throw mcpError(JsonRpcErrorCode.INVALID_PARAMS, `inputResponses["${key}"] needs content.answer`);
        }
        await this.deps.runtime.sendInput(run.id, run.organizationId, text);
        applied = true;
        continue;
      }
      const approvalId = approvalIdFromKey(key);
      if (!approvalId) continue;
      const row = (await this.deps.approvals.listForRun(run.id)).find((r) => r.id === approvalId);
      if (!row || row.status !== 'pending') continue;
      const outcome = await applyApprovalAnswer(this.deps.approvals, row, answer, { id: userId });
      if (outcome === 'incomplete') {
        throw mcpError(JsonRpcErrorCode.INVALID_PARAMS, `inputResponses["${key}"] needs content.decision (approve or reject)`);
      }
      if (outcome === 'left') dismissed = true;
      if (outcome === 'approved' || outcome === 'rejected') applied = true;
    }
    return { applied, dismissed };
  }

  /** tasks/update: acknowledged once the answers are handed to the run. */
  async updateTask(
    taskId: string,
    inputResponses: Record<string, unknown>,
    organizationId: string,
    userId: string | null | undefined,
  ): Promise<Record<string, unknown>> {
    const run = await this.taskRun(taskId, organizationId, userId);
    await this.applyInputResponses(run, userId as string, inputResponses);
    return {};
  }

  /** tasks/cancel: acknowledged whatever state the run is in, including one already finished. */
  async cancelTask(taskId: string, organizationId: string, userId: string | null | undefined): Promise<Record<string, unknown>> {
    const run = await this.taskRun(taskId, organizationId, userId);
    if (!ENDED_STATUSES.has(run.status)) {
      await this.deps.runtime.cancelRun(run.id, organizationId, undefined, userId as string).catch(() => undefined);
    }
    return {};
  }

  /**
   * invoke_agent for a 2026 client without tasks that declared elicitation:
   * wait for the run. Finished: its result. Waiting for this caller:
   * `input_required`. Still going at the deadline (including waiting for
   * someone else): null, and the caller answers with the run id as before.
   */
  async waitForRun(
    runId: string,
    organizationId: string,
    userId: string,
    ctx: McpCallContext,
    request: { method: string; params: any },
  ): Promise<McpToolResult | McpPolymorphicResult | null> {
    const budget = mcpProtocolSettings().invokeWaitMs;
    if (budget <= 0) return null;
    const deadline = this.now() + budget;
    const step = Math.min(500, budget);
    for (;;) {
      const run = await this.deps.runs.findOne({ where: { id: runId, organizationId } });
      if (!run) return null;
      if (ENDED_STATUSES.has(run.status)) return runToolResult(run);
      if (PEOPLE_WAIT_STATUSES.has(run.status)) {
        const pending = await this.pendingInput(run, userId, ctx);
        // Nothing to ask this caller: the run is waiting for someone else,
        // or an answer just given has not resumed it yet (the approval event
        // resumes it a moment later). Keep waiting until the deadline.
        if (Object.keys(pending.inputRequests).length) {
          return {
            resultType: 'input_required',
            inputRequests: pending.inputRequests,
            requestState: sealRequestState(
              { kind: RUN_STATE_KIND, data: { runId: run.id } },
              { principal: userId, method: request.method, params: request.params },
            ),
          };
        }
      }
      if (this.now() >= deadline) return null;
      await this.sleep(step);
    }
  }

  /**
   * The retry of an invoke_agent that answered `input_required`: check its
   * sealed state, hand the answers to the run, and wait again. Returns the
   * run id it resumed, so the caller can answer with it if the wait ends
   * without a result.
   */
  async resumeFromRetry(
    params: any,
    organizationId: string,
    userId: string | null | undefined,
    ctx: McpCallContext,
    method: string,
  ): Promise<{ runId: string; result: McpToolResult | McpPolymorphicResult | null }> {
    const opened = openRequestState(params?.requestState, { principal: userId ?? null, method, params });
    if ('refusal' in opened) {
      throw mcpError(JsonRpcErrorCode.INVALID_PARAMS, `Invalid requestState: ${REQUEST_STATE_REFUSAL_MESSAGE[opened.refusal]}`);
    }
    if (opened.payload.kind !== RUN_STATE_KIND || typeof opened.payload.data.runId !== 'string') {
      throw mcpError(JsonRpcErrorCode.INVALID_PARAMS, 'Invalid requestState: not for this request');
    }
    const runId = opened.payload.data.runId;
    const run = await this.deps.runs.findOne({ where: { id: runId, organizationId } });
    if (!run) throw mcpError(JsonRpcErrorCode.INVALID_PARAMS, 'Invalid requestState: the run no longer exists');
    const responses = params?.inputResponses;
    if (responses !== undefined && (responses === null || typeof responses !== 'object' || Array.isArray(responses))) {
      throw mcpError(JsonRpcErrorCode.INVALID_PARAMS, 'inputResponses must be an object');
    }
    const applied = responses ? await this.applyInputResponses(run, userId as string, responses) : null;
    // The person closed the form: stop asking in this call. The run keeps
    // waiting, and the caller answers with its id (get_run, answer_run).
    // Asking again would loop with a client that cannot show forms, such as
    // one running headless, which answers every form with "cancel".
    if (applied?.dismissed && !applied.applied) return { runId, result: null };
    return { runId, result: await this.waitForRun(runId, organizationId, userId as string, ctx, { method, params }) };
  }

  /** get_run (management tool, for clients without tasks): where a run stands and what it waits for. */
  async describeRun(run: AgentRun, userId: string): Promise<Record<string, unknown>> {
    const base: Record<string, unknown> = {
      runId: run.id,
      agentId: run.agentId,
      status: run.status,
      steps: Array.isArray(run.steps) ? run.steps.length : 0,
      createdAt: iso(run.createdAt),
      updatedAt: iso(run.updatedAt),
      totalCost: run.totalCost ?? null,
      totalTokens: run.totalTokens ?? null,
    };
    if (ENDED_STATUSES.has(run.status)) {
      return { ...base, output: run.output ?? null, error: run.error ?? null };
    }
    if (run.status === AgentRunStatus.WAITING_INPUT) {
      return { ...base, waitingFor: { kind: 'answer', question: pendingQuestion(run), howToAnswer: 'Call answer_run with runId and answer.' } };
    }
    if (run.status === AgentRunStatus.WAITING_APPROVAL) {
      const pending = (await this.deps.approvals.listForRun(run.id)).filter((row) => row.status === 'pending');
      const approvals = [];
      for (const row of pending) {
        approvals.push({ approvalId: row.id, reason: row.reason, youMayDecide: await this.deps.approvals.canDecide(row, { id: userId }) });
      }
      return { ...base, waitingFor: { kind: 'approval', approvals, howToAnswer: 'An approver calls decide_approval, or decides in Approvals.' } };
    }
    return base;
  }
}
