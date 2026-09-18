import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter } from 'events';

import { StreamableHttpTransport } from '../mcp/transports/streamable-http.transport';
import { WorkerEnvelope } from '../mcp/types/worker-protocol.types';
import { RunnerService } from './runner.service';

/**
 * A coding.* event as emitted by the runner daemon's CodingSessionManager
 * and relayed to backend subscribers (the per-session SSE endpoint).
 */
export interface CodingEvent {
  kind: string; // 'coding.output' | 'coding.exit'
  sessionId: string; // coding session id (cs_...)
  agent?: string;
  data?: string;
  seq?: number;
  exitCode?: number | null;
  signal?: string | null;
}

/**
 * Relay for coding.* event envelopes riding the runner's Streamable HTTP
 * session — the backend half of the chat-to-runner coding bridge.
 *
 * The runner daemon POSTs coding.output / coding.exit as unsolicited event
 * envelopes on the same wire heartbeats use. The transport emits them as
 * `envelope` events with the originating session attached; this service maps
 * session -> runner (runner.hello cache first, RunnerSession table fallback)
 * and re-emits per runner so SSE subscribers can stream them out.
 *
 * Multi-replica note: an event lands on whichever pod the runner's POST hit,
 * while the SSE subscriber may be on another pod. v1 relays pod-locally
 * (fine for single-replica and dev); cross-pod fanout would ride the same
 * Redis bridge the transport already has and is deliberately deferred.
 */

/**
 * Entries kept in the session -> runner cache.
 *
 * A miss costs one indexed lookup, so this can be small; it exists only
 * to keep the map from growing for the life of the pod.
 */
const SESSION_RUNNER_CACHE_MAX = 10_000;

/**
 * The transport hands each envelope the session it arrived on. `id` is
 * the streamable session id; `organizationId` is the tenant the bearer
 * token on that POST proved, and is the only trustworthy thing in the
 * pair -- everything inside the envelope payload was written by
 * whoever is holding the session.
 */
interface EnvelopeSession {
  id: string;
  organizationId: string;
}
@Injectable()
export class CodingRelayService implements OnModuleDestroy {
  private readonly logger = new Logger(CodingRelayService.name);
  private readonly emitter = new EventEmitter();
  /**
   * Fast local cache: streamable session id -> runner id (from runner.hello).
   *
   * Bounded, because nothing tells it when a session ends. The transport
   * that owns those ids garbage-collects its own map on a timer, and this
   * cache was never informed -- while a fresh entry lands on every
   * runner.hello, and the daemon re-mints a session on every session-lost,
   * which its own comments describe as routine against a multi-replica
   * backend. Entries are tiny, so this only bites a pod that stays up for
   * months; an LRU cap is the cheap way to make that impossible.
   */
  private readonly sessionRunners = new Map<string, string>();

  /** Re-insert on read so the Map's insertion order is a recency order. */
  private rememberSession(sessionId: string, runnerId: string): void {
    this.sessionRunners.delete(sessionId);
    this.sessionRunners.set(sessionId, runnerId);
    while (this.sessionRunners.size > SESSION_RUNNER_CACHE_MAX) {
      const oldest = this.sessionRunners.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.sessionRunners.delete(oldest);
    }
  }
  private readonly envelopeListener: (
    env: WorkerEnvelope,
    session?: EnvelopeSession,
  ) => void;

  constructor(
    private readonly runners: RunnerService,
    private readonly transport: StreamableHttpTransport,
  ) {
    this.envelopeListener = (env, session) => {
      void this.onEnvelope(env, session).catch((err) =>
        this.logger.warn(`coding envelope relay failed: ${err?.message ?? err}`),
      );
    };
    this.transport.on('envelope', this.envelopeListener);
    // One listener per open SSE subscription; lift the default cap.
    this.emitter.setMaxListeners(1000);
  }

  onModuleDestroy(): void {
    this.transport.off('envelope', this.envelopeListener);
    this.emitter.removeAllListeners();
  }

  /**
   * Subscribe to all coding.* events from one runner. Caller filters by
   * coding session id. Returns an unsubscribe function.
   */
  subscribe(runnerId: string, listener: (event: CodingEvent) => void): () => void {
    const channel = `coding:${runnerId}`;
    this.emitter.on(channel, listener);
    return () => this.emitter.off(channel, listener);
  }

  /** Visible for tests. */
  listenerCount(runnerId: string): number {
    return this.emitter.listenerCount(`coding:${runnerId}`);
  }

  private async onEnvelope(env: WorkerEnvelope, session?: EnvelopeSession): Promise<void> {
    if (env.type !== 'event') return;
    const payload = env.payload as
      | { kind?: string; runnerId?: string; sessionId?: string }
      | undefined;
    if (!payload?.kind) return;

    // Piggyback on runner.hello to learn the session -> runner mapping
    // without a DB round trip per event.
    //
    // The claimed runner id is checked against the organization the
    // session's bearer token proved, the same as in RunnerCallService.
    // Caching the claim unverified let a session in one organization
    // bind itself to another tenant's runner, and every coding.output
    // it then posted was relayed onto that runner's SSE channel -- so
    // the victim's chat window showed output the victim's machine
    // never produced.
    if (payload.kind === 'runner.hello' && payload.runnerId && session) {
      const owned = await this.runners.belongsToOrganization(
        payload.runnerId,
        session.organizationId,
      );
      if (!owned) {
        this.logger.warn(
          `runner.hello claiming runner ${payload.runnerId} refused: not in session's organization`,
        );
        return;
      }
      this.rememberSession(session.id, payload.runnerId);
      return;
    }
    if (!payload.kind.startsWith('coding.')) return;
    if (!session) return; // cross-pod re-emits carry no session; see class doc
    if (typeof payload.sessionId !== 'string' || payload.sessionId.length === 0) return;

    const runnerId =
      this.sessionRunners.get(session.id) ??
      (await this.runners.runnerIdForSession(session.id));
    if (!runnerId) {
      this.logger.debug(`coding event for unmapped session ${session.id} dropped`);
      return;
    }
    this.rememberSession(session.id, runnerId);
    this.emitter.emit(`coding:${runnerId}`, payload as CodingEvent);
  }
}
