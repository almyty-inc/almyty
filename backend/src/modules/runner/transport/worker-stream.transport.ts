import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import * as Redis from 'ioredis';
import { Request, Response } from 'express';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';

import {
  WorkerEnvelope,
  WorkerErrorPayload,
  WORKER_ERROR_CODES,
  WORKER_PROTOCOL_VERSION,
  isWorkerEnvelope,
} from '../../mcp/types/worker-protocol.types';
import { workerReplayMax, workerReplayTtlSeconds } from './stream-backlog.config';

/**
 * The worker stream: the long-lived channel between the backend and a
 * runner daemon (and any future worker).
 *
 *   POST /runners/stream   - worker -> server envelope.
 *   GET  /runners/stream   - opens the server -> worker SSE stream.
 *
 * It used to be the MCP Streamable HTTP transport at /mcp/streamable, with
 * JSON-RPC (MCP) and worker envelopes sharing one wire. MCP 2026-07-28 is
 * stateless and the gateway MCP path never needed this session store, so
 * the two are split (docs/design/mcp-2026-07-28.md, "Runner transport
 * split"): this class carries envelopes only, and a JSON-RPC body is refused
 * with MALFORMED_ENVELOPE. /mcp/streamable stays routed here, envelopes
 * only, for one runner release so an installed runner keeps connecting.
 *
 * What runners depend on is unchanged: the `Mcp-Session-Id` header names
 * the session (minted on the first POST), the GET stream replays from
 * `Last-Event-ID` out of a per-session ring buffer (shared through Redis
 * when there is one), and the Redis keys and channels (`strm:sess:<id>`,
 * `strm:out`, `strm:resp`) keep their names so a rolling deploy does not
 * split old and new pods.
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
  /**
   * Ring buffer of recent events for Last-Event-ID replay: every frame
   * without Redis, the frames this pod wrote to the stream with it.
   */
  buffer: BufferedEvent[];
  /**
   * Set while a reconnect replays from the shared buffer: live frames wait
   * here and are written after the replay. Null otherwise.
   */
  replayQueue: BufferedEvent[] | null;
  /** Last time we saw any client activity (POST or GET reconnect). */
  lastActivity: Date;
}

const STALE_AFTER_MS = 5 * 60 * 1000;
/** TTL for the cross-pod session registry; refreshed on activity. */
const SESSION_REGISTRY_TTL_S = 600;
/** SSE keep-alive comment cadence — well under typical proxy idle timeouts. */
const KEEPALIVE_INTERVAL_MS = 15_000;
/** Redis channels for cross-replica delivery (see the multi-replica note). */
const CH_OUT = 'strm:out';   // server->client frames, fan to the stream-holding pod
const CH_RESP = 'strm:resp'; // client->server responses, fan to the dispatching pod
/** Shared Last-Event-ID replay buffer, a list per session. */
const SHARED_BUFFER_PREFIX = 'strm:buf:';

/**
 * Multi-replica correctness
 * -------------------------
 * The live SSE GET stream is a TCP connection held by ONE pod, and the
 * in-memory `sessions` Map is pod-local. With >1 backend replica behind a
 * round-robin LB that breaks four ways:
 *   1. the GET stream lands on a pod that never minted the session -> 404.
 *   2. a server->client push (e.g. runner dispatch) runs on a different pod
 *      than the one holding the stream -> never delivered.
 *   3. a client->server response POST lands on a different pod than the one
 *      with the pending dispatch call -> never matched.
 *   4. a reconnect with Last-Event-ID lands on a pod whose ring buffer never
 *      saw those frames -> nothing replayed, frames lost.
 *
 * When a Redis client is present we fix all four without making the live
 * stream itself shared:
 *   1. a shared session registry (strm:sess:<id>) lets any pod ADOPT a session
 *      it didn't mint, so the GET stream opens anywhere.
 *   2. push() PUBLISHES frames to CH_OUT; whichever pod holds the stream
 *      (subscribed) writes them.
 *   3. response/error envelopes are PUBLISHED to CH_RESP; every pod re-emits
 *      them locally so the pod with the pending call matches by correlation id
 *      (load-and-delete dedups the same-pod double-delivery).
 *   4. every frame goes into a shared, bounded replay buffer
 *      (strm:buf:<id>, WORKER_STREAM_REPLAY_MAX / _TTL_S) before it is
 *      published, and a reconnect replays from it on whichever pod it lands.
 *
 * Redis is OPTIONAL: with no client (tests, single-pod dev) the transport is
 * exactly the in-memory implementation it always was.
 */

