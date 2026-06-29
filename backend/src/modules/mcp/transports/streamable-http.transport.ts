import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import * as Redis from 'ioredis';
import { Request, Response } from 'express';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';

import { McpService } from '../mcp.service';
import { McpSessionService } from '../mcp-session.service';
import { JsonRpcRequest, JsonRpcResponse } from '../types/mcp.types';
import {
  WorkerEnvelope,
  WorkerErrorPayload,
  WORKER_ERROR_CODES,
  WORKER_PROTOCOL_VERSION,
  isWorkerEnvelope,
} from '../types/worker-protocol.types';

/**
 * Streamable HTTP transport (MCP 2025-03-26 revision).
 *
 * Single endpoint hosting both directions:
 *
 *   POST /mcp/streamable          - client -> server JSON-RPC or worker envelope.
 *   GET  /mcp/streamable          - opens an SSE stream for server -> client.
 *
 * Sessions identified by the `Mcp-Session-Id` request/response header.
 * Server assigns it on the first POST that creates a session; clients
 * echo it back. Reconnection uses the standard SSE `Last-Event-ID`
 * header: a client reconnecting includes the last event id it saw, and
 * the transport replays everything after it from a per-session ring
 * buffer. Events older than the buffer's high-water mark return
 * REPLAY_UNAVAILABLE.
 *
 * The transport hosts two message shapes on the same wire:
 *
 *   - JSON-RPC 2.0 (MCP itself), routed to McpService.handleJsonRpc.
 *   - Worker envelopes (the runner subsystem and any future workers),
 *     emitted as `envelope` events for the runner module to subscribe to.
 *
 * Dispatch is by shape: JSON-RPC has `jsonrpc: '2.0'` and `method`,
 * envelopes have `v: 1` and `type`. Anything else is rejected with a
 * MALFORMED_ENVELOPE error.
 *
 * This transport is independent of SSE/WebSocket transports; it does
 * not refactor them. They coexist behind different routes.
 */

interface BufferedEvent {
  id: string;
  seq: number;
  /** Pre-formatted SSE frame, ready to write directly. */
  frame: string;
}

interface StreamableSession {
  id: string;
  /** Active GET stream response, or null if no stream currently open. */
  stream: Response | null;
  organizationId: string;
  userId?: string;
  /** Monotonic sequence counter for events emitted on this session. */
  seq: number;
  /** Ring buffer of recent events for Last-Event-ID replay. */
  buffer: BufferedEvent[];
  /** Last time we saw any client activity (POST or GET reconnect). */
  lastActivity: Date;
}

const REPLAY_BUFFER_MAX = 256;
const STALE_AFTER_MS = 5 * 60 * 1000;
/** TTL for the cross-pod session registry; refreshed on activity. */
const SESSION_REGISTRY_TTL_S = 600;
/** SSE keep-alive comment cadence — well under typical proxy idle timeouts. */
const KEEPALIVE_INTERVAL_MS = 15_000;
/** Redis channels for cross-replica delivery (see the multi-replica note). */
const CH_OUT = 'strm:out';   // server->client frames, fan to the stream-holding pod
const CH_RESP = 'strm:resp'; // client->server responses, fan to the dispatching pod

/**
 * Multi-replica correctness
 * -------------------------
 * The live SSE GET stream is a TCP connection held by ONE pod, and the
 * in-memory `sessions` Map is pod-local. With >1 backend replica behind a
 * round-robin LB that breaks three ways:
 *   1. the GET stream lands on a pod that never minted the session -> 404.
 *   2. a server->client push (e.g. runner dispatch) runs on a different pod
 *      than the one holding the stream -> never delivered.
 *   3. a client->server response POST lands on a different pod than the one
 *      with the pending dispatch call -> never matched.
 *
 * When a Redis client is present we fix all three without making the live
 * stream itself shared:
 *   1. a shared session registry (strm:sess:<id>) lets any pod ADOPT a session
 *      it didn't mint, so the GET stream opens anywhere.
 *   2. push() PUBLISHES frames to CH_OUT; whichever pod holds the stream
 *      (subscribed) writes them.
 *   3. response/error envelopes are PUBLISHED to CH_RESP; every pod re-emits
 *      them locally so the pod with the pending call matches by correlation id
 *      (load-and-delete dedups the same-pod double-delivery).
 *
 * Redis is OPTIONAL: with no client (tests, single-pod dev) the transport is
 * exactly the in-memory implementation it always was.
 */

