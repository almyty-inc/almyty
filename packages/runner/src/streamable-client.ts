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
 *   - Exponential backoff capped at 30s (1s, 2s, 4s, 8s, 16s, 30s, 30s).
 *   - We track the last event id we successfully parsed; on reconnect
 *     we send `Last-Event-ID` so the backend can replay anything we
 *     missed.
 *   - Reconnect attempts emit `reconnect` events for observability;
 *     persistent failure emits `fatal` and the daemon exits.
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
}

export class StreamableClient extends EventEmitter {
  private sessionId: string | null = null;
  private lastEventId: string | null = null;
  private streamAbort: AbortController | null = null;
  private stopped = false;
  private reconnectAttempt = 0;
  /** The route this client talks to; see fellBackFrom404. */
  private streamPath: string = RUNNER_STREAM_PATH;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly setTimeoutFn: typeof setTimeout;

  constructor(private readonly opts: StreamableClientOptions) {
    super();
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
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
      if (!this.fellBackFrom404(text)) throw new Error(`backend POST failed: ${res.status} ${text}`);
      res = await post();
    }
    const sid = res.headers.get('mcp-session-id') ?? res.headers.get('Mcp-Session-Id');
    if (sid) this.sessionId = sid;

    if (res.status === 202) return null;
    if (!res.ok) {
      const text = await safeText(res);
      throw new Error(`backend POST failed: ${res.status} ${text}`);
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
   * the whole life of the stream before its first heartbeat.
   */
  startStream(): Promise<void> {
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
  /** Open the GET stream and dispatch envelopes via emit('envelope'). */
  async openStream(): Promise<void> {
    if (this.stopped) return;
    if (!this.sessionId) {
      throw new Error('cannot open stream before any POST has assigned a session id');
    }
    this.streamAbort = new AbortController();
    const headers: Record<string, string> = {
      ...this.authHeaders(),
      'Mcp-Session-Id': this.sessionId,
      'Accept': 'text/event-stream',
    };
    if (this.lastEventId) headers['Last-Event-ID'] = this.lastEventId;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl}${this.streamPath}`, {
        method: 'GET',
        headers,
        signal: this.streamAbort.signal,
      });
    } catch (err: any) {
      this.scheduleReconnect(err);
      return;
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
      if (res.status === 404) {
        this.sessionId = null;
        this.lastEventId = null;
        this.emit('session-lost', text);
      }
      this.scheduleReconnect(new Error(`stream open failed: ${res.status} ${text}`));
      return;
    }
    if (!res.body) {
      this.scheduleReconnect(new Error('stream open: no body'));
      return;
    }

    this.reconnectAttempt = 0;
    this.emit('open');

    try {
      await this.consumeStream(res.body);
    } catch (err: any) {
      this.emit('disconnect', err);
    }
    if (!this.stopped) this.scheduleReconnect(new Error('stream ended'));
  }

  stop(): void {
    this.stopped = true;
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
    if (id) this.lastEventId = id;
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

  private scheduleReconnect(reason: Error): void {
    if (this.stopped) return;
    this.reconnectAttempt++;
    const delays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
    const delay = delays[Math.min(this.reconnectAttempt - 1, delays.length - 1)];
    this.emit('reconnect', { attempt: this.reconnectAttempt, delayMs: delay, reason: reason.message });
    const t = this.setTimeoutFn(() => {
      if (!this.stopped) this.openStream().catch(err => this.emit('error', err));
    }, delay);
    (t as any).unref?.();
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
