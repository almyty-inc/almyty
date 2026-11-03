import type { AgentRunEvent } from '../../entities/agent-run-event.entity';
import type { RunRuntimeEvent } from './agent-runtime-events.helper';
import { runLogEventOf } from './run-stream-position';

/** What a run stream reads from: AgentRuntimeService. */
export interface RunStreamSource {
  subscribeRunEvents(
    runId: string,
    handler: (event: RunRuntimeEvent, id?: string) => void,
    signal?: AbortSignal,
  ): Promise<void>;
  subscribeRunLog(
    runId: string,
    afterSeq: number,
    onLog: (event: AgentRunEvent) => void,
    onEvent: (event: RunRuntimeEvent, id?: string) => void,
    signal?: AbortSignal,
    timeoutMs?: number,
    eventsAfter?: string,
  ): Promise<void>;
}

/** The part of an express Response a run stream writes to. */
interface StreamResponse {
  write(chunk: string): unknown;
  readonly writableEnded?: boolean;
}

/** How long a resumable run stream stays open before it says `stream.timeout`. */
const RUN_STREAM_TIMEOUT_MS = 300_000;

/**
 * Write a run's events to an open SSE response until the run ends, the
 * caller goes away (`signal`) or the stream reaches its time limit. The
 * caller has checked the run is the caller's to see, set the headers and
 * writes whatever closes the stream.
 *
 * `afterSeq` null: the live stream as it always was, the runtime events
 * only. A seq: the run's log after it, each event a `run.log` frame whose
 * SSE id is its seq, then live; each runtime event carries `pos`, its place
 * on `run:<id>:events`, and `live` (a `pos` the caller had, or `0`) makes
 * them start after that one instead of from now.
 */
export async function writeRunStream(
  runtime: RunStreamSource,
  runId: string,
  res: StreamResponse,
  signal: AbortSignal,
  afterSeq: number | null,
  live: string | null = null,
): Promise<void> {
  if (afterSeq === null) {
    await runtime.subscribeRunEvents(
      runId,
      (event) => {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      },
      signal,
    );
    return;
  }

  // Proxies drop idle connections; a comment frame keeps it open.
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': keep-alive\n\n');
  }, 25_000);
  heartbeat.unref?.();
  try {
    const onLog = (event: AgentRunEvent) => {
      res.write(`id: ${event.seq}\nevent: run.log\ndata: ${JSON.stringify(runLogEventOf(event))}\n\n`);
    };
    // Runtime events have no seq, so no SSE id: `pos` is where a client
    // that renders them picks up (`?live=`).
    const onEvent = (event: RunRuntimeEvent, id?: string) => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(id ? { ...event, pos: id } : event)}\n\n`);
    };
    if (live === null) {
      await runtime.subscribeRunLog(runId, afterSeq, onLog, onEvent, signal);
    } else {
      await runtime.subscribeRunLog(runId, afterSeq, onLog, onEvent, signal, RUN_STREAM_TIMEOUT_MS, live);
    }
  } finally {
    clearInterval(heartbeat);
  }
}
