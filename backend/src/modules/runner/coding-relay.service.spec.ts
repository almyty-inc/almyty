import { EventEmitter } from 'events';

import { CodingRelayService } from './coding-relay.service';
import { WORKER_PROTOCOL_VERSION, WorkerEnvelope } from '../mcp/types/worker-protocol.types';

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
  let runners: { runnerIdForSession: jest.Mock };
  let relay: CodingRelayService;

  beforeEach(() => {
    transport = new EventEmitter() as any;
    runners = { runnerIdForSession: jest.fn().mockResolvedValue(null) };
    relay = new CodingRelayService(runners as any, transport as any);
  });

  afterEach(() => {
    relay.onModuleDestroy();
  });

  it('relays coding.output to the runner mapped via runner.hello', async () => {
    const received: any[] = [];
    relay.subscribe('r1', (e) => received.push(e));

    transport.emit('envelope', env({ kind: 'runner.hello', runnerId: 'r1' }), { id: 'sess1' });
    await flush();
    transport.emit(
      'envelope',
      env({ kind: 'coding.output', sessionId: 'cs_1', data: 'hi\n', seq: 1 }),
      { id: 'sess1' },
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
      { id: 'sess9' },
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
      { id: 'unknown-sess' },
    );
    await flush();
    expect(received).toHaveLength(0);
  });

  it('ignores non-event envelopes, non-coding kinds, and session-less re-emits', async () => {
    const received: any[] = [];
    relay.subscribe('r1', (e) => received.push(e));
    transport.emit('envelope', env({ kind: 'runner.hello', runnerId: 'r1' }), { id: 's1' });
    await flush();

    transport.emit('envelope', { ...env({ kind: 'coding.output', sessionId: 'cs_1' }), type: 'heartbeat' }, { id: 's1' });
    transport.emit('envelope', env({ kind: 'runner.draining' }), { id: 's1' });
    transport.emit('envelope', env({ kind: 'coding.output', sessionId: 'cs_1', data: 'x' }), undefined);
    transport.emit('envelope', env({ kind: 'coding.output' }), { id: 's1' }); // no sessionId
    await flush();

    expect(received).toHaveLength(0);
  });

  it('does not cross-deliver between runners', async () => {
    const r1: any[] = [];
    const r2: any[] = [];
    relay.subscribe('r1', (e) => r1.push(e));
    relay.subscribe('r2', (e) => r2.push(e));

    transport.emit('envelope', env({ kind: 'runner.hello', runnerId: 'r1' }), { id: 's1' });
    transport.emit('envelope', env({ kind: 'runner.hello', runnerId: 'r2' }), { id: 's2' });
    await flush();
    transport.emit('envelope', env({ kind: 'coding.output', sessionId: 'cs_a', data: '1' }), { id: 's1' });
    transport.emit('envelope', env({ kind: 'coding.output', sessionId: 'cs_b', data: '2' }), { id: 's2' });
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

    transport.emit('envelope', env({ kind: 'runner.hello', runnerId: 'r1' }), { id: 's1' });
    await flush();
    transport.emit('envelope', env({ kind: 'coding.output', sessionId: 'cs_1', data: 'x' }), { id: 's1' });
    await flush();
    expect(received).toHaveLength(0);
  });
});
