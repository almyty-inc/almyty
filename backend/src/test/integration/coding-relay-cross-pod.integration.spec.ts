/**
 * Cross-pod coding relay and worker-stream replay, against a real Redis.
 *
 * Two "pods" here are two WorkerStreamTransport + CodingRelayService pairs,
 * each with its own ioredis connection to the same Redis, the way two API
 * replicas share one. The runner's POSTs, the viewer's SSE subscription
 * and a reconnect each land on whichever pod the test picks, so every
 * assertion is about delivery across the pair:
 *   - a viewer on one pod sees output that arrived on the other;
 *   - a viewer joining late gets the backlog, then live output;
 *   - a viewer resuming with Last-Event-ID on the other pod gets exactly
 *     what it missed;
 *   - back-to-back POSTs on the two pods land in the order they were sent,
 *     a retried one lands once, and one that cannot land is a 503;
 *   - the runner's own stream resumes with Last-Event-ID on the other pod;
 *   - the backlogs are bounded and expire per config.
 *
 * Requires RUN_DB_INTEGRATION=1 and a Redis at REDIS_HOST:REDIS_PORT
 * (default localhost:6379), like redis-streams.integration.spec.ts.
 */
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import type { Request, Response } from 'express';

import { WorkerStreamTransport } from '../../modules/runner/transport/worker-stream.transport';
import { CodingRelayService, CodingEvent } from '../../modules/runner/coding-relay.service';
import { WORKER_PROTOCOL_VERSION } from '../../modules/mcp/types/worker-protocol.types';

const SKIP = !process.env.RUN_DB_INTEGRATION;
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

function req(headers: Record<string, string>, body?: unknown): Request {
  return { header: (name: string) => headers[name], body } as unknown as Request;
}

function mockRes() {
  const events = new EventEmitter();
  const writes: string[] = [];
  const headers: Record<string, string> = {};
  const res: any = {
    destroyed: false,
    statusCode: 200,
    setHeader: (k: string, v: string) => { headers[k] = v; },
    flushHeaders: () => undefined,
    status(code: number) { res.statusCode = code; return res; },
    json() { return res; },
    end() { return res; },
    write(chunk: string) { writes.push(chunk); return true; },
    on: events.on.bind(events),
    _writes: writes,
    _headers: headers,
    _events: events,
  };
  return res as Response & { _writes: string[]; _headers: Record<string, string>; _events: EventEmitter; statusCode: number };
}

