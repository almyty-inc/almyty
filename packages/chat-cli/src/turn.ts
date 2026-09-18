/**
 * One turn of a conversation, driven the same way in both modes.
 *
 * The REPL and the non-interactive path used to be different code, and
 * the non-interactive path did not exist. Both now call `runTurn`,
 * which owns the choice between a streamed autonomous run and a
 * streamed workflow pipeline, the cancellation handshake, and the
 * cost tally. It takes the gateway as an interface so it can be tested
 * against a fake without a network or a terminal.
 */

import type { AgentRun, RunLimits, StreamEvent } from '@almyty/client';

import {
  type Activity,
  type StreamState,
  type Usage,
  drain,
  finalText,
  initialStreamState,
  reduceStreamEvent,
  routingFromSteps,
} from './stream.js';

/** The part of GatewayClient a turn needs. */
export interface TurnTarget {
  startRun(input: any, options?: RunLimits & { conversationId?: string }): Promise<AgentRun>;
  streamRun(runId: string, handler: (event: StreamEvent) => void, signal?: AbortSignal): Promise<AgentRun>;
  streamInvoke(input: Record<string, any>, handler: (event: StreamEvent) => void, signal?: AbortSignal): Promise<void>;
  invoke(input: Record<string, any>): Promise<any>;
  sendRunInput(runId: string, input: string): Promise<void>;
  cancelRun(runId: string): Promise<void>;
}

export interface TurnHooks {
  /** The assistant text so far, on every change. */
  partial?(text: string): void;
  /** A transcript line: a tool call, a node, a warning. */
  activity?(activity: Activity): void;
  /** What the agent is doing, for a spinner. */
  label?(label: string): void;
}

export type TurnStatus = 'completed' | 'failed' | 'cancelled' | 'waiting_input';

export interface TurnResult {
  status: TurnStatus;
  text: string;
  usage: Usage;
  error?: string;
  runId?: string;
  conversationId?: string;
  /** Set when the agent asked a question and is holding the run open. */
  pendingRunId?: string;
}

export interface TurnOptions {
  mode?: string;
  conversationId?: string;
  /** A run already waiting on input: this message answers it. */
  pendingRunId?: string;
  limits?: RunLimits;
  signal?: AbortSignal;
  hooks?: TurnHooks;
}

function isAborted(err: unknown, signal?: AbortSignal): boolean {
  const e = err as { name?: string; code?: string } | null;
  return !!signal?.aborted || (!!e && (e.name === 'AbortError' || e.code === 'ABORT_ERR'));
}

/** True when the pipeline stream endpoint is not there to be used. */
function streamUnavailable(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  if (status === 404 || status === 405) return true;
  return /Unknown agent action|SSE 404|SSE 405/.test((err as Error)?.message ?? '');
}

/** Wire the reducer's output into the hooks, once per event. */
function pump(hooks: TurnHooks | undefined, state: StreamState, event: StreamEvent): StreamState {
  const before = state.partial;
  const beforeLabel = state.label;
  let next = reduceStreamEvent(state, event);
  const drained = drain(next);
  next = drained.state;
  for (const activity of drained.activities) hooks?.activity?.(activity);
  if (next.partial !== before) hooks?.partial?.(next.partial);
  if (next.label !== beforeLabel) hooks?.label?.(next.label);
  return next;
}

/** Fill in attribution and totals the stream did not carry. */
function settleUsage(usage: Usage, run: AgentRun | undefined): Usage {
  const settled: Usage = { ...usage };
  if (!settled.model && run) {
    const routing = routingFromSteps(run.steps);
    if (routing) {
      settled.model = routing.model ?? settled.model;
      settled.rationale = routing.rationale ?? settled.rationale;
      settled.attempt = routing.attempt ?? settled.attempt;
    }
  }
  // The persisted totals are authoritative when the stream missed
  // events (a reconnect, or a fallback to polling).
  if (run && typeof run.totalCost === 'number' && run.totalCost > settled.cost) settled.cost = run.totalCost;
  if (run && typeof run.totalTokens === 'number' && run.totalTokens > settled.tokens) settled.tokens = run.totalTokens;
  return settled;
}

export async function runTurn(
  target: TurnTarget,
  message: string,
  options: TurnOptions = {},
): Promise<TurnResult> {
  const { hooks, signal } = options;
  let state = initialStreamState();
  hooks?.label?.(state.label);

  if (options.mode === 'autonomous') {
    let runId: string;
    let conversationId = options.conversationId;

    if (options.pendingRunId) {
      await target.sendRunInput(options.pendingRunId, message);
      runId = options.pendingRunId;
    } else {
      const run = await target.startRun(message, { ...options.limits, conversationId });
      runId = run.id;
      conversationId = run.conversationId ?? conversationId;
    }

    let final: AgentRun | undefined;
    try {
      final = await target.streamRun(runId, (event) => { state = pump(hooks, state, event); }, signal);
    } catch (err) {
      if (!isAborted(err, signal)) throw err;
      // Stop the run where it is running, not just where it is watched.
      // Killing the client alone leaves the run spending money with
      // nobody reading the answer.
      await target.cancelRun(runId).catch(() => {});
      return {
        status: 'cancelled',
        text: state.partial.trim(),
        usage: settleUsage(state.usage, undefined),
        runId,
        conversationId,
      };
    }

    if (state.cancelled) {
      return { status: 'cancelled', text: state.partial.trim(), usage: settleUsage(state.usage, final), runId, conversationId };
    }

    const usage = settleUsage(state.usage, final);
    const text = finalText(state, final?.output);

    if (final?.status === 'waiting_input') {
      return { status: 'waiting_input', text, usage, runId, conversationId, pendingRunId: runId };
    }
    if (state.failed || final?.status === 'failed' || final?.status === 'timeout') {
      return { status: 'failed', text, usage, error: state.failed ?? final?.error ?? 'The run failed', runId, conversationId };
    }
    return { status: 'completed', text, usage, runId, conversationId };
  }

  // Workflow agents: a pipeline, streamed so its nodes are visible.
  try {
    await target.streamInvoke({ message }, (event) => { state = pump(hooks, state, event); }, signal);
  } catch (err) {
    if (isAborted(err, signal)) {
      return { status: 'cancelled', text: state.partial.trim(), usage: state.usage, conversationId: options.conversationId };
    }
    if (!streamUnavailable(err)) throw err;
    // A deployment without the pipeline stream still answers the
    // blocking call; the run is just invisible while it happens.
    const result = await target.invoke({ message });
    const output = result?.output ?? result?.data?.output ?? result;
    return {
      status: result?.status && result.status !== 'completed' ? 'failed' : 'completed',
      text: finalText(state, output),
      usage: state.usage,
      error: result?.error,
      conversationId: options.conversationId,
    };
  }

  if (state.failed) {
    return { status: 'failed', text: finalText(state), usage: state.usage, error: state.failed, conversationId: options.conversationId };
  }
  return { status: 'completed', text: finalText(state), usage: state.usage, conversationId: options.conversationId };
}
