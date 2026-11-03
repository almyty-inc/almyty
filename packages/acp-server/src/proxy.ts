/**
 * HTTP proxy client to the almyty backend REST API.
 *
 * Provides typed methods for agent discovery, invocation, streaming,
 * and autonomous run management. All stdout is reserved for the ACP
 * protocol; diagnostics go to stderr.
 */

import { createParser, type EventSourceMessage } from 'eventsource-parser';

/** Default timeouts (ms). */
const DISCOVERY_TIMEOUT_MS = 15_000;
const INVOKE_TIMEOUT_MS = 120_000;

/** Minimal agent shape returned by the backend. */
export interface AgentInfo {
  id: string;
  name: string;
  slug?: string;
  description?: string;
  mode: 'workflow' | 'autonomous';
  status?: string;
  pipeline?: { nodes?: PipelineNode[] };
}

export interface PipelineNode {
  id: string;
  type: string;
  label?: string;
  config?: Record<string, unknown>;
}

/** Autonomous run state from the backend. */
export interface AgentRun {
  id: string;
  agentId: string;
  status: 'pending' | 'running' | 'waiting_input' | 'completed' | 'failed' | 'cancelled';
  conversationId?: string;
  output?: unknown;
  error?: string;
}

/** A single SSE event emitted by the streaming endpoints. */
export interface StreamEvent {
  event: string;
  data: Record<string, unknown>;
}

/** Where to pick a run's stream up, and how hard to try. */
export interface RunStreamResume {
  /** Resume after this logged event. Default 0: the run's whole log. */
  afterSeq?: number;
  /** Resume after this live event's place (`pos`). Default `0`: every one from the run's start. */
  livePos?: string;
  /** Waits before each retry after a failed connection, in ms; one entry per retry. */
  retryDelaysMs?: number[];
}

/** Waits before each retry of a run stream that failed, in ms. */
export const RUN_STREAM_RETRY_DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000];

/** Answers a retry would not change: a bad position, not signed in, not allowed, gone. */
const PERMANENT_STATUSES = [400, 401, 403, 404, 410];
const RUN_FINISHED = ['completed', 'failed', 'cancelled', 'timeout'];
const RUN_ENDED = ['run.completed', 'run.failed', 'run.cancelled'];

/** Whether a stream error is one a retry would not change. */
export function isPermanentStatus(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' && PERMANENT_STATUSES.includes(status);
}

/** Order two places on a run's event stream (`0`, or `<ms>-<n>`). */
function comparePos(a: string, b: string): number {
  const parts = (pos: string) => {
    const m = /^(\d+)-(\d+)$/.exec(pos);
    return m ? [Number(m[1]), Number(m[2])] : [0, 0];
  };
  const [am, an] = parts(a);
  const [bm, bn] = parts(b);
  return am !== bm ? am - bm : an - bn;
}