function frames(raw: string[]): { id: string; data: any }[] {
  return raw.map((f) => ({
    id: /^id: (.+)$/m.exec(f)?.[1] ?? '',
    data: JSON.parse(/^data: (.+)$/m.exec(f)?.[1] ?? 'null'),
  }));
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const envelope = (payload: unknown) => ({
  v: WORKER_PROTOCOL_VERSION,
  type: 'event' as const,
  id: randomUUID(),
  ts: Date.now(),
  payload,
});

interface Pod {
  redis: Redis;
  transport: WorkerStreamTransport;
  relay: CodingRelayService;
}

(SKIP ? describe.skip : describe)('cross-pod coding relay and stream replay (real Redis)', () => {
  const ORG = 'org-1';
  const USER = 'owner-1';
  let runnerId: string;
  let pods: Pod[] = [];
  let admin: Redis;

  // Every runner here belongs to ORG/USER. runner.hello reaches only the
  // pod it was posted to; a later POST on the other pod resolves the
  // runner through the RunnerSession table, which this stands in for.
  const runners = {
    isOwnedBy: async (_id: string, org: string, user?: string) => org === ORG && user === USER,
    runnerIdForSession: async () => runnerId,
  };

  /** `lookupMs` slows this pod's RunnerSession lookup, as a busy database does. */
  async function pod(opts: { lookupMs?: number } = {}): Promise<Pod> {
    const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: 1 });
    await redis.ping();
    const transport = new WorkerStreamTransport(redis as any);
    const lookupMs = opts.lookupMs ?? 0;
    const podRunners = lookupMs
      ? {
          ...runners,
          runnerIdForSession: async () => {
            await new Promise((r) => setTimeout(r, lookupMs));
            return runnerId;
          },
        }
      : runners;
    const relay = new CodingRelayService(podRunners as any, transport, redis as any);
    const p = { redis, transport, relay };
    pods.push(p);
    return p;
  }

  /**
   * The pattern subscriptions are asynchronous: publish a probe until every
   * pod's relay has heard one.
   */
  async function subscribed(): Promise<void> {
    const probe = randomUUID();
    const heard = new Set<number>();
    const offs = pods.map((p, i) => p.relay.subscribe(probe, () => heard.add(i)));
    const until = Date.now() + 3000;
    while (heard.size < pods.length) {
      if (Date.now() > until) throw new Error('pattern subscriptions never registered');
      await admin.publish(`coding:evt:${probe}`, JSON.stringify({ event: { kind: 'probe', sessionId: 'cs_probe' } }));
      await new Promise((r) => setTimeout(r, 20));
    }
    offs.forEach((off) => off());
  }

  /** Runner opens its session on `p` and says hello; returns the session id. */
  async function connectRunner(p: Pod): Promise<string> {
    const res = mockRes();
    await p.transport.handlePost(req({}, envelope({ kind: 'runner.hello', runnerId })), res, ORG, USER);
    const sid = res._headers['Mcp-Session-Id'];
    expect(sid).toBeTruthy();
    return sid;
  }

  async function postCoding(p: Pod, sid: string, payload: Partial<CodingEvent>): Promise<void> {
    const res = mockRes();
    await p.transport.handlePost(req({ 'Mcp-Session-Id': sid }, envelope(payload)), res, ORG, USER);
    expect(res.statusCode).toBe(202);
  }

  beforeAll(async () => {
    admin = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
    await admin.ping();
  });

  beforeEach(() => {
    runnerId = randomUUID();
  });

  afterEach(async () => {
    for (const p of pods) {
      p.relay.onModuleDestroy();
      await p.transport.shutdown();
      p.redis.disconnect();
    }
    pods = [];
    const keys = [
      ...(await admin.keys(`coding:evt:${runnerId}:*`)),
      ...(await admin.keys('strm:buf:*')),
    ];
    if (keys.length) await admin.del(...keys);
    delete process.env.CODING_RELAY_BACKLOG_TTL_S;
    delete process.env.WORKER_STREAM_REPLAY_MAX;
    delete process.env.WORKER_STREAM_REPLAY_TTL_S;
  });

  afterAll(async () => {
    await admin.quit();
  });

  it('a viewer on one pod gets output the runner posted to the other', async () => {
    const a = await pod();
    const b = await pod();
    await subscribed();
    const sid = await connectRunner(a);

    const seen: Array<[CodingEvent, string | undefined]> = [];
    const off = b.relay.subscribeSession(runnerId, 'cs_one', (e, id) => seen.push([e, id]));
    await new Promise((r) => setTimeout(r, 50)); // past the (empty) backlog read

    await postCoding(a, sid, { kind: 'coding.output', sessionId: 'cs_one', data: 'hello\n', seq: 1 });
    await postCoding(a, sid, { kind: 'coding.output', sessionId: 'cs_other', data: 'noise\n', seq: 1 });
    await postCoding(a, sid, { kind: 'coding.exit', sessionId: 'cs_one', exitCode: 0, signal: null });

    await waitFor(() => seen.length === 2);
    expect(seen.map(([e]) => e.kind)).toEqual(['coding.output', 'coding.exit']);
    expect(seen[0][0].data).toBe('hello\n');
    // Each carries its backlog id, which is what a reconnect sends back.
    expect(seen.every(([, id]) => /^\d+-\d+$/.test(id ?? ''))).toBe(true);
    off();
  });

  it('a viewer joining late on the other pod gets the backlog, then live output, once each', async () => {
    const a = await pod();
    const b = await pod();
    await subscribed();
    const sid = await connectRunner(a);

    for (let i = 1; i <= 3; i++) {
      await postCoding(a, sid, { kind: 'coding.output', sessionId: 'cs_late', data: `line ${i}\n`, seq: i });
    }
    // The runner's POSTs round-robin: the next one lands on B, which adopts the session.
    const seen: string[] = [];
    const off = b.relay.subscribeSession(runnerId, 'cs_late', (e) => seen.push(e.data ?? e.kind));
    await postCoding(b, sid, { kind: 'coding.output', sessionId: 'cs_late', data: 'line 4\n', seq: 4 });
    await waitFor(() => seen.length >= 4); // two pods append independently: order is per POST
    await postCoding(a, sid, { kind: 'coding.output', sessionId: 'cs_late', data: 'line 5\n', seq: 5 });

    await waitFor(() => seen.length >= 5);
    await new Promise((r) => setTimeout(r, 100)); // nothing arrives twice
    expect(seen).toEqual(['line 1\n', 'line 2\n', 'line 3\n', 'line 4\n', 'line 5\n']);
    off();
  });

  it('live output announced during the replay, out of order, still follows the backlog', async () => {
    await pod(); // a second pod, as in production
    const b = await pod();
    await subscribed();
    const key = `coding:evt:${runnerId}:cs_race`;
    const channel = `coding:evt:${runnerId}`;
    const line = (n: number) => ({ kind: 'coding.output', sessionId: 'cs_race', data: `line ${n}\n`, seq: n });
    const append = (n: number) => admin.xadd(key, '*', 'event', JSON.stringify(line(n))) as Promise<string>;
    const announce = (id: string, n: number) => admin.publish(channel, JSON.stringify({ id, event: line(n) }));

    // Line 1 is in the backlog before the viewer joins.
    await announce(await append(1), 1);
    await new Promise((r) => setTimeout(r, 50));

    // B's backlog read runs against Redis now; its reply is held back, the
    // way a slow round trip under load does.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const xrange = b.redis.xrange.bind(b.redis);
    let first = true;
    (b.redis as any).xrange = async (...args: any[]) => {
      const entries = await (xrange as any)(...args);
      if (first) {
        first = false;
        await held;
      }
      return entries;
    };
    const seen: string[] = [];
    const off = b.relay.subscribeSession(runnerId, 'cs_race', (e) => seen.push(e.data ?? e.kind));
    await b.redis.ping(); // the backlog read has run

    // Meanwhile lines 2-4 are appended, and the pods' announcements land
    // out of order: 4 first.
    const ids = [await append(2), await append(3), await append(4)];
    await announce(ids[2], 4);
    await announce(ids[0], 2);
    await announce(ids[1], 3);
    await new Promise((r) => setTimeout(r, 50)); // all three heard on B
    release();

    await waitFor(() => seen.length >= 4);
    await new Promise((r) => setTimeout(r, 100)); // nothing arrives twice
    expect(seen).toEqual(['line 1\n', 'line 2\n', 'line 3\n', 'line 4\n']);
    off();
  });

  it('a viewer resuming with Last-Event-ID on the other pod gets exactly what it missed', async () => {
    const a = await pod();
    const b = await pod();
    await subscribed();
    const sid = await connectRunner(a);

    const first: Array<[string, string | undefined]> = [];
    const offA = a.relay.subscribeSession(runnerId, 'cs_resume', (e, id) => first.push([e.data!, id]));
    await new Promise((r) => setTimeout(r, 50));
    await postCoding(a, sid, { kind: 'coding.output', sessionId: 'cs_resume', data: 'one', seq: 1 });
    await postCoding(a, sid, { kind: 'coding.output', sessionId: 'cs_resume', data: 'two', seq: 2 });
    await waitFor(() => first.length === 2);
    offA(); // the phone loses its connection
    const lastEventId = first[1][1]!;

    await postCoding(a, sid, { kind: 'coding.output', sessionId: 'cs_resume', data: 'three', seq: 3 });
    await postCoding(b, sid, { kind: 'coding.output', sessionId: 'cs_resume', data: 'four', seq: 4 });

    const resumed: string[] = [];
    const offB = b.relay.subscribeSession(runnerId, 'cs_resume', (e) => resumed.push(e.data!), lastEventId);
    await waitFor(() => resumed.length >= 2);
    await postCoding(a, sid, { kind: 'coding.output', sessionId: 'cs_resume', data: 'five', seq: 5 });
    await waitFor(() => resumed.length >= 3);
    await new Promise((r) => setTimeout(r, 100));
    expect(resumed).toEqual(['three', 'four', 'five']);
    offB();
  });

  it('back-to-back POSTs on two pods land in the backlog in the order the runner sent them', async () => {
    // A has not seen the runner's hello, so it looks the runner up first,
    // slowly; B answers straight from its cache. Each POST is sent only
    // after the answer to the one before, as the runner does.
    const a = await pod({ lookupMs: 150 });
    const b = await pod();
    await subscribed();
    const sid = await connectRunner(b);
    const seen: number[] = [];
    const off = b.relay.subscribeSession(runnerId, 'cs_order', (e) => seen.push(e.seq!));
    await new Promise((r) => setTimeout(r, 50));

    for (let n = 1; n <= 6; n++) {
      await postCoding(n % 2 ? a : b, sid, { kind: 'coding.output', sessionId: 'cs_order', data: `line ${n}\n`, seq: n });
    }

    const entries = await admin.xrange(`coding:evt:${runnerId}:cs_order`, '-', '+');
    expect(entries.map(([, fields]) => JSON.parse(fields[1]).seq)).toEqual([1, 2, 3, 4, 5, 6]);
    await waitFor(() => seen.length >= 6);
    expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
    off();
  });

  it('a retried POST whose first answer was lost is appended once', async () => {
    const a = await pod();
    const b = await pod();
    await subscribed();
    const sid = await connectRunner(a);
    const seen: string[] = [];
    const off = a.relay.subscribeSession(runnerId, 'cs_retry', (e) => seen.push(e.data!));
    await new Promise((r) => setTimeout(r, 50));

    const once = envelope({ kind: 'coding.output', sessionId: 'cs_retry', data: 'once', seq: 1 });
    for (const p of [a, b]) {
      const res = mockRes();
      await p.transport.handlePost(req({ 'Mcp-Session-Id': sid }, once), res, ORG, USER);
      expect(res.statusCode).toBe(202);
    }
    await postCoding(b, sid, { kind: 'coding.output', sessionId: 'cs_retry', data: 'next', seq: 2 });

    expect((await admin.xrange(`coding:evt:${runnerId}:cs_retry`, '-', '+')).length).toBe(2);
    await waitFor(() => seen.length >= 2);
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toEqual(['once', 'next']);
    off();
  });

  it('a POST whose append fails is answered 503 and nothing is delivered for it', async () => {
    const a = await pod();
    await subscribed();
    const sid = await connectRunner(a);
    const seen: string[] = [];
    const off = a.relay.subscribe(runnerId, (e) => seen.push(e.data!));
    // The backlog key is taken by a value of the wrong type: the append errors.
    await admin.set(`coding:evt:${runnerId}:cs_fail`, 'not a stream');

    const res = mockRes();
    await a.transport.handlePost(
      req({ 'Mcp-Session-Id': sid }, envelope({ kind: 'coding.output', sessionId: 'cs_fail', data: 'lost', seq: 1 })),
      res,
      ORG,
      USER,
    );
    expect(res.statusCode).toBe(503);
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toEqual([]);
    off();
  });

  it('the coding backlog expires per config', async () => {
    process.env.CODING_RELAY_BACKLOG_TTL_S = '120';
    const a = await pod();
    await subscribed();
    const sid = await connectRunner(a);
    await postCoding(a, sid, { kind: 'coding.output', sessionId: 'cs_ttl', data: 'x', seq: 1 });
    const key = `coding:evt:${runnerId}:cs_ttl`;
    const until = Date.now() + 3000;
    let ttl = -2;
    while (Date.now() < until) {
      ttl = await admin.ttl(key);
      if (ttl > 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120);
  });

  it("the runner's stream resumes with Last-Event-ID on the other pod", async () => {
    const a = await pod();
    const b = await pod();
    const mint = mockRes();
    await a.transport.handlePost(req({}, { ...envelope({}), type: 'heartbeat' }), mint, ORG, USER);
    const sid = mint._headers['Mcp-Session-Id'];

    const streamA = mockRes();
    await a.transport.handleStream(req({ 'Mcp-Session-Id': sid }), streamA, ORG, USER);
    a.transport.push(sid, 'request', { n: 1 });
    a.transport.push(sid, 'request', { n: 2 });
    await waitFor(() => streamA._writes.length === 2);
    const lastSeen = frames(streamA._writes)[1].id;
    streamA._events.emit('close');

    // Dispatched while no pod holds the stream, from either pod.
    a.transport.push(sid, 'request', { n: 3 });
    await a.redis.ping(); // A's write has landed: two connections have no order between them
    b.transport.push(sid, 'request', { n: 4 });
    await new Promise((r) => setTimeout(r, 50));

    const streamB = mockRes();
    await b.transport.handleStream(req({ 'Mcp-Session-Id': sid, 'Last-Event-ID': lastSeen }), streamB, ORG, USER);
    expect(frames(streamB._writes).map((f) => f.data.payload)).toEqual([{ n: 3 }, { n: 4 }]);

    // Live again: a push from A reaches B's stream once.
    a.transport.push(sid, 'request', { n: 5 });
    await waitFor(() => streamB._writes.length === 3);
    await new Promise((r) => setTimeout(r, 50));
    expect(frames(streamB._writes).map((f) => f.data.payload)).toEqual([{ n: 3 }, { n: 4 }, { n: 5 }]);
  });

  it('the shared replay buffer is bounded and expires per config', async () => {
    process.env.WORKER_STREAM_REPLAY_MAX = '3';
    process.env.WORKER_STREAM_REPLAY_TTL_S = '90';
    const a = await pod();
    const mint = mockRes();
    await a.transport.handlePost(req({}, { ...envelope({}), type: 'heartbeat' }), mint, ORG, USER);
    const sid = mint._headers['Mcp-Session-Id'];
    for (let n = 1; n <= 5; n++) a.transport.push(sid, 'request', { n });
    await a.redis.ping(); // the MULTIs ahead of it have run
    const key = `strm:buf:${sid}`;
    const kept = (await admin.lrange(key, 0, -1)).map((e) => JSON.parse(JSON.parse(e).frame.split('\ndata: ')[1]).payload.n);
    expect(kept).toEqual([3, 4, 5]);
    const ttl = await admin.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(90);
  });
});
