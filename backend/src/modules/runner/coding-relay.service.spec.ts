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