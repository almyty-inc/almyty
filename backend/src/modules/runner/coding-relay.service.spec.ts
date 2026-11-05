import { EventEmitter } from 'events';

import { CodingRelayService } from './coding-relay.service';
import { WorkerStreamTransport } from './transport/worker-stream.transport';
import { WORKER_ERROR_CODES, WORKER_PROTOCOL_VERSION, WorkerEnvelope } from '../mcp/types/worker-protocol.types';

/**
 * CodingRelayService: maps event envelopes from a runner's streamable
 * session to per-runner subscribers. runner.hello primes the session ->
 * runner cache; unmapped sessions fall back to the RunnerSession table.
 */
function env(payload: unknown): WorkerEnvelope {
  return {
    v: WORKER_PROTOCOL_VERSION,
    type: 'event',
    id: 'e1',
    ts: Date.now(),
    payload,
  } as WorkerEnvelope;
}

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

describe('CodingRelayService', () => {
  let transport: EventEmitter & { off: any };
  let runners: {
    runnerIdForSession: jest.Mock;
    isOwnedBy: jest.Mock;
  };
  let relay: CodingRelayService;

  beforeEach(() => {
    transport = new EventEmitter() as any;
    runners = {
      runnerIdForSession: jest.fn().mockResolvedValue(null),
      // Every runner in these tests lives in org-1 and belongs to
      // owner-1; a hello arriving on a session of any other organization
      // or any other user is a claim on someone else's machine.
      isOwnedBy: jest.fn(
        async (_runnerId: string, organizationId: string, userId: string) =>
          organizationId === 'org-1' && userId === 'owner-1',
      ),
    };
    relay = new CodingRelayService(runners as any, transport as any);
  });

  afterEach(() => {
    relay.onModuleDestroy();
  });

  it('relays coding.output to the runner mapped via runner.hello', async () => {
    const received: any[] = [];
    relay.subscribe('r1', (e) => received.push(e));

    transport.emit('envelope', env({ kind: 'runner.hello', runnerId: 'r1' }), { id: 'sess1', organizationId: 'org-1', userId: 'owner-1' });
    await flush();
    transport.emit(
      'envelope',
      env({ kind: 'coding.output', sessionId: 'cs_1', data: 'hi\n', seq: 1 }),
      { id: 'sess1', organizationId: 'org-1', userId: 'owner-1' },
    );
    await flush();

    expect(received).toEqual([
      { kind: 'coding.output', sessionId: 'cs_1', data: 'hi\n', seq: 1 },
    ]);
  });

  it('falls back to the RunnerSession table for unmapped sessions', async () => {
    runners.runnerIdForSession.mockResolvedValue('r2');
    const received: any[] = [];
    relay.subscribe('r2', (e) => received.push(e));

    transport.emit(
      'envelope',
      env({ kind: 'coding.exit', sessionId: 'cs_9', exitCode: 0, signal: null }),
      { id: 'sess9', organizationId: 'org-1', userId: 'owner-1' },
    );
    await flush();

    expect(runners.runnerIdForSession).toHaveBeenCalledWith('sess9');
    expect(received).toHaveLength(1);
    expect(received[0].kind).toBe('coding.exit');
  });

  it('drops coding events it cannot map to a runner', async () => {
    const received: any[] = [];
    relay.subscribe('r1', (e) => received.push(e));

    transport.emit(
      'envelope',
      env({ kind: 'coding.output', sessionId: 'cs_1', data: 'x' }),
      { id: 'unknown-sess', organizationId: 'org-1', userId: 'owner-1' },
    );
    await flush();
    expect(received).toHaveLength(0);
  });

  it('ignores non-event envelopes, non-coding kinds, and session-less re-emits', async () => {
    const received: any[] = [];
    relay.subscribe('r1', (e) => received.push(e));
    transport.emit('envelope', env({ kind: 'runner.hello', runnerId: 'r1' }), { id: 's1', organizationId: 'org-1', userId: 'owner-1' });
    await flush();

    transport.emit('envelope', { ...env({ kind: 'coding.output', sessionId: 'cs_1' }), type: 'heartbeat' }, { id: 's1', organizationId: 'org-1', userId: 'owner-1' });
    transport.emit('envelope', env({ kind: 'runner.draining' }), { id: 's1', organizationId: 'org-1', userId: 'owner-1' });
    transport.emit('envelope', env({ kind: 'coding.output', sessionId: 'cs_1', data: 'x' }), undefined);
    transport.emit('envelope', env({ kind: 'coding.output' }), { id: 's1', organizationId: 'org-1', userId: 'owner-1' }); // no sessionId
    await flush();

    expect(received).toHaveLength(0);
  });

  it('does not cross-deliver between runners', async () => {
    const r1: any[] = [];
    const r2: any[] = [];
    relay.subscribe('r1', (e) => r1.push(e));
    relay.subscribe('r2', (e) => r2.push(e));

    transport.emit('envelope', env({ kind: 'runner.hello', runnerId: 'r1' }), { id: 's1', organizationId: 'org-1', userId: 'owner-1' });
    transport.emit('envelope', env({ kind: 'runner.hello', runnerId: 'r2' }), { id: 's2', organizationId: 'org-1', userId: 'owner-1' });
    await flush();
    transport.emit('envelope', env({ kind: 'coding.output', sessionId: 'cs_a', data: '1' }), { id: 's1', organizationId: 'org-1', userId: 'owner-1' });
    transport.emit('envelope', env({ kind: 'coding.output', sessionId: 'cs_b', data: '2' }), { id: 's2', organizationId: 'org-1', userId: 'owner-1' });
    await flush();

    expect(r1).toHaveLength(1);
    expect(r1[0].sessionId).toBe('cs_a');
    expect(r2).toHaveLength(1);
    expect(r2[0].sessionId).toBe('cs_b');
  });

  it('unsubscribe detaches the listener', async () => {
    const received: any[] = [];
    const unsub = relay.subscribe('r1', (e) => received.push(e));
    expect(relay.listenerCount('r1')).toBe(1);
    unsub();
    expect(relay.listenerCount('r1')).toBe(0);

    transport.emit('envelope', env({ kind: 'runner.hello', runnerId: 'r1' }), { id: 's1', organizationId: 'org-1', userId: 'owner-1' });
    await flush();
    transport.emit('envelope', env({ kind: 'coding.output', sessionId: 'cs_1', data: 'x' }), { id: 's1', organizationId: 'org-1', userId: 'owner-1' });
    await flush();
    expect(received).toHaveLength(0);
  });

  /**
   * The runner id in a hello is whatever the daemon wrote there; the
   * session's organization is what its bearer token proved. A session
   * in org-2 announcing itself as org-1's runner must not be cached
   * against it, or the attacker's coding.output lands on the victim's
   * SSE channel and shows up in their chat window as if their own
   * machine had produced it.
   */
  it('refuses a runner.hello claiming a runner in another organization', async () => {
    const received: any[] = [];
    relay.subscribe('r1', (e) => received.push(e));

    transport.emit('envelope', env({ kind: 'runner.hello', runnerId: 'r1' }), {
      id: 'attacker-sess',
      organizationId: 'org-2',
      userId: 'attacker',
    });
    await flush();

    transport.emit(
      'envelope',
      env({ kind: 'coding.output', sessionId: 'cs_1', data: 'rm -rf /\n' }),
      { id: 'attacker-sess', organizationId: 'org-2', userId: 'attacker' },
    );
    await flush();

    expect(runners.isOwnedBy).toHaveBeenCalledWith('r1', 'org-2', 'attacker');
    expect(received).toHaveLength(0);
  });

  /**
   * Same organization, different user. Checking the organization alone
   * let another member of the org bind their session to the owner's
   * runner and inject output into the owner's coding session.
   */
  it('refuses a runner.hello from another member of the same organization', async () => {
    const received: any[] = [];
    relay.subscribe('r1', (e) => received.push(e));

    transport.emit('envelope', env({ kind: 'runner.hello', runnerId: 'r1' }), {
      id: 'colleague-sess',
      organizationId: 'org-1',
      userId: 'colleague',
    });
    await flush();
    transport.emit(
      'envelope',
      env({ kind: 'coding.output', sessionId: 'cs_1', data: 'forged\n' }),
      { id: 'colleague-sess', organizationId: 'org-1', userId: 'colleague' },
    );
    await flush();

    expect(runners.isOwnedBy).toHaveBeenCalledWith('r1', 'org-1', 'colleague');
    expect(received).toHaveLength(0);
  });
});
/**
 * subscribeSession with Redis: the session's backlog stream decides the
 * order, a published pointer only makes the viewer read on. A tiny
 * in-memory stand-in for the commands the relay uses; pointers are fed in
 * by hand through the subscriber's `pmessage`.
 */
