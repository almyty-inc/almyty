import { EventEmitter } from 'events';

import { Runner, RunnerState } from '../../entities/runner.entity';
import { RunnerSession } from '../../entities/runner-session.entity';
import { WORKER_PROTOCOL_VERSION, WorkerEnvelope } from '../mcp/types/worker-protocol.types';
import { RunnerCallService, RUNNER_CALL_ERRORS, RunnerCallError } from './runner-call.service';

class FakeTransport extends EventEmitter {
  pushed: Array<{ sessionId: string; type: string; payload: any; correlationId?: string }> = [];
  sessionExists = true;
  private waiters: Array<() => void> = [];
  push<T>(sessionId: string, type: WorkerEnvelope['type'], payload: T, correlationId?: string): WorkerEnvelope<T> | null {
    this.pushed.push({ sessionId, type, payload, correlationId });
    while (this.waiters.length > 0) this.waiters.shift()!();
    if (!this.sessionExists) return null;
    return {
      v: WORKER_PROTOCOL_VERSION,
      type,
      id: correlationId ?? 'auto',
      seq: this.pushed.length,
      ts: Date.now(),
      payload,
    };
  }
  /** Wait until the next push() call lands. */
  waitForPush(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  /** Helper to simulate a runner-side response or error envelope. */
  emitEnvelope(env: WorkerEnvelope, session?: { id: string; organizationId: string }): void {
    this.emit('envelope', env, session);
  }
}

class FakeRunnerService {
  runner: Runner = {
    id: 'runner-1',
    name: 'laptop',
    state: RunnerState.ONLINE,
  } as any;
  session: RunnerSession | null = {
    id: 'session-row-1',
    runnerId: 'runner-1',
    streamableSessionId: 'sh_session_1',
    connectedAt: new Date(),
    disconnectedAt: null,
    remoteAddress: null,
  } as any;
  resolveError: { status?: number; message: string } | null = null;
  async resolveForDispatch(_id: string): Promise<Runner> {
    if (this.resolveError) {
      const err: any = new Error(this.resolveError.message);
      err.status = this.resolveError.status;
      throw err;
    }
    return this.runner;
  }
  async getActiveSession(_id: string): Promise<RunnerSession | null> {
    return this.session;
  }
  // Liveness wiring spies.
  sessionConnects: Array<{ runnerId: string; sessionId: string }> = [];
  heartbeats: string[] = [];
  sessionToRunner: Record<string, string> = {};
  async onSessionConnect(runnerId: string, streamableSessionId: string): Promise<any> {
    this.sessionConnects.push({ runnerId, sessionId: streamableSessionId });
    this.sessionToRunner[streamableSessionId] = runnerId;
    return {};
  }
  async runnerIdForSession(streamableSessionId: string): Promise<string | null> {
    return this.sessionToRunner[streamableSessionId] ?? null;
  }
  async heartbeat(runnerId: string): Promise<Runner> {
    this.heartbeats.push(runnerId);
    return this.runner;
  }
}

/** Flush pending microtasks so fire-and-forget liveness handlers settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

function makeService() {
  const runners = new FakeRunnerService();
  const transport = new FakeTransport();
  const svc = new RunnerCallService(runners as any, transport as any);
  return { svc, runners, transport };
}

describe('RunnerCallService', () => {
  it('dispatch resolves with the matching response envelope', async () => {
    const { svc, transport } = makeService();
    const promise = svc.dispatch('runner-1', 'runner.info', {}, undefined, { timeoutMs: 1000 });
    await transport.waitForPush();
    const sent = transport.pushed[0];
    expect(sent.type).toBe('request');
    expect(sent.payload).toEqual({ method: 'runner.info', params: {} });
    transport.emitEnvelope({
      v: WORKER_PROTOCOL_VERSION,
      type: 'response',
      id: sent.correlationId!,
      ts: Date.now(),
      payload: { ok: true, result: { os: 'darwin' } },
    });
    await expect(promise).resolves.toEqual({ ok: true, result: { os: 'darwin' } });
    expect(svc.getPendingCount()).toBe(0);
  });

  it('dispatch with workspaceId tags the envelope payload', async () => {
    const { svc, transport } = makeService();
    const p = svc.dispatch('runner-1', 'shell.exec', { command: 'ls' }, 'ws-1', { timeoutMs: 200 });
    p.catch(() => {});
    await transport.waitForPush();
    expect(transport.pushed[0].payload).toEqual({
      method: 'shell.exec',
      params: { command: 'ls' },
      workspaceId: 'ws-1',
    });
    // Resolve to clean up
    transport.emitEnvelope({
      v: WORKER_PROTOCOL_VERSION,
      type: 'response',
      id: transport.pushed[0].correlationId!,
      ts: Date.now(),
      payload: { ok: true },
    });
    await p;
  });


  it('rejects with TIMEOUT when no response arrives in time', async () => {
    const { svc } = makeService();
    await expect(svc.dispatch('runner-1', 'runner.info', {}, undefined, { timeoutMs: 30 }))
      .rejects.toMatchObject({ code: RUNNER_CALL_ERRORS.TIMEOUT });
    expect(svc.getPendingCount()).toBe(0);
  });

  it('rejects with RUNNER_OFFLINE when there is no active session', async () => {
    const { svc, runners } = makeService();
    runners.session = null;
    await expect(svc.dispatch('runner-1', 'runner.info', {}))
      .rejects.toMatchObject({ code: RUNNER_CALL_ERRORS.RUNNER_OFFLINE });
  });

  it('rejects with RUNNER_OFFLINE when transport.push returns null (session GC raced)', async () => {
    const { svc, transport } = makeService();
    transport.sessionExists = false;
    await expect(svc.dispatch('runner-1', 'runner.info', {}, undefined, { timeoutMs: 50 }))
      .rejects.toMatchObject({ code: RUNNER_CALL_ERRORS.RUNNER_OFFLINE });
  });

  it('rejects with RUNNER_NOT_FOUND when resolveForDispatch throws 404', async () => {
    const { svc, runners } = makeService();
    runners.resolveError = { status: 404, message: 'runner not found' };
    await expect(svc.dispatch('missing', 'runner.info', {}))
      .rejects.toMatchObject({ code: RUNNER_CALL_ERRORS.RUNNER_NOT_FOUND });
  });

  it('rejects with RUNNER_OFFLINE when runner state is STALE', async () => {
    const { svc, runners } = makeService();
    runners.runner = { ...runners.runner, state: RunnerState.STALE } as any;
    await expect(svc.dispatch('runner-1', 'runner.info', {}))
      .rejects.toMatchObject({ code: RUNNER_CALL_ERRORS.RUNNER_OFFLINE });
  });

  it('surfaces error envelope as RUNNER_ERROR', async () => {
    const { svc, transport } = makeService();
    const p = svc.dispatch('runner-1', 'runner.info', {}, undefined, { timeoutMs: 1000 });
    await transport.waitForPush();
    transport.emitEnvelope({
      v: WORKER_PROTOCOL_VERSION,
      type: 'error',
      id: transport.pushed[0].correlationId!,
      ts: Date.now(),
      payload: { code: -32603, message: 'runner blew up' },
    });
    await expect(p).rejects.toMatchObject({
      code: RUNNER_CALL_ERRORS.RUNNER_ERROR,
      message: 'runner blew up',
    });
  });

  it('rejects when caller aborts before the response arrives', async () => {
    const { svc } = makeService();
    const ac = new AbortController();
    const p = svc.dispatch('runner-1', 'runner.info', {}, undefined, { timeoutMs: 5_000, signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: RUNNER_CALL_ERRORS.TRANSPORT });
  });

  it('rejects synchronously when signal is already aborted', async () => {
    const { svc } = makeService();
    const ac = new AbortController();
    ac.abort();
    await expect(svc.dispatch('runner-1', 'runner.info', {}, undefined, { signal: ac.signal }))
      .rejects.toMatchObject({ code: RUNNER_CALL_ERRORS.TRANSPORT });
  });

  it('drops late envelopes for already-resolved correlation ids', async () => {
    const { svc, transport } = makeService();
    const p = svc.dispatch('runner-1', 'runner.info', {}, undefined, { timeoutMs: 200 });
    await transport.waitForPush();
    const id = transport.pushed[0].correlationId!;
    transport.emitEnvelope({ v: WORKER_PROTOCOL_VERSION, type: 'response', id, ts: Date.now(), payload: { ok: true } });
    await p;
    // Late duplicate must not throw or affect pending count
    expect(() => transport.emitEnvelope({
      v: WORKER_PROTOCOL_VERSION,
      type: 'response',
      id,
      ts: Date.now(),
      payload: { ok: true },
    })).not.toThrow();
    expect(svc.getPendingCount()).toBe(0);
  });

  it('cleans up on module destroy', async () => {
    const { svc, transport } = makeService();
    // Start one dispatch and don't resolve it
    const p = svc.dispatch('runner-1', 'runner.info', {}, undefined, { timeoutMs: 5_000 });
    p.catch(() => {}); // suppress unhandled rejection during awaits
    await transport.waitForPush();
    expect(svc.getPendingCount()).toBe(1);
    svc.onModuleDestroy();
    expect(svc.getPendingCount()).toBe(0);
    expect(transport.listenerCount('envelope')).toBe(0);
    await expect(p).rejects.toBeInstanceOf(RunnerCallError);
  });

  // ── liveness wiring (regression: heartbeats were dropped → never online) ──

  it('runner.hello links the session to the runner', async () => {
    const { runners, transport } = makeService();
    transport.emitEnvelope(
      { v: WORKER_PROTOCOL_VERSION, type: 'event', id: 'e1', ts: Date.now(), payload: { kind: 'runner.hello', runnerId: 'runner-1' } },
      { id: 'sh_session_1', organizationId: 'org-1' },
    );
    await flush();
    expect(runners.sessionConnects).toEqual([{ runnerId: 'runner-1', sessionId: 'sh_session_1' }]);
  });

  it('heartbeat envelope updates the runner via the linked session', async () => {
    const { runners, transport } = makeService();
    // hello first to establish the session->runner link
    transport.emitEnvelope(
      { v: WORKER_PROTOCOL_VERSION, type: 'event', id: 'e1', ts: Date.now(), payload: { kind: 'runner.hello', runnerId: 'runner-1' } },
      { id: 'sh_session_1', organizationId: 'org-1' },
    );
    await flush();
    transport.emitEnvelope(
      { v: WORKER_PROTOCOL_VERSION, type: 'heartbeat', id: 'h1', ts: Date.now(), payload: { ts: Date.now(), inUse: 0 } },
      { id: 'sh_session_1', organizationId: 'org-1' },
    );
    await flush();
    expect(runners.heartbeats).toEqual(['runner-1']);
  });

  it('heartbeat resolves the runner from the DB when not cached (cross-replica)', async () => {
    const { runners, transport } = makeService();
    // No hello on THIS instance; the link exists only in the shared store.
    runners.sessionToRunner['sh_session_2'] = 'runner-1';
    transport.emitEnvelope(
      { v: WORKER_PROTOCOL_VERSION, type: 'heartbeat', id: 'h1', ts: Date.now(), payload: { ts: Date.now(), inUse: 0 } },
      { id: 'sh_session_2', organizationId: 'org-1' },
    );
    await flush();
    expect(runners.heartbeats).toEqual(['runner-1']);
  });

  it('heartbeat for an unmapped session is dropped without throwing', async () => {
    const { runners, transport } = makeService();
    transport.emitEnvelope(
      { v: WORKER_PROTOCOL_VERSION, type: 'heartbeat', id: 'h1', ts: Date.now(), payload: { ts: Date.now(), inUse: 0 } },
      { id: 'sh_unknown', organizationId: 'org-1' },
    );
    await flush();
    expect(runners.heartbeats).toEqual([]);
  });

  it('liveness envelopes are ignored when no session is provided', async () => {
    const { runners, transport } = makeService();
    transport.emitEnvelope({ v: WORKER_PROTOCOL_VERSION, type: 'heartbeat', id: 'h1', ts: Date.now(), payload: {} });
    await flush();
    expect(runners.heartbeats).toEqual([]);
    expect(runners.sessionConnects).toEqual([]);
  });
});
