/**
 * McpStdioMux — the multiplexer proper. Fans N sessions into ONE downstream
 * stdio MCP child:
 *   - rewrites each client request `id` to a global monotonic proxy id and
 *     reverse-maps {proxyId -> (sessionId, originalId)} so responses route back;
 *   - serializes stdin frames (write queue) so concurrent sessions can't
 *     interleave framing;
 *   - restores the original id on the way back and routes to the issuing session;
 *   - on downstream loss, errors every in-flight request and clears the map;
 *   - per-session teardown removes only that session's mappings.
 *
 * It owns NO process and NO socket — the supervisor hands it a Downstream and
 * the listener hands it Sessions. That keeps it fully unit-testable with fakes.
 *
 * Direction scope (v1): client->downstream requests/notifications and
 * downstream->client responses are fully multiplexed. downstream->client
 * messages that carry a `method` (server-initiated notifications/requests, e.g.
 * progress, sampling) are BROADCAST to all sessions — server-initiated requests
 * cannot be cleanly fanned to one client, so they are surfaced, not routed.
 */
import type { Downstream, Session, JsonRpcFrame, JsonRpcId, IdMapping, MuxOptions } from './types.js';
import { RPC } from './types.js';

const DEFAULT_TTL_MS = 300_000;
const DEFAULT_SWEEP_MS = 30_000;

export class McpStdioMux {
  private readonly idMap = new Map<number, IdMapping>();
  private proxyIdSeq = 0; // monotonic across the mux's life (incl. respawns)
  private readonly sessions = new Map<string, Session>();
  private downstream: Downstream | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  private readonly ttlMs: number;
  private readonly warn: (m: string) => void;

  constructor(opts: MuxOptions = {}) {
    this.ttlMs = opts.requestTtlMs ?? DEFAULT_TTL_MS;
    this.warn = opts.warn ?? ((m) => process.stderr.write(`[mcp-mux] ${m}\n`));
    const sweepMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_MS;
    this.sweepTimer = setInterval(() => this.sweep(), sweepMs);
    this.sweepTimer.unref?.();
  }

  /** In-flight request count (test/observability). */
  get inFlight(): number {
    return this.idMap.size;
  }
  get sessionCount(): number {
    return this.sessions.size;
  }

  // ── downstream wiring (called by the supervisor on spawn/respawn) ──

  setDownstream(downstream: Downstream): void {
    this.downstream = downstream;
    downstream.on('line', (line: string) => this.onDownstreamLine(line));
    downstream.once('exit', () => this.onDownstreamGone('downstream exited'));
    downstream.on('error', (e: Error) => this.warn(`downstream error: ${e?.message ?? e}`));
  }

  /** Called by the supervisor when the child is lost; errors all in-flight. */
  onDownstreamGone(reason: string): void {
    this.downstream = null;
    const affected = new Set<string>();
    for (const m of this.idMap.values()) affected.add(m.sessionId);
    this.idMap.clear();
    for (const sid of affected) {
      this.errorSession(sid, null, RPC.DOWNSTREAM_GONE, `downstream unavailable: ${reason}`);
    }
  }

  // ── session wiring (called by the listener) ──

  addSession(session: Session): void {
    this.sessions.set(session.id, session);
    session.on('frame', (frame: string) => this.onClientFrame(session.id, frame));
    session.once('close', () => this.teardownSession(session.id));
  }

  /** Per-session teardown: drop ONLY this session's mappings; never the child. */
  teardownSession(sessionId: string): void {
    for (const [proxyId, m] of this.idMap) {
      if (m.sessionId === sessionId) this.idMap.delete(proxyId);
    }
    this.sessions.delete(sessionId);
  }

  // ── client -> downstream ──