@Injectable()
export class WorkerStreamTransport extends EventEmitter implements OnModuleDestroy {
  private readonly logger = new Logger(WorkerStreamTransport.name);
  private readonly sessions = new Map<string, StreamableSession>();
  private gcInterval?: NodeJS.Timeout;
  /** Dedicated subscriber connection (ioredis requires one for sub mode). */
  private subscriber?: Redis.Redis;
  /** This replica's id, for cross-pod diagnostic logs. */
  private readonly podId = process.env.HOSTNAME ?? process.env.POD_NAME ?? `pid${process.pid}`;
  /** Session ids this pod minted (vs adopted) — diagnostic only. */
  private readonly sessionMintedHere = new Set<string>();

  constructor(@Optional() @InjectRedis() private readonly redis?: Redis.Redis) {
    super();
    this.startGcLoop();
    if (this.redis) this.startRedisBridge();
  }

  /**
   * Handle a worker POST. The body is one worker envelope.
   *
   *   - 404 when `Mcp-Session-Id` names a session this server does not
   *     know: the worker's signal to start a new one (after a pod restart
   *     or a session GC).
   *   - 202 Accepted, empty body, for an accepted envelope; anything the
   *     server sends back arrives on the GET stream.
   *   - 400 MALFORMED_ENVELOPE for anything that is not an envelope,
   *     JSON-RPC included: MCP is served elsewhere.
   */
  async handlePost(
    req: Request,
    res: Response,
    organizationId: string,
    userId?: string,
  ): Promise<void> {
    const sessionId = (req.header('Mcp-Session-Id') || '').trim() || null;

    let session: StreamableSession;
    if (sessionId) {
      // Local first, then the cross-pod registry: on multi-replica the POST
      // can round-robin to a pod that did not mint the session, exactly as
      // handleStream already handles.
      const known =
        this.sessions.get(sessionId) ?? (await this.adoptSession(sessionId, organizationId));
      if (!known) {
        // MCP 2025-03-26 Streamable HTTP: an Mcp-Session-Id the server does
        // not recognise MUST be answered 404, so the client knows to start a
        // new session. This used to MINT a session under whatever id was
        // asked for, so after a restart or a GC sweep a client kept POSTing
        // its dead id, kept getting 200, and silently lost all its state
        // while believing the session was alive. handleStream has always
        // 404ed here; the two halves now agree.
        this.sendErrorResponse(res, WORKER_ERROR_CODES.UNKNOWN_SESSION, 'unknown session');
        return;
      }
      if (known.organizationId !== organizationId) {
        // Cross-tenant attempt: refuse rather than reuse the prior session
        // or silently mint a new one with the attacker's claimed id.
        this.sendErrorResponse(res, WORKER_ERROR_CODES.UNKNOWN_SESSION, 'session not in this org');
        return;
      }
      if (!this.sameUser(known, userId)) {
        // Same org, different user. A session is bound to the user who
        // minted it; another member posting on it could answer that
        // user's runner dispatches or inject coding output into them.
        this.sendErrorResponse(res, WORKER_ERROR_CODES.UNKNOWN_SESSION, 'session not yours');
        return;
      }
      session = known;
    } else {
      session = this.createSession(organizationId, userId);
    }

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
      // pod can match by correlation id, with the session it arrived on so
      // that pod can check it came from the runner it asked. (heartbeat/hello
      // stay local — they're processed wherever they land and a broadcast
      // would double-write.)
      if (this.redis && (body.type === 'response' || body.type === 'error')) {
        const origin = { id: session.id, organizationId: session.organizationId, userId: session.userId };
        this.redis
          .publish(CH_RESP, JSON.stringify({ envelope: body, session: origin }))
          .catch((err) => this.logger.warn(`CH_RESP publish failed: ${err?.message ?? err}`));
      }
      res.status(202).end();
      return;
    }

