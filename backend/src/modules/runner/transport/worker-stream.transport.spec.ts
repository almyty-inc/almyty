import { Test } from '@nestjs/testing';
import { getRedisConnectionToken } from '@nestjs-modules/ioredis';
import { Request, Response } from 'express';
import { EventEmitter } from 'events';

import { WorkerStreamTransport } from './worker-stream.transport';
import { WORKER_PROTOCOL_VERSION, WORKER_ERROR_CODES } from '../../mcp/types/worker-protocol.types';

/**
 * Each test exercises one specific behavior of the worker stream. No
 * coverage padding: if a test isn't pinning a real failure mode, it isn't
 * here. Moved from mcp/transports/streamable-http.transport.spec.ts with the
 * class; the session, replay and multi-replica assertions are unchanged.
 * Sessions are minted with a heartbeat envelope where they used to be
 * minted with a JSON-RPC ping, which this channel no longer carries.
 */
describe('WorkerStreamTransport', () => {
  let transport: WorkerStreamTransport;
  /** Every envelope the transport emitted, as the runner services see them. */
  let emitted: Array<{ env: any; session: any }>;

  /** A heartbeat envelope: what a runner posts to open its session. */
  const hb = (id: number | string) => ({
    v: WORKER_PROTOCOL_VERSION,
    type: 'heartbeat' as const,
    id: `hb-${id}`,
    ts: Date.now(),
    payload: {},
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [WorkerStreamTransport],
    }).compile();
    transport = moduleRef.get(WorkerStreamTransport);
    emitted = [];
    transport.on('envelope', (env, session) => emitted.push({ env, session }));
  });

  afterEach(async () => {
    await transport.shutdown();
  });

  // ── helpers ─────────────────────────────────────────────────────────

  function mockReq(headers: Record<string, string> = {}, body: unknown = undefined): Request {
    return {
      header: (name: string) => headers[name] ?? headers[name.toLowerCase()],
      body,
    } as unknown as Request;
  }

  function mockRes() {
    const events = new EventEmitter();
    const writes: string[] = [];
    const headers: Record<string, string> = {};
    let statusCode = 200;
    let ended = false;
    let jsonBody: unknown;

    const res: any = {
      headersSent: false,
      destroyed: false,
      setHeader: (k: string, v: string) => { headers[k] = v; },
      getHeader: (k: string) => headers[k],
      flushHeaders: jest.fn(),
      status(code: number) { statusCode = code; return this; },
      json(body: unknown) { jsonBody = body; return this; },
      end() { ended = true; return this; },
      write(chunk: string) { writes.push(chunk); return true; },
      on: events.on.bind(events),
      emit: events.emit.bind(events),
      // helpers visible only to the test
      _writes: writes,
      _headers: headers,
      get _statusCode() { return statusCode; },
      get _ended() { return ended; },
      get _jsonBody() { return jsonBody; },
      get _events() { return events; },
    };
    return res as Response & { _writes: string[]; _headers: Record<string, string>; _statusCode: number; _ended: boolean; _jsonBody: any; _events: EventEmitter };
  }

  function parseEventFrames(raw: string[]): { id: string; event: string; data: any }[] {
    return raw
      .map(frame => {
        const id = /^id: (.+)$/m.exec(frame)?.[1] ?? '';
        const event = /^event: (.+)$/m.exec(frame)?.[1] ?? '';
        const data = /^data: (.+)$/m.exec(frame)?.[1] ?? '';
        return { id, event, data: data ? JSON.parse(data) : undefined };
      });
  }

  // ── POST: MCP is not served here ─────────────────────────────────

  // The split: JSON-RPC (MCP) has its own endpoints, and a JSON-RPC body on
  // the worker channel is refused with the worker error, not dispatched.
  it.each([
    ['a JSON-RPC request', { jsonrpc: '2.0', id: 1, method: 'tools/list' }],
    ['a JSON-RPC notification', { jsonrpc: '2.0', method: 'notifications/initialized' }],
    ['a JSON-RPC batch', [{ jsonrpc: '2.0', id: 1, method: 'ping' }]],
    ['an unrecognized body', { hello: 'world' }],
  ])('POST with %s is refused with MALFORMED_ENVELOPE and emits nothing', async (_label, body) => {
    const res = mockRes();
    await transport.handlePost(mockReq({}, body), res, 'org', 'user');

    expect(res._statusCode).toBe(400);
    expect(res._jsonBody.payload.code).toBe(WORKER_ERROR_CODES.MALFORMED_ENVELOPE);
    expect(emitted).toHaveLength(0);
  });

  // ── POST: worker envelope dispatch ──────────────────────────────────

  it('POST with a worker envelope emits an envelope event and returns 202', async () => {
    const onEnvelope = jest.fn();
    transport.on('envelope', onEnvelope);

    const env = {
      v: WORKER_PROTOCOL_VERSION,
      type: 'request' as const,
      id: 'req-1',
      ts: Date.now(),
      payload: { method: 'process.spawn', args: ['echo', 'hi'] },
    };
    const res = mockRes();
    await transport.handlePost(mockReq({}, env), res, 'org', 'user');

    expect(onEnvelope).toHaveBeenCalledTimes(1);
    expect(onEnvelope.mock.calls[0][0]).toMatchObject({ id: 'req-1', type: 'request' });
    expect(res._statusCode).toBe(202);
  });

  it('POST with a malformed envelope (wrong v) returns a typed error, not 500', async () => {
    const env = { v: 999, type: 'request', id: 'x', ts: Date.now(), payload: {} };
    const res = mockRes();
    await transport.handlePost(mockReq({}, env), res, 'org', 'user');

    expect(res._statusCode).toBe(400);
    expect(res._jsonBody.payload.code).toBe(WORKER_ERROR_CODES.MALFORMED_ENVELOPE);
  });

  // ── Sessions ─────────────────────────────────────────────────────────

  it('POST without Mcp-Session-Id mints a fresh session and echoes the id', async () => {
    const res = mockRes();
    await transport.handlePost(mockReq({}, hb(1)), res, 'org');
    const sid = res._headers['Mcp-Session-Id'];
    expect(sid).toMatch(/^sh_/);
    expect(transport.getStats().sessions).toBe(1);
  });

  it('POST with a known Mcp-Session-Id reuses the existing session', async () => {
    const r1 = mockRes();
    await transport.handlePost(mockReq({}, hb(1)), r1, 'org');
    const sid = r1._headers['Mcp-Session-Id'];
    const r2 = mockRes();
    await transport.handlePost(mockReq({ 'Mcp-Session-Id': sid }, hb(2)), r2, 'org');
    expect(r2._headers['Mcp-Session-Id']).toBe(sid);
    expect(transport.getStats().sessions).toBe(1);
  });

  it('POST with a known Mcp-Session-Id from a different org refuses with UNKNOWN_SESSION (no cross-tenant reuse)', async () => {
    const r1 = mockRes();
    await transport.handlePost(mockReq({}, hb(1)), r1, 'org-a', 'user-a');
    const sid = r1._headers['Mcp-Session-Id'];

    const r2 = mockRes();
    await transport.handlePost(mockReq({ 'Mcp-Session-Id': sid }, hb(2)), r2, 'org-b', 'user-b');

    expect(r2._statusCode).toBe(404);
    expect(r2._jsonBody.payload.code).toBe(WORKER_ERROR_CODES.UNKNOWN_SESSION);
    // The original session must NOT be hijacked or re-orged.
    expect(emitted).toHaveLength(1);
    expect(emitted[0].session.organizationId).toBe('org-a');
  });

  // MCP 2025-03-26 Streamable HTTP: an unrecognised Mcp-Session-Id is a 404,
  // which is how a client learns its session is gone and it must
  // re-initialise. Minting a session under the requested id instead meant a
  // client kept a dead id alive forever, losing all state behind a 200.
  it('POST with an unknown Mcp-Session-Id returns 404 and does NOT invent the session', async () => {
    const res = mockRes();

    await transport.handlePost(
      mockReq({ 'Mcp-Session-Id': 'sh_totally-unknown-session' }, hb(1)),
      res, 'org', 'user',
    );

    expect(res._statusCode).toBe(404);
    expect(res._jsonBody.payload.code).toBe(WORKER_ERROR_CODES.UNKNOWN_SESSION);
    expect(transport.getStats().sessions).toBe(0);
    expect(transport.getSession('sh_totally-unknown-session')).toBeUndefined();
    // The envelope itself must not have been accepted under a phantom session.
    expect(emitted).toHaveLength(0);
  });

  it('POST and GET agree: a session id neither half knows is 404 on both', async () => {
    const post = mockRes();
    await transport.handlePost(
      mockReq({ 'Mcp-Session-Id': 'sh_gc-swept-me' }, hb(1)),
      post, 'org', 'user',
    );
    const get = mockRes();
    await transport.handleStream(mockReq({ 'Mcp-Session-Id': 'sh_gc-swept-me' }), get, 'org');

    expect(post._statusCode).toBe(404);
    expect(get._statusCode).toBe(404);
  });

  // ── GET stream + Last-Event-ID replay ───────────────────────────────

  it('GET without Mcp-Session-Id returns 404 with UNKNOWN_SESSION', () => {
    const res = mockRes();
    transport.handleStream(mockReq({}), res, 'org');
    expect(res._statusCode).toBe(404);
    expect(res._jsonBody.payload.code).toBe(WORKER_ERROR_CODES.UNKNOWN_SESSION);
  });

  it('GET refuses cross-tenant session reuse (different org returns UNKNOWN_SESSION)', async () => {
    const r1 = mockRes();
    await transport.handlePost(mockReq({}, hb(1)), r1, 'org-a');
    const sid = r1._headers['Mcp-Session-Id'];

    const r2 = mockRes();
    transport.handleStream(mockReq({ 'Mcp-Session-Id': sid }), r2, 'org-b');
    expect(r2._statusCode).toBe(404);
  });

  it('push() writes formatted SSE frame with id+event+data and increments seq', async () => {
    const r1 = mockRes();
    await transport.handlePost(mockReq({}, hb(1)), r1, 'org');
    const sid = r1._headers['Mcp-Session-Id'];

    const r2 = mockRes();
    transport.handleStream(mockReq({ 'Mcp-Session-Id': sid }), r2, 'org');

    transport.push(sid, 'event', { hello: 'world' });
    transport.push(sid, 'event', { goodbye: 'moon' });

    const frames = parseEventFrames(r2._writes);
    expect(frames).toHaveLength(2);
    expect(frames[0].event).toBe('event');
    expect(frames[0].data.payload).toEqual({ hello: 'world' });
    expect(frames[0].data.seq).toBe(1);
    expect(frames[1].data.seq).toBe(2);
  });

  it('mid-stream disconnect + reconnect with Last-Event-ID replays missed events', async () => {
    const r1 = mockRes();
    await transport.handlePost(mockReq({}, hb(1)), r1, 'org');
    const sid = r1._headers['Mcp-Session-Id'];

    // Open stream, push two, "disconnect", push two more, reconnect with
    // Last-Event-ID set to the last seen id, expect to receive the two
    // missed events on the new stream.
    const stream1 = mockRes();
    transport.handleStream(mockReq({ 'Mcp-Session-Id': sid }), stream1, 'org');
    transport.push(sid, 'event', { n: 1 });
    transport.push(sid, 'event', { n: 2 });
    const seenFrames = parseEventFrames(stream1._writes);
    const lastSeenId = seenFrames[seenFrames.length - 1].id;

    // Simulate disconnect.
    stream1._events.emit('close');

    transport.push(sid, 'event', { n: 3 });
    transport.push(sid, 'event', { n: 4 });

    // Reconnect with Last-Event-ID.
    const stream2 = mockRes();
    transport.handleStream(mockReq({ 'Mcp-Session-Id': sid, 'Last-Event-ID': lastSeenId }), stream2, 'org');
    const replayed = parseEventFrames(stream2._writes);
    expect(replayed.map(f => f.data.payload)).toEqual([{ n: 3 }, { n: 4 }]);
  });

  it('reconnect with an aged-out Last-Event-ID emits REPLAY_UNAVAILABLE error event', async () => {
    const r1 = mockRes();
    await transport.handlePost(mockReq({}, hb(1)), r1, 'org');
    const sid = r1._headers['Mcp-Session-Id'];

    // Push an event so the buffer is non-empty.
    const stream1 = mockRes();
    transport.handleStream(mockReq({ 'Mcp-Session-Id': sid }), stream1, 'org');
    transport.push(sid, 'event', { ok: true });
    stream1._events.emit('close');

    // Reconnect with an event id we never sent.
    const stream2 = mockRes();
    await transport.handleStream(mockReq({ 'Mcp-Session-Id': sid, 'Last-Event-ID': 'totally-fake-id' }), stream2, 'org');
    const frames = parseEventFrames(stream2._writes);
    expect(frames.find(f => f.event === 'error')?.data.payload.code).toBe(WORKER_ERROR_CODES.REPLAY_UNAVAILABLE);
  });

  // ── multi-replica: Redis-backed cross-pod delivery ──────────────────

  describe('with Redis (multi-replica)', () => {
    // A tiny in-process pub/sub + kv that models the slice of ioredis the
    // transport uses. duplicate() returns a subscriber bound to the same bus.
    //
    // `open` is the socket: disconnect() closes it at once, and a closed
    // subscriber hears nothing. With { down: true } Redis is unreachable, so
    // quit() -- a command -- waits in ioredis's offline queue for good.
    function makeRedisBus(opts: { down?: boolean } = {}) {
      const kv = new Map<string, string>();
      const lists = new Map<string, string[]>();
      const bus = new EventEmitter();
      bus.setMaxListeners(0);
      const clients: any[] = [];
      function makeClient(isSub = false): any {
        const subs = new Set<string>();
        const client: any = {
          isSub,
          open: true,
          async set(k: string, v: string) { kv.set(k, v); return 'OK'; },
          async get(k: string) { return kv.get(k) ?? null; },
          // Lists (the shared replay buffer) and MULTI, run in order at exec.
          rpush(k: string, v: string) { const l = lists.get(k) ?? []; l.push(v); lists.set(k, l); return l.length; },
          ltrim(k: string, start: number, stop: number) {
            const l = lists.get(k) ?? [];
            const from = start < 0 ? Math.max(l.length + start, 0) : start;
            const to = stop < 0 ? l.length + stop : stop;
            lists.set(k, l.slice(from, to + 1));
            return 'OK';
          },
          async lrange(k: string) { return [...(lists.get(k) ?? [])]; },
          expire() { return 1; },
          multi() {
            const ops: Array<() => unknown> = [];
            const tx: any = {
              rpush: (k: string, v: string) => { ops.push(() => client.rpush(k, v)); return tx; },
              ltrim: (k: string, a: number, b: number) => { ops.push(() => client.ltrim(k, a, b)); return tx; },
              expire: () => { ops.push(() => 1); return tx; },
              publish: (ch: string, msg: string) => { ops.push(() => bus.emit(ch, msg)); return tx; },
              exec: () => Promise.resolve(ops.map((op) => [null, op()])),
            };
            return tx;
          },
          async publish(ch: string, msg: string) { bus.emit(ch, msg); return 1; },
          async subscribe(...chs: string[]) { chs.forEach(c => subs.add(c)); return chs.length; },
          on(ev: string, cb: any) {
            if (ev === 'message') {
              bus.on('__any__', (ch: string, msg: string) => { if (client.open && subs.has(ch)) cb(ch, msg); });
            }
            return client;
          },
          quit() {
            if (opts.down) return new Promise(() => undefined);
            client.open = false;
            return Promise.resolve('OK');
          },
          disconnect() { client.open = false; },
          duplicate() { return makeClient(true); },
        };
        clients.push(client);
        return client;
      }
      // Route every channel emit through a single '__any__' fan so subscribers
      // can filter by their subscribed set.
      const origEmit = bus.emit.bind(bus);
      bus.emit = ((ch: string, msg: string) => origEmit('__any__', ch, msg)) as any;
      const main = makeClient(false);
      main.subscribers = () => clients.filter((c) => c.isSub);
      return main;
    }

    function makeTransport(redis: any) {
      return new WorkerStreamTransport(redis);
    }

    async function nestTransport(redis: any) {
      const moduleRef = await Test.createTestingModule({
        providers: [
          WorkerStreamTransport,
          { provide: getRedisConnectionToken(), useValue: redis },
        ],
      }).compile();
      return moduleRef;
    }

    it('closing the Nest context closes the subscriber it opened (or jest and pods never exit)', async () => {
      const redis = makeRedisBus();
      const moduleRef = await nestTransport(redis);
      const [subscriber] = redis.subscribers();
      expect(subscriber.open).toBe(true);
      await moduleRef.close();
      expect(subscriber.open).toBe(false);
    });

    it('closing does not wait on a Redis that is gone', async () => {
      const redis = makeRedisBus({ down: true });
      const moduleRef = await nestTransport(redis);
      const [subscriber] = redis.subscribers();
      const closed = await Promise.race([
        moduleRef.close().then(() => 'closed'),
        new Promise((resolve) => setTimeout(() => resolve('still waiting'), 1000)),
      ]);
      expect(closed).toBe('closed');
      expect(subscriber.open).toBe(false);
    });

    it('adopts a session from the registry so a GET on another pod does not 404', async () => {
      const redis = makeRedisBus();
      // Pod A mints the session.
      const podA = makeTransport(redis);
      const reqA = mockReq({}, { v: WORKER_PROTOCOL_VERSION, type: 'event', id: 'e1', ts: 1, payload: { kind: 'runner.hello' } });
      const resA = mockRes();
      await podA.handlePost(reqA, resA, 'org', 'user');
      const sid = resA._headers['Mcp-Session-Id'];
      expect(sid).toBeTruthy();

      // Pod B (no local session) opens the GET stream — must adopt, not 404.
      const podB = makeTransport(redis);
      const resB = mockRes();
      await podB.handleStream(mockReq({ 'Mcp-Session-Id': sid }), resB, 'org', 'user');
      expect(resB._statusCode).not.toBe(404);
      expect(resB._headers['Content-Type']).toBe('text/event-stream');
      await podA.shutdown(); await podB.shutdown();
    });

    it('refuses another member of the same org the session, on the adopting pod too', async () => {
      const redis = makeRedisBus();
      const podA = makeTransport(redis);
      const resA = mockRes();
      await podA.handlePost(
        mockReq({}, { v: WORKER_PROTOCOL_VERSION, type: 'event', id: 'e1', ts: 1, payload: { kind: 'runner.hello' } }),
        resA, 'org', 'alice',
      );
      const sid = resA._headers['Mcp-Session-Id'];

      // Bob, same org, opens Alice's stream on another pod: he would
      // preempt her stream and receive her runner's dispatches.
      const podB = makeTransport(redis);
      const resStream = mockRes();
      await podB.handleStream(mockReq({ 'Mcp-Session-Id': sid }), resStream, 'org', 'bob');
      expect(resStream._headers['Content-Type']).not.toBe('text/event-stream');

      // ...or posts envelopes on it (a forged response to her dispatch).
      const emitted: unknown[] = [];
      podA.on('envelope', (env) => emitted.push(env));
      const resPost = mockRes();
      await podA.handlePost(
        mockReq({ 'Mcp-Session-Id': sid }, { v: WORKER_PROTOCOL_VERSION, type: 'event', id: 'e2', ts: 2, payload: { kind: 'runner.hello' } }),
        resPost, 'org', 'bob',
      );
      expect(emitted).toHaveLength(0);
      expect(resPost._statusCode).not.toBe(202);
      await podA.shutdown(); await podB.shutdown();
    });

    it('delivers a push from one pod to the stream held on another pod', async () => {
      const redis = makeRedisBus();
      const podA = makeTransport(redis); // will dispatch (push)
      const podB = makeTransport(redis); // holds the stream

      // Mint on A, then open the stream on B (adopts).
      const resMint = mockRes();
      await podA.handlePost(mockReq({}, { v: WORKER_PROTOCOL_VERSION, type: 'event', id: 'e', ts: 1, payload: {} }), resMint, 'org');
      const sid = resMint._headers['Mcp-Session-Id'];
      const streamB = mockRes();
      await podB.handleStream(mockReq({ 'Mcp-Session-Id': sid }), streamB, 'org');

      // Push from A (no local stream) -> must reach B's stream via Redis.
      podA.push(sid, 'request', { method: 'runner.info', params: {} }, 'corr-1');
      const frames = parseEventFrames(streamB._writes);
      expect(frames.some(f => f.data?.payload?.method === 'runner.info')).toBe(true);
      await podA.shutdown(); await podB.shutdown();
    });

    it('fans a response envelope to other pods so a remote pending call can match', async () => {
      const redis = makeRedisBus();
      const podA = makeTransport(redis);
      const podB = makeTransport(redis);
      // A listens for envelopes (its RunnerCallService would).
      const seenOnA: any[] = [];
      podA.on('envelope', (env) => seenOnA.push(env));

      // A response POST lands on B; A must see it via the CH_RESP fan-out.
      const resB = mockRes();
      await podB.handlePost(
        mockReq({}, { v: WORKER_PROTOCOL_VERSION, type: 'response', id: 'corr-1', ts: 1, payload: { ok: true } }),
        resB, 'org', 'user',
      );
      expect(seenOnA.some(e => e.id === 'corr-1' && e.type === 'response')).toBe(true);
      await podA.shutdown(); await podB.shutdown();
    });

    it('a reconnect with Last-Event-ID on another pod replays what the first pod wrote', async () => {
      const redis = makeRedisBus();
      const podA = makeTransport(redis);
      const podB = makeTransport(redis);
      const resMint = mockRes();
      await podA.handlePost(mockReq({}, hb(1)), resMint, 'org');
      const sid = resMint._headers['Mcp-Session-Id'];

      // Stream on A, two frames, drop; two more pushed while nobody holds it.
      const streamA = mockRes();
      await podA.handleStream(mockReq({ 'Mcp-Session-Id': sid }), streamA, 'org');
      podA.push(sid, 'event', { n: 1 });
      podA.push(sid, 'event', { n: 2 });
      const lastSeen = parseEventFrames(streamA._writes).pop()!.id;
      streamA._events.emit('close');
      podA.push(sid, 'event', { n: 3 });
      podB.push(sid, 'event', { n: 4 });

      // The runner reconnects to B, which never wrote any of them.
      const streamB = mockRes();
      await podB.handleStream(mockReq({ 'Mcp-Session-Id': sid, 'Last-Event-ID': lastSeen }), streamB, 'org');
      expect(parseEventFrames(streamB._writes).map(f => f.data.payload)).toEqual([{ n: 3 }, { n: 4 }]);

      // Live frames after the replay arrive once, in order.
      podA.push(sid, 'event', { n: 5 });
      expect(parseEventFrames(streamB._writes).map(f => f.data.payload)).toEqual([{ n: 3 }, { n: 4 }, { n: 5 }]);
      await podA.shutdown(); await podB.shutdown();
    });
  });
});