@Injectable()
export class StreamableHttpTransport extends EventEmitter {
  private readonly logger = new Logger(StreamableHttpTransport.name);
  private readonly sessions = new Map<string, StreamableSession>();
  private gcInterval?: NodeJS.Timeout;
  /** Dedicated subscriber connection (ioredis requires one for sub mode). */
  private subscriber?: Redis.Redis;
  /** This replica's id, for cross-pod diagnostic logs. */
  private readonly podId = process.env.HOSTNAME ?? process.env.POD_NAME ?? `pid${process.pid}`;
  /** Session ids this pod minted (vs adopted) — diagnostic only. */
  private readonly sessionMintedHere = new Set<string>();

  constructor(
    private readonly mcpService: McpService,
    private readonly mcpSessionService: McpSessionService,
    @Optional() @InjectRedis() private readonly redis?: Redis.Redis,
  ) {
    super();
    this.startGcLoop();
    if (this.redis) this.startRedisBridge();
  }

  /**
   * Handle POST /mcp/streamable. The request body is either a single
   * JSON-RPC message, a JSON-RPC batch, or a worker envelope.
   *
   * Response shape per the MCP spec:
   *   - 202 Accepted, empty body, when the message is a notification or
   *     a response (nothing to return inline).
   *   - 200 application/json, a single JSON value, for a unary request.
   *
   * Batch SSE responses (200 text/event-stream) are not implemented in
   * this cluster; they are not needed by the runner subsystem and would
   * couple this transport to the McpService request semantics. Add when
   * the first MCP method that benefits actually lands.
   */
  async handlePost(
    req: Request,
    res: Response,
    organizationId: string,
    userId?: string,
  ): Promise<void> {
    const sessionId = (req.header('Mcp-Session-Id') || '').trim() || null;
    if (sessionId) {
      const existing = this.sessions.get(sessionId);
      if (existing && existing.organizationId !== organizationId) {
        // Cross-tenant attempt: refuse rather than reuse the prior session
        // or silently mint a new one with the attacker's claimed id.
        this.sendErrorResponse(res, WORKER_ERROR_CODES.UNKNOWN_SESSION, 'session not in this org');
        return;
      }
    }
    const session = sessionId
      ? this.sessions.get(sessionId) ?? this.createSession(organizationId, userId, sessionId)
      : this.createSession(organizationId, userId);

    session.lastActivity = new Date();
    this.registerSession(session); // refresh cross-pod registry TTL on activity
    res.setHeader('Mcp-Session-Id', session.id);

    const body = req.body;

    // Worker envelope path. The envelope-shaped check runs first so a
    // body that happens to set both `v` and `jsonrpc` (a misconfigured
    // client) gets a deterministic dispatch on the worker side.
    if (this.looksLikeEnvelope(body)) {
      if (!isWorkerEnvelope(body)) {
        this.sendErrorResponse(res, WORKER_ERROR_CODES.MALFORMED_ENVELOPE, 'invalid envelope');
        return;
      }
      // Notifications/responses are fire-and-forget: emit and return 202.
      // Requests can elicit a server-side response later via the GET stream;
      // the POST itself just acknowledges receipt.
      this.emit('envelope', body, session);
      // A response/error may belong to a dispatch whose pending call lives on
      // a DIFFERENT pod (the one that issued the request). Fan it out so that
      // pod can match by correlation id. (heartbeat/hello stay local — they're
      // processed wherever they land and a broadcast would double-write.)
      if (this.redis && (body.type === 'response' || body.type === 'error')) {
        this.redis
          .publish(CH_RESP, JSON.stringify(body))
          .catch((err) => this.logger.warn(`CH_RESP publish failed: ${err?.message ?? err}`));
      }
      res.status(202).end();
      return;
    }

    // JSON-RPC path. Mirrors how SseTransport.handleSseMessage delegates,
    // but here we return the response inline rather than via SSE because
    // a single POST is supposed to settle synchronously when possible.
    if (this.looksLikeJsonRpc(body)) {
      try {
        const response = await this.mcpService.handleJsonRpc(
          body as JsonRpcRequest,
          organizationId,
          userId,
        );
        // Notifications (no `id`) get 202; requests get 200 with body.
        const isNotification = (body as JsonRpcRequest).id === undefined;
        if (isNotification) {
          res.status(202).end();
        } else {
          res.status(200).json(response);
        }
      } catch (err: any) {
        const errorResponse: JsonRpcResponse = {
          jsonrpc: '2.0',
          id: (body as JsonRpcRequest).id ?? null as any,
          error: {
            code: WORKER_ERROR_CODES.INTERNAL,
            message: 'Internal error',
            data: err?.message ?? String(err),
          },
        };
        res.status(200).json(errorResponse);
      }
      return;
    }

    this.sendErrorResponse(res, WORKER_ERROR_CODES.MALFORMED_ENVELOPE, 'unrecognized message shape');
  }