  private onClientFrame(sessionId: string, raw: string): void {
    if (this.closed) return;
    let frame: JsonRpcFrame;
    try {
      frame = JSON.parse(raw);
    } catch {
      this.errorSession(sessionId, null, RPC.PARSE_ERROR, 'invalid JSON frame');
      return;
    }

    // Notification (request without an id): forward verbatim, allocate nothing —
    // a mapping for something that never gets a response would leak forever.
    if (frame.id === undefined || frame.id === null) {
      void this.enqueueFrame(raw);
      return;
    }

    const proxyId = this.nextProxyId();
    this.idMap.set(proxyId, { sessionId, originalId: frame.id, sentAt: Date.now() });
    frame.id = proxyId;

    void this.enqueueFrame(JSON.stringify(frame)).catch(() => {
      // Write failed (downstream gone / EPIPE): free the mapping and tell the
      // client now rather than leaving it hung until the TTL sweep.
      if (this.idMap.delete(proxyId)) {
        this.errorSession(sessionId, frame.id as JsonRpcId, RPC.DOWNSTREAM_GONE, 'downstream write failed');
      }
    });
  }

  private nextProxyId(): number {
    if (this.proxyIdSeq >= Number.MAX_SAFE_INTEGER) {
      // ~9e15 ids into a single process life — practically unreachable, but a
      // wrap would alias live mappings, so refuse loudly instead.
      throw new Error('mcp-mux: proxy id space exhausted');
    }
    return ++this.proxyIdSeq;
  }

  /** Serialize frames to the downstream; resolves after the frame is flushed. */
  private enqueueFrame(frame: string): Promise<void> {
    const run = async () => {
      const ds = this.downstream;
      if (!ds) throw new Error('no downstream');
      await ds.write(frame);
    };
    // Chain so frames never interleave; isolate failures so the chain survives.
    this.writeChain = this.writeChain.then(run, run);
    return this.writeChain;
  }

  // ── downstream -> client ──

  private onDownstreamLine(line: string): void {
    let frame: JsonRpcFrame;
    try {
      frame = JSON.parse(line);
    } catch {
      this.warn(`unparseable downstream line dropped: ${line.slice(0, 120)}`);
      return;
    }

    // Server-initiated (has a method): notification or request. Can't be routed
    // to one session — broadcast and move on.
    if (typeof frame.method === 'string') {
      for (const s of this.sessions.values()) s.send(line);
      return;
    }

    // Otherwise it's a response: route by the proxy id.
    const proxyId = this.normalizeId(frame.id);
    if (proxyId === null) {
      this.warn('downstream response with non-numeric id dropped');
      return;
    }
    const mapping = this.idMap.get(proxyId);
    if (!mapping) {
      // Unknown or already-freed (duplicate/late) — drop, never double-route.
      this.warn(`downstream response for unknown id ${proxyId} dropped`);
      return;
    }
    this.idMap.delete(proxyId); // load-and-delete: a second response can't re-route

    frame.id = mapping.originalId; // restore the client's original id
    const session = this.sessions.get(mapping.sessionId);
    if (session) session.send(JSON.stringify(frame));
    // If the session is already gone, silently drop — its mappings were cleared
    // at teardown; this guards the late-arrival race.
  }

  private normalizeId(id: JsonRpcId | undefined): number | null {
    if (typeof id === 'number' && Number.isSafeInteger(id)) return id;
    if (typeof id === 'string' && /^\d+$/.test(id)) return Number(id); // tolerant of stringified ids
    return null;
  }

  // ── TTL sweep ──

  private sweep(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [proxyId, m] of this.idMap) {
      if (m.sentAt <= cutoff) {
        this.idMap.delete(proxyId);
        this.errorSession(m.sessionId, m.originalId, RPC.DOWNSTREAM_TIMEOUT, 'downstream did not respond in time');
      }
    }
  }

  private errorSession(sessionId: string, id: JsonRpcId, code: number, message: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
  }

  /** Stop sweeping + forget everything. Does not touch the downstream/sessions' sockets. */
  close(): void {
    this.closed = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    this.idMap.clear();
    this.sessions.clear();
    this.downstream = null;
  }
}
