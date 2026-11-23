import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';

import {
  WORKER_PROTOCOL_VERSION,
  WorkerEnvelope,
  isWorkerEnvelope,
} from './protocol.js';

/**
 * Client for the backend's worker stream at /runners/stream (falling back
 * to /mcp/streamable on a backend that predates that route).
 *
 * Two responsibilities:
 *
 *   1. POST envelopes to the backend (client -> server). Used for
 *      heartbeats, responses to dispatched requests, and unsolicited
 *      events the runner wants to emit.
 *   2. Maintain a long-lived GET stream (server -> client) that
 *      reconnects on disconnect, replaying via Last-Event-ID. Each
 *      received envelope is emitted as a typed `envelope` event the
 *      handler registry subscribes to.
 *
 * Reconnect policy:
 *   - One stream loop per client: at most one GET open or one reconnect
 *     pending at any time; every further trigger is a no-op.
 *   - Exponential backoff with jitter, capped at 30s, and really waited.
 *     A 429 waits its Retry-After and never less than the cap. The
 *     backoff restarts only after a stream stayed up HEALTHY_STREAM_MS.
 *   - A GET whose response headers have not arrived within
 *     STREAM_OPEN_TIMEOUT_MS is aborted and counts as a failed attempt.
 *   - We track the last event id we successfully parsed; on reconnect
 *     we send `Last-Event-ID` so the backend can replay anything we
 *     missed. A frame whose id was already seen is dropped.
 *   - Reconnect attempts emit `reconnect` events for observability.
 *
 * Auth: Bearer JWT in the Authorization header. A self-hosted runner
 * passes the login token from @almyty/client's resolveCredentials (the
 * daemon restarts when credentials.json changes); a hosted runner passes a
 * function returning its renewable runner credential (enroll.ts).
 */
/** The worker stream's route. */
export const RUNNER_STREAM_PATH = '/runners/stream';
/** Where it was before the MCP split; backends keep it for one runner release. */
export const LEGACY_STREAM_PATH = '/mcp/streamable';

export interface StreamableClientOptions {
  baseUrl: string;
  /**
   * The bearer token, or a function that returns the current one. A hosted
   * runner passes a function: its credential is renewed while it runs, and
   * every request reads the latest.
   */
  token: string | (() => string);
  /**
   * A fixed route, e.g. a hosted runner's /runners/hosted/stream. Unset:
   * /runners/stream with the legacy fallback below.
   */
  streamPath?: string;
  /**
   * Sent as X-Organization-Id on every request, so a user in several
   * organizations opens the session in the same one it registered in.
   */
  organizationId?: string;
  /** Test injection: replace the global fetch with a stub. */
  fetch?: typeof globalThis.fetch;
  /** Test injection: replace setTimeout with a controllable timer. */
  setTimeoutFn?: typeof setTimeout;
  /** Test injection: the clearTimeout matching setTimeoutFn. */
  clearTimeoutFn?: (t: any) => void;
  /** Test injection: the jitter source, [0, 1). */
  random?: () => number;
  /** Test injection: the clock. */
  now?: () => number;
  /** Test injection: the stream open timeout; default STREAM_OPEN_TIMEOUT_MS. */
  streamOpenTimeoutMs?: number;
}

/** How many recent event ids are remembered to drop a frame seen twice. */
const SEEN_EVENT_IDS_MAX = 512;

export class StreamableClient extends EventEmitter {
  private sessionId: string | null = null;
  private lastEventId: string | null = null;
  private streamAbort: AbortController | null = null;
  private stopped = false;
  private reconnectAttempt = 0;
  /**
   * The one stream loop: idle (nothing running), opening (a GET in
   * flight), open (being read) or waiting (a reconnect timer pending).
   * Only idle may start a stream.
   */
  private state: 'idle' | 'opening' | 'open' | 'waiting' = 'idle';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly seenEventIds = new Set<string>();
  /** The route this client talks to; see fellBackFrom404. */
  private streamPath: string = RUNNER_STREAM_PATH;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: (t: any) => void;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(private readonly opts: StreamableClientOptions) {
    super();
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.setTimeoutFn = opts.setTimeoutFn ?? ((fn: () => void, ms?: number) => setTimeout(fn, ms)) as typeof setTimeout;
    this.clearTimeoutFn = opts.clearTimeoutFn ?? ((t) => clearTimeout(t));
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? (() => Date.now());
    if (opts.streamPath) this.streamPath = opts.streamPath;
  }