    // Anything else, JSON-RPC included, is not this channel's: MCP clients
    // talk to a gateway or POST /mcp.
    this.sendErrorResponse(res, WORKER_ERROR_CODES.MALFORMED_ENVELOPE, 'not a worker envelope');
  }

  /**
   * Handle the worker GET. Opens (or resumes) the server -> client
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
    if (!this.sameUser(session, _userId)) {
      // Same org, different user: opening someone else's stream would
      // preempt theirs and deliver the dispatches meant for their runner.
      this.sendErrorResponse(res, WORKER_ERROR_CODES.UNKNOWN_SESSION, 'session not yours');
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    // `no-transform` tells the compression() middleware NOT to gzip-buffer this
    // response. Without it, SSE events + keep-alives sit in the compression
    // buffer, never flush to nginx, and the stream both stalls (dispatch never
    // arrives) and gets closed at the proxy read-timeout. This is the load-
    // bearing header for streaming behind compression + nginx.
    res.setHeader('Cache-Control', 'no-cache, no-transform');
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
    if (!lastEventId) return;
    if (!this.redis) {
      this.replayOrReport(session, this.replayFrom(session.buffer, lastEventId, res), lastEventId, res);
      return;
    }
    // With Redis the authoritative buffer is the shared one: the frames may
    // have been written by whichever pod held the stream before. Live frames
    // that arrive while it is read wait in the queue so they land after the
    // replay, in order.
    const queue: BufferedEvent[] = [];
    session.replayQueue = queue;
    try {
      const shared = await this.readShared(session.id);
      if (session.stream === res && !res.destroyed) {
        const result = this.replayFrom(shared ?? session.buffer, lastEventId, res);
        // The stream has now seen everything in the shared buffer up to its
        // end: adopt it locally so a queued frame the replay already wrote
        // is not written again.
        if (shared && result === 'replayed') session.buffer = shared.slice(-workerReplayMax());
        this.replayOrReport(session, result, lastEventId, res);
      }
    } finally {
      // A newer stream may have taken over the queue while this one read.
      if (session.replayQueue === queue) {
        session.replayQueue = null;
        for (const entry of queue) this.writeFrame(session, entry);
      }
    }
  }

  /** After a replay: when the id aged out, say so on the stream. */
  private replayOrReport(
    session: StreamableSession,
    result: 'replayed' | 'unavailable',
    lastEventId: string,
    res: Response,
  ): void {
    if (result !== 'unavailable') return;
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

  /**
   * Server-side push of an envelope to a session's open stream. Buffered
   * for replay regardless of whether a stream is currently open, so a
   * disconnected client that reconnects with Last-Event-ID gets the
   * messages it missed. With Redis the buffer is shared, so the reconnect
   * may land on any pod.
   */
  push<T>(sessionId: string, type: WorkerEnvelope['type'], payload: T, correlationId?: string): WorkerEnvelope<T> | null {
    const local = this.sessions.get(sessionId);
    const holdsStream = !!(local && local.stream && !local.stream.destroyed);
    if (this.redis) {
      // This pod builds the frame and records it in the shared replay buffer.
      // If it holds the live stream it writes the frame itself; otherwise the
      // stream may live on another pod, so the frame is published and the
      // holder writes it. (Offline is already checked by the caller via the
      // RunnerSession table before push.)
      const env: WorkerEnvelope<T> = local
        ? this.envelope(local, type, payload, correlationId)
        : {
            v: WORKER_PROTOCOL_VERSION,
            type,
            id: correlationId ?? `${sessionId}:${randomUUID().slice(0, 8)}`,
            ts: Date.now(),
            payload,
          };
      const entry: BufferedEvent = { id: env.id, seq: env.seq ?? 0, frame: this.formatEvent(env.id, type, env) };
      if (holdsStream) {
        this.appendShared(sessionId, entry);
        this.writeFrame(local!, entry);
      } else {
        // type/payload/correlationId stay in the message for a pod that
        // predates the shared buffer and builds its own frame.
        this.appendShared(
          sessionId,
          entry,
          JSON.stringify({ sessionId, type, payload, correlationId, id: entry.id, seq: entry.seq, frame: entry.frame }),
        );
      }
      return env;
    }
    // No Redis: buffer locally for replay if the session exists here (and
    // write it if the stream is open), else report not-deliverable.
    if (!local) return null;
    return this.deliverLocal(local, type, payload, correlationId);
  }

  /** Build, buffer, and write an envelope to a locally-held session's stream. */
  private deliverLocal<T>(session: StreamableSession, type: WorkerEnvelope['type'], payload: T, correlationId?: string): WorkerEnvelope<T> {
    const env = this.envelope(session, type, payload, correlationId);
    const entry: BufferedEvent = { id: env.id, seq: env.seq!, frame: this.formatEvent(env.id, type, env) };
    if (this.redis) this.appendShared(session.id, entry);
    this.writeFrame(session, entry);
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

  /**
   * Nest calls this when the context closes (a pod shutting down, a spec's
   * moduleRef.close()). The constructor opened a subscriber connection and
   * nothing else ever closed it, so a closed context kept a live socket:
   * the app-boot integration spec passed and then jest never exited.
   */
  async onModuleDestroy(): Promise<void> {
    await this.shutdown();
  }

  async shutdown(): Promise<void> {
    if (this.gcInterval) clearInterval(this.gcInterval);
    if (this.subscriber) {
      // disconnect, not quit: quit is a command, and ioredis holds commands
      // while it is reconnecting, so quitting a subscriber whose Redis is
      // gone would wait for as long as Redis stays gone.
      try { this.subscriber.disconnect(); } catch { /* */ }
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
    const session: StreamableSession = {
      id,
      stream: null,
      organizationId,
      userId,
      seq: 0,
      buffer: [],
      replayQueue: null,
      lastActivity: new Date(),
    };
    this.sessions.set(id, session);
    this.sessionMintedHere.add(id);
    this.registerSession(session); // cross-pod registry (no-op without redis)
    return session;
  }

  /**
   * Is `userId` the user this session was minted for? A session minted
   * without a user (none today; every route in front of this transport
   * is JWT-guarded) is not bound to one.
   */
  private sameUser(session: StreamableSession, userId: string | undefined): boolean {
    if (!session.userId) return true;
    return session.userId === userId;
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
      replayQueue: null,
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
    const max = workerReplayMax();
    while (session.buffer.length > max) {
      session.buffer.shift();
    }
  }

  /**
   * Write a frame to the session's open stream and keep it in the local
   * replay buffer. While a reconnect is replaying from the shared buffer
   * the frame waits in `replayQueue`, so live frames never jump ahead of
   * the replayed ones; with Redis, a frame the replay already wrote is not
   * written twice. (Without Redis there is no replay to overlap with, and
   * every frame is written as it always was.)
   */
  private writeFrame(session: StreamableSession, entry: BufferedEvent): void {
    if (session.replayQueue) {
      session.replayQueue.push(entry);
      return;
    }
    if (this.redis && session.buffer.some((e) => e.id === entry.id)) return;
    this.buffer(session, entry.id, entry.seq, entry.frame);
    if (session.stream && !session.stream.destroyed) {
      try {
        this.writeRaw(session.stream, entry.frame);
      } catch (err: any) {
        this.logger.warn(`stream write failed for session=${session.id}: ${err.message}`);
        session.stream = null;
      }
    }
  }

  /**
   * Record a frame in the session's shared replay buffer (bounded, with a
   * TTL refreshed on every frame), then optionally publish to CH_OUT. One
   * MULTI, so the frame is in the buffer before any pod can hear of it: a
   * stream that reconnects in between replays it rather than missing it.
   */
  private appendShared(sessionId: string, entry: BufferedEvent, publish?: string): void {
    const key = `${SHARED_BUFFER_PREFIX}${sessionId}`;
    const tx = this.redis!
      .multi()
      .rpush(key, JSON.stringify(entry))
      .ltrim(key, -workerReplayMax(), -1)
      .expire(key, workerReplayTtlSeconds());
    if (publish !== undefined) tx.publish(CH_OUT, publish);
    tx.exec().catch((err) => this.logger.warn(`replay buffer write failed: ${err?.message ?? err}`));
  }

  /** The shared replay buffer, oldest first; null when Redis cannot be read. */
  private async readShared(sessionId: string): Promise<BufferedEvent[] | null> {
    try {
      const raw = await this.redis!.lrange(`${SHARED_BUFFER_PREFIX}${sessionId}`, 0, -1);
      const out: BufferedEvent[] = [];
      for (const item of raw) {
        try {
          const e = JSON.parse(item);
          if (e && typeof e.id === 'string' && typeof e.frame === 'string') out.push(e);
        } catch { /* skip a corrupt entry */ }
      }
      return out;
    } catch (err: any) {
      this.logger.warn(`replay buffer read failed: ${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * Returns 'replayed' on success (even if zero events were replayed,
   * which is the case when the client is already up to date), or
   * 'unavailable' if the requested event id has aged out of the buffer.
   */
  private replayFrom(
    buffer: readonly BufferedEvent[],
    lastEventId: string,
    res: Response,
  ): 'replayed' | 'unavailable' {
    const idx = buffer.findIndex((e) => e.id === lastEventId);
    if (idx === -1) {
      // Two cases: the buffer is empty (nothing was sent yet, client
      // is reconnecting on a stale token) or the id aged out. Treat
      // both as unavailable; the client will decide how to recover.
      return buffer.length === 0 ? 'replayed' : 'unavailable';
    }
    for (let i = idx + 1; i < buffer.length; i++) {
      this.writeRaw(res, buffer[i].frame);
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

  /**
   * Worker-shaped: carries a protocol version field at all. A `v` this
   * server does not speak is still a worker client and gets a worker
   * MALFORMED_ENVELOPE error rather than a JSON-RPC one — which is why
   * this is `'v' in body` and not `v === WORKER_PROTOCOL_VERSION`; the
   * exact-version check is `isWorkerEnvelope`.
   */
  private looksLikeEnvelope(body: unknown): boolean {
    return !!body && typeof body === 'object' && !Array.isArray(body) && 'v' in (body as any);
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
      // the live stream. Other pods ignore it. The sender built the frame
      // and put it in the shared replay buffer already, so the holder writes
      // that exact frame (same id a later Last-Event-ID names). A message
      // without a frame is from a pod that predates the shared buffer.
      const { sessionId, type, payload, correlationId, id, frame } = parsed;
      const session = this.sessions.get(sessionId);
      if (!session || !session.stream || session.stream.destroyed) return;
      if (typeof id === 'string' && typeof frame === 'string') {
        this.writeFrame(session, { id, seq: Number(parsed.seq) || 0, frame });
      } else {
        this.deliverLocal(session, type, payload, correlationId);
      }
    } else if (channel === CH_RESP) {
      // A response/error from any pod; re-emit locally so the pod with the
      // matching pending dispatch call resolves it (load-and-delete dedups).
      // The session it was posted on travels with it: the dispatcher only
      // accepts a response from the session of the runner it asked.
      const envelope = parsed?.envelope;
      const origin = parsed?.session;
      if (!envelope || !origin?.id) return;
      this.emit('envelope', envelope, {
        id: String(origin.id),
        organizationId: String(origin.organizationId ?? ''),
        userId: origin.userId ?? undefined,
      });
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
          // And forget that we minted it.
          //
          // sessionMintedHere was only ever added to: the GC dropped the
          // session but not this entry, so the Set grew monotonically for
          // the pod's lifetime. Every client that POSTs without a live
          // session id mints one, and the stale window is five minutes,
          // so reconnect churn is the normal case rather than the
          // exception.
          this.sessionMintedHere.delete(id);
          this.logger.log(`gc removed stale session ${id}`);
        }
      }
    }, 60_000);
    // Don't pin the event loop in tests / graceful shutdown.
    this.gcInterval.unref?.();
  }
}
