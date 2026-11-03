/**
 * `run --watch`: follow an autonomous run from its event log.
 *
 * It used to poll the run every 1.5 s and print the steps the row had
 * grown. It now reads the run's stream (AlmytyClient.followRun), which
 * sends the run's log event by event and picks up after the last one it
 * had when the connection drops, so a step is printed once, as its commit
 * lands, whatever the network does. A run that is gone (404, 410) or not
 * yours to see ends the watch at once; a stream that keeps failing
 * otherwise falls back to polling, as before.
 */

import { isPermanentStreamError, type AgentRun, type AlmytyClient, type RunLogEvent } from '@almyty/client';

export interface WatchOptions {
  /** Give up after this long, as `--timeout` says. */
  timeoutMs: number;
  /** Each step once, in order, with its index. */
  onStep: (step: unknown, index: number) => void;
  /** Waits before each retry of the stream, in ms (the client's own by default). */
  retryDelaysMs?: number[];
}

/** A run's steps with one more logged event applied: the fold the backend checks its rows against, for steps. */
export function applyLogToSteps(steps: unknown[], event: RunLogEvent): unknown[] {
  const p = event.payload ?? {};
  switch (event.type) {
    case 'run_started':
      return Array.isArray(p.steps) ? [...p.steps] : [];
    case 'model_call':
    case 'step_recorded':
    case 'tool_call':
    case 'step_replaced': {
      if (typeof p.index !== 'number') return steps;
      const next = [...steps];
      next[p.index] = p.step;
      return next;
    }
    case 'tool_result': {
      if (typeof p.index !== 'number') return steps;
      const next = [...steps];
      next[p.index] = { ...(next[p.index] as object), ...(p.result ?? {}) };
      return next;
    }
    case 'steps_reset':
      return Array.isArray(p.steps) ? [...p.steps] : [];
    default:
      return steps;
  }
}

/** Watch a run until it ends or waits on a person; resolves with the run as it stood then. */
export async function watchRun(client: AlmytyClient, agentId: string, runId: string, options: WatchOptions): Promise<AgentRun> {
  let steps: unknown[] = [];
  let printed = 0;
  // A step goes out once its commit lands, as the row would have had it.
  const flush = (all: unknown[]) => {
    for (let i = printed; i < all.length; i++) options.onStep(all[i], i);
    printed = Math.max(printed, all.length);
  };

  const deadline = Date.now() + options.timeoutMs;
  const timeUp = new AbortController();
  const timer = setTimeout(() => timeUp.abort(), options.timeoutMs);
  timer.unref?.();
  const tooLong = () => new Error(`Run ${runId} did not finish within ${Math.round(options.timeoutMs / 1000)}s`);

  let final: AgentRun;
  try {
    final = await client.followRun(agentId, runId, () => undefined, timeUp.signal, {
      onLog: (event) => {
        steps = applyLogToSteps(steps, event);
        if (event.type === 'step_committed') flush(steps);
      },
      stopOnWaitingInput: true,
      ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
    });
  } catch (err) {
    if (timeUp.signal.aborted) throw tooLong();
    if (isPermanentStreamError(err)) throw err;
    // The stream would not stay up: watch the row instead, for what is left of the time.
    final = await client.pollRun(agentId, runId, {
      timeoutMs: Math.max(0, deadline - Date.now()),
      onStep: (run) => flush((run.steps ?? []) as unknown[]),
    });
  } finally {
    clearTimeout(timer);
  }
  // Whatever the stream did not carry (a server without the run log).
  flush((final.steps ?? []) as unknown[]);
  return final;
}