  /** Returns the session id once the first POST has assigned one. */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /** Authorization plus, when configured, the organization header. */
  private authHeaders(): Record<string, string> {
    const token = typeof this.opts.token === 'function' ? this.opts.token() : this.opts.token;
    const headers: Record<string, string> = { 'Authorization': `Bearer ${token}` };
    if (this.opts.organizationId) headers['X-Organization-Id'] = this.opts.organizationId;
    return headers;
  }

  /** Send an envelope. Returns the parsed response envelope when the
   *  backend hands one back inline (for unary requests); otherwise null. */
  async send<T>(env: WorkerEnvelope<T>): Promise<WorkerEnvelope | null> {
    const post = () => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...this.authHeaders(),
      };
      if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
      return this.fetchImpl(`${this.opts.baseUrl}${this.streamPath}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(env),
      });
    };
    let res = await post();
    if (res.status === 404) {
      const text = await safeText(res);
      if (!this.fellBackFrom404(text)) throw new BackendPostError(res.status, text);
      res = await post();
    }
    const sid = res.headers.get('mcp-session-id') ?? res.headers.get('Mcp-Session-Id');
    if (sid) this.sessionId = sid;

    if (res.status === 202) return null;
    if (!res.ok) {
      const text = await safeText(res);
      throw new BackendPostError(res.status, text);
    }
    const json = await res.json();
    if (isWorkerEnvelope(json)) return json;
    return null;
  }

  /**
   * A 404 on `/runners/stream` from a backend that predates the route moves
   * this client to `/mcp/streamable` for good, and the caller retries once.
   * Only the framework's own "no such route" answer counts ("Cannot POST
   * /runners/stream"); any other 404, such as the transport's unknown-session
   * error, is the session being gone and never a reason to change route.
   * Returns whether it switched.
   */
  private fellBackFrom404(body: string): boolean {
    if (this.streamPath !== RUNNER_STREAM_PATH) return false;
    if (!/Cannot (GET|POST) \/runners\/stream\b/.test(body)) return false;
    this.streamPath = LEGACY_STREAM_PATH;
    this.emit('route-fallback', { from: RUNNER_STREAM_PATH, to: LEGACY_STREAM_PATH });
    return true;
  }

  /**
   * Open the GET stream and resolve as soon as it is open, or as soon as
   * its first attempt failed and a reconnect is scheduled; the stream is
   * then read in the background. openStream() itself resolves only when
   * the stream ends, so a caller that awaited it (the daemon did) waited
   * the whole life of the stream before its first heartbeat. When the
   * stream is already open, opening or waiting to reconnect, this starts
   * nothing and resolves at once: the loop that is running reopens it.
   */
  startStream(): Promise<void> {
    if (this.stopped || this.state !== 'idle') return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        this.off('open', onReady);
        this.off('reconnect', onReady);
        fn();
      };
      const onReady = () => settle(resolve);
      this.on('open', onReady);
      this.on('reconnect', onReady);
      this.openStream().then(onReady, (err) => settle(() => reject(err)));
    });
  }

  /**
   * Open the GET stream and dispatch envelopes via emit('envelope');
   * resolves when that stream ends (its reconnect is then scheduled). A
   * no-op while the client's one stream loop is already running, so
   * however many callers ask, there is one stream and one reconnect.
   */
  async openStream(): Promise<void> {
    if (this.stopped || this.state !== 'idle') return;
    if (!this.sessionId) {
      throw new Error('cannot open stream before any POST has assigned a session id');
    }
    await this.runStream();
  }

  /** One open-read-end cycle of the stream loop; ends in a scheduled reconnect. */
  private async runStream(): Promise<void> {
    if (this.stopped || this.state !== 'idle' || !this.sessionId) return;
    this.state = 'opening';
    this.streamAbort = new AbortController();
    const headers: Record<string, string> = {
      ...this.authHeaders(),
      'Mcp-Session-Id': this.sessionId,
      'Accept': 'text/event-stream',
    };
    if (this.lastEventId) headers['Last-Event-ID'] = this.lastEventId;

    // A server (or a proxy in front of it) can accept the connection and
    // never send headers; without a limit the loop would wait on that GET
    // forever. Only the open is timed: fetch resolves when the headers
    // arrive, and the long-lived body after that has no deadline here.
    const openTimeoutMs = this.opts.streamOpenTimeoutMs ?? STREAM_OPEN_TIMEOUT_MS;
    const abort = this.streamAbort;
    let openTimedOut = false;
    const openTimer = this.setTimeoutFn(() => {
      openTimedOut = true;
      abort.abort();
    }, openTimeoutMs);
    (openTimer as any).unref?.();

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl}${this.streamPath}`, {
        method: 'GET',
        headers,
        signal: abort.signal,
      });
    } catch (err: any) {
      this.scheduleReconnect(openTimedOut
        ? new Error(`stream open timed out: no response headers after ${openTimeoutMs}ms`)
        : err);
      return;
    } finally {
      this.clearTimeoutFn(openTimer);
    }

    if (!res.ok) {
      const text = await safeText(res);
      // 404 UNKNOWN_SESSION means the server forgot us; we have to
      // re-establish a session by POSTing again. Drop the saved
      // session id and let the next send() mint a new one.
      if (res.status === 404 && this.fellBackFrom404(text)) {
        // An older backend without /runners/stream: same session, older
        // route. Reconnect there.
        this.scheduleReconnect(new Error('stream route not found; using the legacy route'));
        return;
      }
      // Rate limited: wait what the server asked, and never less than the
      // cap. Coming back sooner only spends more of the same budget, which
      // is shared with everything else from this address.
      const minDelay = res.status === 429
        ? Math.max(retryAfterMs(res, this.now()), RECONNECT_CAP_MS)
        : 0;
      if (res.status === 404) {
        this.sessionId = null;
        this.lastEventId = null;
      }
      // Scheduled before session-lost is told, so whoever re-establishes
      // the session finds the loop already waiting and starts no other.
      this.scheduleReconnect(new Error(`stream open failed: ${res.status} ${text}`), minDelay);
      if (res.status === 404) this.emit('session-lost', text);
      return;
    }
    if (!res.body) {
      this.scheduleReconnect(new Error('stream open: no body'));
      return;
    }

    this.state = 'open';
    const openedAt = this.now();
    this.emit('open');

    try {
      await this.consumeStream(res.body);
    } catch (err: any) {
      this.emit('disconnect', err);
    }
    if (this.stopped) return;
    // Only a stream that stayed up a while proves the backend is fine
    // again; one that opens and drops at once keeps backing off.
    if (this.now() - openedAt >= HEALTHY_STREAM_MS) this.reconnectAttempt = 0;
    this.scheduleReconnect(new Error('stream ended'));
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) this.clearTimeoutFn(this.reconnectTimer);
    this.reconnectTimer = null;
    this.streamAbort?.abort();
  }

  // ── internals ───────────────────────────────────────────────────────

  /**
   * SSE parser. The MCP Streamable HTTP wire format follows the SSE
   * spec: events are separated by blank lines, fields are `id:`,
   * `event:`, `data:`. We accept arbitrary header order and ignore
   * unknown fields.
   *
   * Buffers across chunk boundaries because TCP doesn't respect SSE
   * frame boundaries; one fetch chunk often contains a half-event.
   */
  private async consumeStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      // Frames are double-newline separated.
      let frameEnd = buffer.indexOf('\n\n');
      while (frameEnd !== -1) {
        const frame = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd + 2);
        this.handleFrame(frame);
        frameEnd = buffer.indexOf('\n\n');
      }
    }
  }

  private handleFrame(frame: string): void {
    if (!frame) return;
    let id = '';
    let dataLines: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('id:')) id = line.slice(3).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      else if (line.startsWith('event:')) { /* event name unused on this side */ }
    }
    if (dataLines.length === 0) return;
    if (id) {
      this.lastEventId = id;
      // A frame seen before (a replay overlapping what arrived live, or a
      // backend that wrote it on two streams) is dropped: a request must
      // not run twice, and a second ack for one heartbeat is noise.
      if (this.seenEventIds.has(id)) return;
      this.seenEventIds.add(id);
      if (this.seenEventIds.size > SEEN_EVENT_IDS_MAX) {
        this.seenEventIds.delete(this.seenEventIds.values().next().value as string);
      }
    }
    const dataText = dataLines.join('\n');
    let parsed: unknown;
    try { parsed = JSON.parse(dataText); } catch {
      this.emit('parse-error', dataText);
      return;
    }
    if (!isWorkerEnvelope(parsed)) {
      this.emit('parse-error', dataText);
      return;
    }
    this.emit('envelope', parsed);
  }

  /**
   * Wait, then open the stream again. At most one wait is ever pending:
   * a second call while one is (the stream's end and its read error, a
   * session-lost and the failed open that reported it) is dropped, so
   * the client never runs two loops. The delay is the one logged, and it
   * is really waited.
   */
  private scheduleReconnect(reason: Error, minDelayMs = 0): void {
    if (this.stopped || this.reconnectTimer) return;
    this.state = 'waiting';
    this.reconnectAttempt++;
    const delay = Math.max(backoffDelay(this.reconnectAttempt, this.random), minDelayMs);
    this.emit('reconnect', { attempt: this.reconnectAttempt, delayMs: delay, reason: reason.message });
    const t = this.setTimeoutFn(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      this.state = 'idle';
      if (!this.sessionId) {
        // The session was dropped (404) and no new one has been minted
        // (the re-mint failed or is still running). Wait again rather than
        // open without one, and say the session is still missing so the
        // daemon tries the re-mint again.
        this.scheduleReconnect(new Error('no session yet'));
        this.emit('session-lost', 'no session');
        return;
      }
      this.runStream().catch(err => this.emit('stream-error', err));
    }, delay);
    this.reconnectTimer = t;
    (t as any).unref?.();
  }
}