/** Wait, unless the caller gives up first. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => Object.assign(new Error('Aborted'), { name: 'AbortError' });
    if (signal?.aborted) return reject(aborted());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(aborted());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class AlmytyProxy {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  // ── Agent discovery ────────────────────────────────────────────

  async listAgents(): Promise<AgentInfo[]> {
    const data: any = await this.get('/agents', DISCOVERY_TIMEOUT_MS);
    // Backend returns { success, data: [...], pagination } or { agents: [...] }
    const list = Array.isArray(data?.data) ? data.data : (data?.agents || (Array.isArray(data) ? data : []));
    return list;
  }

  async getAgent(id: string): Promise<AgentInfo> {
    const data: any = await this.get(`/agents/${encodeURIComponent(id)}`, DISCOVERY_TIMEOUT_MS);
    return data?.data || data;
  }

  // ── Workflow invocation ────────────────────────────────────────

  async invokeAgent(id: string, input: Record<string, unknown>): Promise<unknown> {
    return this.post(`/agents/${encodeURIComponent(id)}/invoke`, input, INVOKE_TIMEOUT_MS);
  }

  /**
   * Stream a workflow agent execution via SSE. Yields StreamEvent objects
   * as they arrive. The caller is responsible for consuming the async
   * iterator; aborting the signal will terminate the stream.
   */
  async *streamAgent(
    id: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    yield* this.ssePost(
      `/agents/${encodeURIComponent(id)}/stream`,
      input,
      signal,
    );
  }

  // ── Autonomous run management ──────────────────────────────────

  async startRun(id: string, input: Record<string, unknown>, conversationId?: string): Promise<AgentRun> {
    const body: Record<string, unknown> = { input };
    if (conversationId) body.conversationId = conversationId;
    const data: any = await this.post(`/agents/${encodeURIComponent(id)}/runs`, body, INVOKE_TIMEOUT_MS);
    return data?.data || data;
  }

  async getRun(agentId: string, runId: string): Promise<AgentRun> {
    const data: any = await this.get(
      `/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`,
      DISCOVERY_TIMEOUT_MS,
    );
    return data?.data || data;
  }

  async sendRunInput(agentId: string, runId: string, input: Record<string, unknown>): Promise<AgentRun> {
    return this.post(
      `/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/input`,
      input,
      INVOKE_TIMEOUT_MS,
    );
  }

  async cancelRun(agentId: string, runId: string): Promise<void> {
    await this.post(
      `/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/cancel`,
      {},
      DISCOVERY_TIMEOUT_MS,
    );
  }

  /**
   * Stream an autonomous run via SSE, each event once and in order, until
   * the run ends; then a final `done`.
   *
   * A dropped connection, or the server ending one at its time limit, is
   * picked up where it left off: every connection names the seq of the
   * last logged event (`?after=`) and the place of the last live event
   * (`?live=`), and the server sends what came after both. The log itself
   * is how this keeps its place and is not yielded. A network error or a
   * 5xx is retried with backoff; an answer a retry would not change (400,
   * 401, 403, 404, 410: the run is gone, or not this token's) is thrown,
   * with its `status`.
   */
  async *streamRun(
    agentId: string,
    runId: string,
    signal?: AbortSignal,
    options: RunStreamResume = {},
  ): AsyncGenerator<StreamEvent> {
    const path = `/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/stream`;
    const delays = options.retryDelaysMs ?? RUN_STREAM_RETRY_DELAYS_MS;
    let afterSeq = Math.max(0, Math.floor(options.afterSeq ?? 0));
    let livePos = options.livePos ?? '0';
    // A server that sends neither a seq nor a place cannot resume: it
    // replays its live events on every connection, so once anything has
    // been yielded it is not connected to again.
    let resumable = false;
    let delivered = false;
    let ended = false;
    let failures = 0;

    for (;;) {
      let gap = false;
      let progressed = false;
      let failure: unknown = null;
      const connection = new AbortController();
      const linked = signal ? AbortSignal.any([signal, connection.signal]) : connection.signal;
      try {
        for await (const event of this.sseGet(`${path}?after=${afterSeq}&live=${encodeURIComponent(livePos)}`, linked)) {
          if (event.event === 'run.log') {
            const seq = event.data.seq;
            if (typeof seq !== 'number') continue;
            resumable = true;
            if (seq <= afterSeq) continue;
            if (seq !== afterSeq + 1) {
              gap = true;
              break;
            }
            afterSeq = seq;
            progressed = true;
            const payload = event.data.payload as { status?: string } | undefined;
            if (event.data.type === 'step_committed' && RUN_FINISHED.includes(String(payload?.status))) ended = true;
            continue;
          }
          const pos = typeof event.data.pos === 'string' ? event.data.pos : undefined;
          if (pos) {
            resumable = true;
            if (comparePos(pos, livePos) <= 0) continue;
            livePos = pos;
          }
          // The server closing this connection, not the run ending.
          if (event.event === 'done' || event.event === 'stream.timeout') continue;
          progressed = true;
          delivered = true;
          yield event;
          if (RUN_ENDED.includes(event.event)) {
            ended = true;
            if (!resumable) break;
          }
        }
      } catch (err) {
        failure = err;
      } finally {
        connection.abort();
      }

      if (signal?.aborted) throw failure ?? Object.assign(new Error('Aborted'), { name: 'AbortError' });
      if (ended && !gap) break;
      if (progressed) failures = 0;
      if (gap) continue;
      if (failure) {
        if (isPermanentStatus(failure)) throw failure;
        if (delivered && !resumable) throw failure;
      } else if (delivered && !resumable) {
        break;
      } else if (progressed) {
        continue;
      }
      if (failures >= delays.length) {
        if (failure) throw failure;
        break;
      }
      await sleep(delays[failures++], signal);
    }
    yield { event: 'done', data: {} };
  }

  // ── Internal HTTP helpers ──────────────────────────────────────

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.token}`,
    };
  }

  private async get<T>(path: string, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: this.headers(),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`GET ${path} failed (${resp.status}): ${text}`);
      }
      return (await resp.json()) as T;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`GET ${path} timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private async post<T>(path: string, body: object, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`POST ${path} failed (${resp.status}): ${text}`);
      }
      return (await resp.json()) as T;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`POST ${path} timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Consume an SSE stream from a POST endpoint. Uses eventsource-parser
   * to handle the text/event-stream format.
   */
  private async *ssePost(
    path: string,
    body: object,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const controller = new AbortController();
    const combinedSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;

    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        ...this.headers(),
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: combinedSignal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`SSE POST ${path} failed (${resp.status}): ${text}`);
    }

    yield* this.consumeSse(resp);
  }

  /**
   * Consume an SSE stream from a GET endpoint.
   */
  private async *sseGet(
    path: string,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const controller = new AbortController();
    const combinedSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;

    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: {
        ...this.headers(),
        Accept: 'text/event-stream',
      },
      signal: combinedSignal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      // The status rides on the error, so a caller can tell a run that is
      // gone (404) from a network that is down.
      throw Object.assign(new Error(`SSE GET ${path} failed (${resp.status}): ${text}`), { status: resp.status });
    }

    yield* this.consumeSse(resp);
  }

  /**
   * Parse an SSE response body into StreamEvent objects.
   */
  private async *consumeSse(resp: Response): AsyncGenerator<StreamEvent> {
    const body = resp.body;
    if (!body) return;

    // Buffer for events parsed by eventsource-parser
    const events: StreamEvent[] = [];
    let done = false;

    const parser = createParser({
      onEvent(event: EventSourceMessage) {
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(event.data);
        } catch {
          data = { raw: event.data };
        }
        events.push({ event: event.event || 'message', data });
      },
    });

    const reader = body.getReader();
    const decoder = new TextDecoder();

    try {
      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;

        if (value) {
          parser.feed(decoder.decode(value, { stream: !done }));
        }

        // Yield any buffered events
        while (events.length > 0) {
          yield events.shift()!;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