describe('CodingRelayService.subscribeSession (Redis)', () => {
  const KEY = 'coding:evt:r1:cs_1';
  let stream: Array<[string, string[]]>;
  let subscriber: EventEmitter & { psubscribe: jest.Mock; disconnect: jest.Mock };
  let gate: Promise<void> | null;
  let failReads: boolean;
  let reads: number;
  let relay: CodingRelayService;

  const out = (n: number) => ({ kind: 'coding.output', sessionId: 'cs_1', data: `line ${n}\n`, seq: n });
  const append = (n: number): string => {
    const id = `1700000000000-${n}`;
    stream.push([id, ['event', JSON.stringify(out(n))]]);
    return id;
  };
  const announce = (id: string, n: number) =>
    subscriber.emit('pmessage', 'coding:evt:*', 'coding:evt:r1', JSON.stringify({ id, event: out(n) }));
  const seq = (id: string) => Number(id.split('-')[1]);
  /** Hold back the replies of the reads started from now on. */
  const hold = (): (() => void) => {
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    return release;
  };

  beforeEach(() => {
    stream = [];
    gate = null;
    failReads = false;
    reads = 0;
    subscriber = Object.assign(new EventEmitter(), {
      psubscribe: jest.fn().mockResolvedValue(1),
      disconnect: jest.fn(),
    });
    const redis = {
      duplicate: () => subscriber,
      // The snapshot is taken when the command runs; `gate` holds back only
      // the reply, the way a slow round trip does.
      xrange: jest.fn(async (key: string, start: string) => {
        reads += 1;
        const after = start === '-' ? -1 : seq(start.slice(1));
        const snapshot = key === KEY ? stream.filter(([id]) => seq(id) > after) : [];
        if (gate) await gate;
        if (failReads) throw new Error('redis down');
        return snapshot;
      }),
    };
    relay = new CodingRelayService({} as any, new EventEmitter() as any, redis as any);
  });

  afterEach(() => relay.onModuleDestroy());

  it('a late viewer gets the backlog, then live output, when pointers arrive during the replay and out of order', async () => {
    append(1);
    const release = hold();
    const seen: string[] = [];
    relay.subscribeSession('r1', 'cs_1', (e) => seen.push(e.data!));
    // The backlog read has run (it saw line 1) and its reply is in flight.
    // Meanwhile two pods append 2, 3 and 4, and 4's pointer lands first.
    const ids = [append(2), append(3), append(4)];
    gate = null;
    announce(ids[2], 4);
    announce(ids[0], 2);
    announce(ids[1], 3);
    release();
    await flush();
    await flush();

    expect(seen).toEqual(['line 1\n', 'line 2\n', 'line 3\n', 'line 4\n']);
  });

  it('delivers an event once when its pointer arrives after the backlog read already had it', async () => {
    const one = append(1);
    const seen: string[] = [];
    relay.subscribeSession('r1', 'cs_1', (e) => seen.push(e.data!));
    await flush();
    announce(one, 1);
    const two = append(2);
    announce(two, 2);
    announce(two, 2);
    await flush();
    await flush();

    expect(seen).toEqual(['line 1\n', 'line 2\n']);
  });

  it('resumes after Last-Event-ID and passes each entry id on', async () => {
    const one = append(1);
    const two = append(2);
    const three = append(3);
    const seen: Array<[string, string | undefined]> = [];
    relay.subscribeSession('r1', 'cs_1', (e, id) => seen.push([e.data!, id]), one);
    await flush();

    expect(seen).toEqual([['line 2\n', two], ['line 3\n', three]]);
  });

  it('coalesces a burst of pointers into one further read', async () => {
    const release = hold();
    const seen: string[] = [];
    relay.subscribeSession('r1', 'cs_1', (e) => seen.push(e.data!));
    for (let n = 1; n <= 5; n++) announce(append(n), n);
    gate = null;
    release();
    await flush();
    await flush();

    expect(seen).toEqual([1, 2, 3, 4, 5].map((n) => `line ${n}\n`));
    expect(reads).toBe(2);
  });

  it('when the backlog cannot be read, sends the announced events in stream order', async () => {
    failReads = true;
    const release = hold();
    const seen: string[] = [];
    relay.subscribeSession('r1', 'cs_1', (e) => seen.push(e.data!));
    const ids = [append(1), append(2)];
    gate = null;
    announce(ids[1], 2);
    announce(ids[0], 1);
    release();
    await flush();
    await flush();

    expect(seen).toEqual(['line 1\n', 'line 2\n']);
  });

  it('stops delivering once unsubscribed', async () => {
    append(1);
    const release = hold();
    const seen: string[] = [];
    const off = relay.subscribeSession('r1', 'cs_1', (e) => seen.push(e.data!));
    off();
    release();
    await flush();

    expect(seen).toEqual([]);
    expect(relay.listenerCount('r1')).toBe(0);
  });
});