/** Reconnect backoff: 1s doubling per attempt, capped. */
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_CAP_MS = 30_000;
/** A stream open this long counts as healthy: its end restarts the backoff. */
export const HEALTHY_STREAM_MS = 30_000;
/** How long the stream GET may wait for response headers before it is aborted and retried. */
export const STREAM_OPEN_TIMEOUT_MS = 30_000;

/**
 * The wait before reconnect attempt `attempt` (1-based): exponential up to
 * the cap, jittered over its upper half so a fleet of runners dropped by
 * one deploy does not come back in lockstep.
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt - 1, 20));
  return Math.round(base / 2 + random() * (base / 2));
}

/**
 * A 429's Retry-After in ms (delta-seconds or an HTTP date), or 0 when
 * absent or unreadable.
 */
export function retryAfterMs(res: Response, now: number): number {
  const raw = res.headers?.get?.('retry-after');
  if (!raw) return 0;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : 0;
}

/** A POST the backend answered with an error; `status` tells a sender whether to retry. */
export class BackendPostError extends Error {
  constructor(readonly status: number, body: string) {
    super(`backend POST failed: ${status} ${body}`);
    this.name = 'BackendPostError';
  }
}
async function safeText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ''; }
}

/** Helper to mint an envelope on the runner side. */
export function envelope<T>(type: WorkerEnvelope['type'], payload: T, correlationId?: string): WorkerEnvelope<T> {
  return {
    v: WORKER_PROTOCOL_VERSION,
    type,
    id: correlationId ?? randomUUID(),
    ts: Date.now(),
    payload,
  };
}