  /**
   * Handle GET /mcp/streamable. Opens (or resumes) the server -> client
   * SSE stream for a session. Honors `Last-Event-ID` for replay.
   *
   * Each session has at most one open stream; opening a second one
   * preempts the first (the previous stream is ended). This matches
   * the spec's stance that the server-to-client stream is singular per
   * session.
   */
  async handleStream(
    req: Request,
    res: Response,
    organizationId: string,
    _userId?: string,
  ): Promise<void> {
    const sessionId = (req.header('Mcp-Session-Id') || '').trim();
    if (!sessionId) {
      this.sendErrorResponse(res, WORKER_ERROR_CODES.UNKNOWN_SESSION, 'Mcp-Session-Id required');
      return;
    }
    // Local first; otherwise adopt from the shared registry so a GET stream
    // that round-robins to a pod which didn't mint the session still opens
    // (instead of 404-flapping on multi-replica).
    const session = this.sessions.get(sessionId) ?? await this.adoptSession(sessionId, organizationId);
    if (!session) {
      this.sendErrorResponse(res, WORKER_ERROR_CODES.UNKNOWN_SESSION, 'unknown session');
      return;
    }
    if (session.organizationId !== organizationId) {
      // Cross-tenant attempt; refuse loudly rather than leaking session
      // existence by returning UNKNOWN_SESSION.
      this.sendErrorResponse(res, WORKER_ERROR_CODES.UNKNOWN_SESSION, 'session not in this org');
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Mcp-Session-Id', session.id);
    // Tell nginx/proxies NOT to buffer this response — without it the
    // ingress holds events and can close the connection as idle.
    res.setHeader('X-Accel-Buffering', 'no');
    // SSE responses must flush headers before the first event, otherwise
    // some intermediaries hold the connection until first byte.
    res.flushHeaders?.();

    const adopted = !this.sessionMintedHere.has(session.id);
    const preempting = !!(session.stream && !session.stream.destroyed);
    this.logger.log(`[strm] open session=${session.id} pod=${this.podId} adopted=${adopted} preempt=${preempting}`);

    // Preempt prior stream if any.
    if (preempting) {
      try { session.stream!.end(); } catch { /* already gone */ }
    }
    session.stream = res;
    session.lastActivity = new Date();

    // SSE keep-alive: send a comment frame periodically so idle streams (no
    // events for a while) aren't closed by the client, nginx, or the LB.
    // Without this an idle command stream gets reaped and the runner sees
    // "stream ended" → reconnect churn → unreliable dispatch.
    const keepAlive = setInterval(() => {
      if (res.destroyed) return;
      try { res.write(': keep-alive\n\n'); } catch { /* */ }
    }, KEEPALIVE_INTERVAL_MS);
    keepAlive.unref?.();

    res.on('close', () => {
      clearInterval(keepAlive);
      if (session.stream === res) session.stream = null;
      this.logger.log(`[strm] close session=${session.id} pod=${this.podId}`);
    });

    const lastEventId = (req.header('Last-Event-ID') || '').trim();
    if (lastEventId) {
      const replayed = this.replayFrom(session, lastEventId, res);
      if (replayed === 'unavailable') {
        // Spec's stance: send an error event but keep the stream open so
        // the client can decide whether to start fresh or hang up. We
        // emit and continue; client policy decides recovery.
        this.writeRaw(res, this.formatEvent(
          this.mintId(session),
          'error',
          this.envelope<WorkerErrorPayload>(session, 'error', {
            code: WORKER_ERROR_CODES.REPLAY_UNAVAILABLE,
            message: `event ${lastEventId} not in replay buffer`,
          }, lastEventId),
        ));
      }
    }
  }

  /**
   * Server-side push of an envelope to a session's open stream. Buffered
   * for replay regardless of whether a stream is currently open, so a
   * disconnected client that reconnects with Last-Event-ID gets the
   * messages it missed.
   */
  push<T>(sessionId: string, type: WorkerEnvelope['type'], payload: T, correlationId?: string): WorkerEnvelope<T> | null {
    const local = this.sessions.get(sessionId);
    // Fast path: this pod holds the live stream — deliver directly.
    if (local && local.stream && !local.stream.destroyed) {
      return this.deliverLocal(local, type, payload, correlationId);
    }
    // No local stream here. If Redis is wired, the stream may live on another
    // pod — publish and let the holder write it. (Offline is already checked
    // by the caller via the RunnerSession table before push.)
    if (this.redis) {
      const env: WorkerEnvelope<T> = {
        v: WORKER_PROTOCOL_VERSION,
        type,
        id: correlationId ?? `${sessionId}:${randomUUID().slice(0, 8)}`,
        ts: Date.now(),
        payload,
      };
      this.redis
        .publish(CH_OUT, JSON.stringify({ sessionId, type, payload, correlationId }))
        .catch((err) => this.logger.warn(`CH_OUT publish failed: ${err?.message ?? err}`));
      return env;
    }
    // No Redis and no local stream: buffer locally for replay if the session
    // exists here, else report not-deliverable.
    if (!local) return null;
    return this.deliverLocal(local, type, payload, correlationId);
  }

  /** Build, buffer, and write an envelope to a locally-held session's stream. */
  private deliverLocal<T>(session: StreamableSession, type: WorkerEnvelope['type'], payload: T, correlationId?: string): WorkerEnvelope<T> {
    const env = this.envelope(session, type, payload, correlationId);
    const frame = this.formatEvent(env.id, type, env);
    this.buffer(session, env.id, env.seq!, frame);
    if (session.stream && !session.stream.destroyed) {
      try {
        this.writeRaw(session.stream, frame);
      } catch (err: any) {
        this.logger.warn(`stream write failed for session=${session.id}: ${err.message}`);
        session.stream = null;
      }
    }
    return env;
  }

  /** For tests and stats; do not mutate. */
  getSession(sessionId: string): Readonly<StreamableSession> | undefined {
    return this.sessions.get(sessionId);
  }

  getStats(): { sessions: number; openStreams: number } {
    let openStreams = 0;
    for (const s of this.sessions.values()) if (s.stream) openStreams++;
    return { sessions: this.sessions.size, openStreams };
  }

  async shutdown(): Promise<void> {
    if (this.gcInterval) clearInterval(this.gcInterval);
    if (this.subscriber) {
      try { await this.subscriber.quit(); } catch { /* */ }
      this.subscriber = undefined;
    }
    for (const session of this.sessions.values()) {
      if (session.stream && !session.stream.destroyed) {
        try { session.stream.end(); } catch { /* */ }
      }
    }
    this.sessions.clear();
  }

  // ── internals ───────────────────────────────────────────────────────

  private createSession(
    organizationId: string,
    userId: string | undefined,
    requestedId?: string | null,
  ): StreamableSession {
    const id = requestedId && /^[A-Za-z0-9_-]{8,}$/.test(requestedId)
      ? requestedId
      : `sh_${randomUUID()}`;
    if (this.sessions.has(id)) return this.sessions.get(id)!;
    // Mirror SSE transport: also create a parallel McpSession so MCP-side
    // listeners (notifications, etc.) can wire by sessionId if desired.
    this.mcpSessionService.createSession(organizationId, 'streamable-http', userId);
    const session: StreamableSession = {
      id,
      stream: null,
      organizationId,
      userId,
      seq: 0,
      buffer: [],
      lastActivity: new Date(),
    };
    this.sessions.set(id, session);
    this.sessionMintedHere.add(id);
    this.registerSession(session); // cross-pod registry (no-op without redis)
    return session;
  }

  /** Publish a session's existence so any replica can adopt it. */
  private registerSession(session: StreamableSession): void {
    if (!this.redis) return;
    this.redis
      .set(`strm:sess:${session.id}`, JSON.stringify({ org: session.organizationId, userId: session.userId ?? null }), 'EX', SESSION_REGISTRY_TTL_S)
      .catch((err) => this.logger.warn(`session registry write failed: ${err?.message ?? err}`));
  }

  /**
   * Adopt a session this pod didn't mint, using the shared registry. Returns
   * a fresh local session entry, or null if the registry has no record (truly
   * unknown) or the org doesn't match (cross-tenant).
   */
  private async adoptSession(
    sessionId: string,
    organizationId: string,
  ): Promise<StreamableSession | null> {
    if (!this.redis) return null;
    let raw: string | null;
    try {
      raw = await this.redis.get(`strm:sess:${sessionId}`);
    } catch (err: any) {
      this.logger.warn(`session registry read failed: ${err?.message ?? err}`);
      return null;
    }
    if (!raw) return null;
    let meta: { org: string; userId: string | null };
    try { meta = JSON.parse(raw); } catch { return null; }
    if (meta.org !== organizationId) return null;
    const session: StreamableSession = {
      id: sessionId,
      stream: null,
      organizationId: meta.org,
      userId: meta.userId ?? undefined,
      seq: 0,
      buffer: [],
      lastActivity: new Date(),
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  private envelope<T>(
    session: StreamableSession,
    type: WorkerEnvelope['type'],
    payload: T,
    correlationId?: string,
  ): WorkerEnvelope<T> {
    session.seq += 1;
    return {
      v: WORKER_PROTOCOL_VERSION,
      type,
      id: correlationId ?? this.mintId(session),
      seq: session.seq,
      ts: Date.now(),
      payload,
    };
  }

  private mintId(session: StreamableSession): string {
    return `${session.id}:${session.seq + 1}:${randomUUID().slice(0, 8)}`;
  }

  private buffer(session: StreamableSession, id: string, seq: number, frame: string): void {
    session.buffer.push({ id, seq, frame });
    if (session.buffer.length > REPLAY_BUFFER_MAX) {
      session.buffer.shift();
    }
  }

  /**
   * Returns 'replayed' on success (even if zero events were replayed,
   * which is the case when the client is already up to date), or
   * 'unavailable' if the requested event id has aged out of the buffer.
   */
  private replayFrom(
    session: StreamableSession,
    lastEventId: string,
    res: Response,
  ): 'replayed' | 'unavailable' {
    const idx = session.buffer.findIndex((e) => e.id === lastEventId);
    if (idx === -1) {
      // Two cases: the buffer is empty (nothing was sent yet, client
      // is reconnecting on a stale token) or the id aged out. Treat
      // both as unavailable; the client will decide how to recover.
      return session.buffer.length === 0 ? 'replayed' : 'unavailable';
    }
    for (let i = idx + 1; i < session.buffer.length; i++) {
      this.writeRaw(res, session.buffer[i].frame);
    }
    return 'replayed';
  }

  private formatEvent(id: string, eventName: string, data: unknown): string {
    // SSE frame format. `id:` is what the client echoes back as
    // Last-Event-ID. `event:` lets clients filter by name. Data is a
    // single JSON line; multi-line payloads would need to split with
    // `data:` per line per spec, but JSON.stringify never produces
    // newlines so a single-line write is safe.
    return `id: ${id}\nevent: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  private writeRaw(res: Response, frame: string): void {
    res.write(frame);
  }

  private sendErrorResponse(res: Response, code: number, message: string): void {
    const status = code === WORKER_ERROR_CODES.UNKNOWN_SESSION ? 404 : 400;
    res.status(status).json({
      v: WORKER_PROTOCOL_VERSION,
      type: 'error',
      id: randomUUID(),
      ts: Date.now(),
      payload: { code, message } satisfies WorkerErrorPayload,
    });
  }

  private looksLikeEnvelope(body: unknown): boolean {
    return !!body && typeof body === 'object' && (body as any).v === WORKER_PROTOCOL_VERSION;
  }

  private looksLikeJsonRpc(body: unknown): boolean {
    return !!body && typeof body === 'object' && (body as any).jsonrpc === '2.0';
  }

  /**
   * Wire the cross-replica bridge: a dedicated subscriber connection (ioredis
   * requires one for sub mode) listening on CH_OUT (deliver to a locally-held
   * stream) and CH_RESP (re-emit so a local pending dispatch can match).
   */
  private startRedisBridge(): void {
    try {
      this.subscriber = this.redis!.duplicate();
      this.subscriber.on('error', (err) => this.logger.warn(`subscriber error: ${err?.message ?? err}`));
      this.subscriber.subscribe(CH_OUT, CH_RESP).catch((err) =>
        this.logger.error(`failed to subscribe to streamable channels: ${err?.message ?? err}`),
      );
      this.subscriber.on('message', (channel, message) => this.onRedisMessage(channel, message));
      this.logger.log('streamable cross-replica bridge active (CH_OUT/CH_RESP)');
    } catch (err: any) {
      this.logger.error(`failed to start redis bridge: ${err?.message ?? err}`);
    }
  }

  private onRedisMessage(channel: string, message: string): void {
    let parsed: any;
    try { parsed = JSON.parse(message); } catch { return; }
    if (channel === CH_OUT) {
      // Another pod wants to push to this session; write it only if WE hold
      // the live stream. Other pods ignore it.
      const { sessionId, type, payload, correlationId } = parsed;
      const session = this.sessions.get(sessionId);
      if (session && session.stream && !session.stream.destroyed) {
        this.deliverLocal(session, type, payload, correlationId);
      }
    } else if (channel === CH_RESP) {
      // A response/error from any pod; re-emit locally so the pod with the
      // matching pending dispatch call resolves it (load-and-delete dedups).
      this.emit('envelope', parsed, undefined);
    }
  }

  private startGcLoop(): void {
    this.gcInterval = setInterval(() => {
      const now = Date.now();
      for (const [id, session] of this.sessions) {
        if (now - session.lastActivity.getTime() > STALE_AFTER_MS) {
          if (session.stream && !session.stream.destroyed) {
            try { session.stream.end(); } catch { /* */ }
          }
          this.sessions.delete(id);
          this.logger.log(`gc removed stale session ${id}`);
        }
      }
    }, 60_000);
    // Don't pin the event loop in tests / graceful shutdown.
    this.gcInterval.unref?.();
  }
}