/**
 * A runner's POST of coding output is answered only once the event is in
 * the session's backlog: the runner sends its next POST only after that
 * answer, so the backlog's order is the order it sent them in, whichever
 * pods they land on. A failed append is a 503 the runner retries, and
 * nothing is delivered for it, so the retry is the only copy.
 */
describe('CodingRelayService acknowledging a runner POST (Redis)', () => {
  const ORG = 'org-1';
  const USER = 'owner-1';
  let transport: WorkerStreamTransport;
  let relay: CodingRelayService;
  let appends: Array<{ args: unknown[]; settle: { resolve: (v: unknown) => void; reject: (e: unknown) => void } }>;
  let redis: { duplicate: () => any; eval: jest.Mock; publish: jest.Mock; xrange: jest.Mock };

  const post = (body: unknown, sid?: string) => {
    const res: any = {
      statusCode: 0,
      ended: false,
      jsonBody: undefined as any,
      headers: {} as Record<string, string>,
      setHeader(k: string, v: string) { res.headers[k] = v; },
      status(code: number) { res.statusCode = code; return res; },
      json(b: unknown) { res.jsonBody = b; res.ended = true; return res; },
      end() { res.ended = true; return res; },
    };
    const req: any = { header: (n: string) => (n === 'Mcp-Session-Id' ? sid : undefined), body };
    return { res, done: transport.handlePost(req, res, ORG, USER) };
  };
  const output = (id: string, seq: number) => ({
    v: WORKER_PROTOCOL_VERSION,
    type: 'event',
    id,
    ts: Date.now(),
    payload: { kind: 'coding.output', sessionId: 'cs_1', data: `line ${seq}\n`, seq },
  });

  beforeEach(async () => {
    appends = [];
    const subscriber = Object.assign(new EventEmitter(), {
      psubscribe: jest.fn().mockResolvedValue(1),
      disconnect: jest.fn(),
    });
    redis = {
      duplicate: () => subscriber,
      eval: jest.fn(
        (...args: unknown[]) => new Promise((resolve, reject) => appends.push({ args, settle: { resolve, reject } })),
      ),
      publish: jest.fn().mockResolvedValue(1),
      xrange: jest.fn().mockResolvedValue([]),
    };
    transport = new WorkerStreamTransport();
    relay = new CodingRelayService(
      { isOwnedBy: jest.fn().mockResolvedValue(true), runnerIdForSession: jest.fn().mockResolvedValue('r1') } as any,
      transport,
      redis as any,
    );
  });

  afterEach(async () => {
    relay.onModuleDestroy();
    await transport.shutdown();
  });

  async function session(): Promise<string> {
    const { res, done } = post({ ...output('hb', 0), type: 'heartbeat', payload: {} });
    await done;
    return res.headers['Mcp-Session-Id'];
  }

  it('answers 202 only after the append to the backlog has landed', async () => {
    const sid = await session();
    const { res, done } = post(output('env-1', 1), sid);
    await flush();
    await flush();

    expect(appends).toHaveLength(1);
    expect(appends[0].args[2]).toBe('coding:evt:r1:cs_1');
    expect(appends[0].args[5]).toBe('env-1'); // the envelope id, for the retry check
    expect(res.ended).toBe(false); // the append is still in flight

    appends[0].settle.resolve(['1700000000000-1', 0]);
    await done;
    expect(res.statusCode).toBe(202);
    expect(redis.publish).toHaveBeenCalledWith(
      'coding:evt:r1',
      JSON.stringify({ id: '1700000000000-1', event: output('env-1', 1).payload }),
    );
  });

  it('answers 503 when the append fails, and delivers nothing for that attempt', async () => {
    const sid = await session();
    const seen: unknown[] = [];
    relay.subscribe('r1', (e) => seen.push(e));
    const { res, done } = post(output('env-1', 1), sid);
    await flush();
    await flush();
    appends[0].settle.reject(new Error('redis down'));
    await done;

    expect(res.statusCode).toBe(503);
    expect(res.jsonBody.payload.code).toBe(WORKER_ERROR_CODES.INTERNAL);
    expect(redis.publish).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it('does not publish a retry the append script found already appended', async () => {
    const sid = await session();
    const { res, done } = post(output('env-1', 1), sid);
    await flush();
    await flush();
    appends[0].settle.resolve(['1700000000000-1', 1]);
    await done;

    expect(res.statusCode).toBe(202);
    expect(redis.publish).not.toHaveBeenCalled();
  });
});
