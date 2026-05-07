import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';

import {
  WORKER_PROTOCOL_VERSION,
  WorkerEnvelope,
  isWorkerEnvelope,
} from './protocol.js';

/**
 * Client for the backend's Streamable HTTP endpoint at /mcp/streamable.
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
 * Auth: Bearer JWT in the Authorization header. The token comes from
 * @almyty/client's resolveCredentials and is passed in at construct
 * time; rotation isn't a v1.0 concern (the daemon restarts on token
 * rotation anyway because credentials.json was overwritten).
 */
export interface StreamableClientOptions {
  baseUrl: string;
  token: string;
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
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly setTimeoutFn: typeof setTimeout;

  constructor(private readonly opts: StreamableClientOptions) {
    super();
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
  }

  /** Returns the session id once the first POST has assigned one. */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /** Send an envelope. Returns the parsed response envelope when the
   *  backend hands one back inline (for unary requests); otherwise null. */
  async send<T>(env: WorkerEnvelope<T>): Promise<WorkerEnvelope | null> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.opts.token}`,
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    const res = await this.fetchImpl(`${this.opts.baseUrl}/mcp/streamable`, {
      method: 'POST',
      headers,
      body: JSON.stringify(env),
    });
    const sid = res.headers.get('mcp-session-id') ?? res.headers.get('Mcp-Session-Id');
    if (sid) this.sessionId = sid;

    if (res.status === 202) return null;
    if (!res.ok) {
      const text = await safeText(res);
      throw new Error(`backend POST failed: ${res.status} ${text}`);
    }
    const json = await res.json();
    if (isWorkerEnvelope(json)) return json;
    // JSON-RPC response shape (when the runner posts an MCP-shaped
    // body, which it shouldn't, but the transport supports both).
    return null;
  }

  /** Open the GET stream and dispatch envelopes via emit('envelope'). */
  async openStream(): Promise<void> {
    if (this.stopped) return;
    if (!this.sessionId) {
      throw new Error('cannot open stream before any POST has assigned a session id');
    }
    this.streamAbort = new AbortController();
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.opts.token}`,
      'Mcp-Session-Id': this.sessionId,
      'Accept': 'text/event-stream',
    };
    if (this.lastEventId) headers['Last-Event-ID'] = this.lastEventId;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl}/mcp/streamable`, {
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
