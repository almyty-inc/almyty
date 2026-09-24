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
  emitEnvelope(env: WorkerEnvelope, session?: { id: string; organizationId: string; userId?: string }): void {
    this.emit('envelope', env, session);
  }
  /** A response/error posted on the dispatched runner's own session. */
  respond(env: WorkerEnvelope): void {
    this.emit('envelope', env, { id: 'sh_session_1', organizationId: 'org-1', userId: 'owner-1' });
  }
}

class FakeRunnerService {
  runner: Runner = {
    id: 'runner-1',
    name: 'laptop',
    state: RunnerState.ONLINE,
    organizationId: 'org-1',
    ownerUserId: 'owner-1',
  } as any;
  /** Which (runnerId, organizationId, userId) triples this fake was asked about. */
  membershipChecks: Array<{ runnerId: string; organizationId: string; userId?: string }> = [];
  async isOwnedBy(runnerId: string, organizationId: string, userId?: string): Promise<boolean> {
    this.membershipChecks.push({ runnerId, organizationId, userId });
    return runnerId === this.runner.id
      && organizationId === (this.runner as any).organizationId
      && userId === (this.runner as any).ownerUserId;
  }
  session: RunnerSession | null = {
    id: 'session-row-1',
    runnerId: 'runner-1',
    streamableSessionId: 'sh_session_1',
    connectedAt: new Date(),
    disconnectedAt: null,
    remoteAddress: null,
  } as any;
  resolveError: { status?: number; message: string } | null = null;
  resolveCallers: Array<string | null | undefined> = [];
  async resolveForDispatch(_id: string, callerUserId?: string | null): Promise<Runner> {
    this.resolveCallers.push(callerUserId);
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
  // The dispatched runner's session is bound to it (runner.hello ran).
  sessionToRunner: Record<string, string> = { sh_session_1: 'runner-1' };
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
/** Stands in for WorkspaceService.listActiveForRunner on the ack path. */
class FakeWorkspaceService {
  /** runnerId -> ids of workspaces still ACTIVE for it. */
  active: Record<string, string[]> = {};
  /** Live workspaces a dispatch may name, as (id, runnerId, ownerUserId). */
  owned: Array<{ id: string; runnerId: string; ownerUserId: string }> = [];
  /** When set, listActiveForRunner throws instead of answering. */
  failure: Error | null = null;
  calls: string[] = [];
  async listActiveForRunner(runnerId: string): Promise<Array<{ id: string }>> {
    this.calls.push(runnerId);
    if (this.failure) throw this.failure;
    return (this.active[runnerId] ?? []).map((id) => ({ id }));
  }
  async findForDispatch(id: string, runnerId: string, callerUserId?: string | null): Promise<{ id: string } | null> {
    return this.owned.find((w) => w.id === id && w.runnerId === runnerId && w.ownerUserId === callerUserId) ?? null;
  }
}

/** Flush pending microtasks so fire-and-forget liveness handlers settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

function makeService() {
  const runners = new FakeRunnerService();
  const transport = new FakeTransport();
  const workspaces = new FakeWorkspaceService();
  const svc = new RunnerCallService(runners as any, transport as any, workspaces as any);
  return { svc, runners, transport, workspaces };
}

describe('RunnerCallService', () => {
  it('dispatch resolves with the matching response envelope', async () => {
    const { svc, transport } = makeService();
    const promise = svc.dispatch('runner-1', 'runner.info', {}, undefined, { timeoutMs: 1000 });
    await transport.waitForPush();
    const sent = transport.pushed[0];
    expect(sent.type).toBe('request');
    expect(sent.payload).toEqual({ method: 'runner.info', params: {} });
    transport.respond({
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
    const { svc, transport, workspaces } = makeService();
    workspaces.owned.push({ id: 'ws-1', runnerId: 'runner-1', ownerUserId: 'owner-1' });
    const p = svc.dispatch('runner-1', 'shell.exec', { command: 'ls' }, 'ws-1', { timeoutMs: 200, callerUserId: 'owner-1' });
    p.catch(() => {});
    await transport.waitForPush();
    expect(transport.pushed[0].payload).toEqual({
      method: 'shell.exec',
      params: { command: 'ls' },
      workspaceId: 'ws-1',
    });
    // Resolve to clean up
    transport.respond({
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
    transport.respond({
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
    transport.respond({ v: WORKER_PROTOCOL_VERSION, type: 'response', id, ts: Date.now(), payload: { ok: true } });
    await p;
    // Late duplicate must not throw or affect pending count
    expect(() => transport.respond({
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
      { id: 'sh_session_1', organizationId: 'org-1', userId: 'owner-1' },
    );
    await flush();
    expect(runners.sessionConnects).toEqual([{ runnerId: 'runner-1', sessionId: 'sh_session_1' }]);
  });

  it('heartbeat envelope updates the runner via the linked session', async () => {
    const { runners, transport } = makeService();
    // hello first to establish the session->runner link
    transport.emitEnvelope(
      { v: WORKER_PROTOCOL_VERSION, type: 'event', id: 'e1', ts: Date.now(), payload: { kind: 'runner.hello', runnerId: 'runner-1' } },
      { id: 'sh_session_1', organizationId: 'org-1', userId: 'owner-1' },
    );
    await flush();
    transport.emitEnvelope(
      { v: WORKER_PROTOCOL_VERSION, type: 'heartbeat', id: 'h1', ts: Date.now(), payload: { ts: Date.now(), inUse: 0 } },
      { id: 'sh_session_1', organizationId: 'org-1', userId: 'owner-1' },
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
      { id: 'sh_session_2', organizationId: 'org-1', userId: 'owner-1' },
    );
    await flush();
    expect(runners.heartbeats).toEqual(['runner-1']);
  });

  it('heartbeat for an unmapped session is dropped without throwing', async () => {
    const { runners, transport } = makeService();
    transport.emitEnvelope(
      { v: WORKER_PROTOCOL_VERSION, type: 'heartbeat', id: 'h1', ts: Date.now(), payload: { ts: Date.now(), inUse: 0 } },
      { id: 'sh_unknown', organizationId: 'org-1', userId: 'owner-1' },
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

  // ── heartbeat ack: the workspace set the runner reconciles against ──

  /**
   * Server half of workspace cleanup. `killWorkspace` on the runner had
   * no production caller and `listActiveForRunner` here had none
   * either, so a released or expired workspace left its processes
   * running on the user's own machine forever. The heartbeat ack is the
   * loop that closes it, and it is a set rather than a release RPC so a
   * dropped message costs one beat rather than leaking permanently.
   */
  async function helloThenHeartbeat(
    t: ReturnType<typeof makeService>,
    heartbeatId = 'h1',
  ): Promise<void> {
    const session = { id: 'sh_session_1', organizationId: 'org-1', userId: 'owner-1' };
    t.transport.emitEnvelope(
      { v: WORKER_PROTOCOL_VERSION, type: 'event', id: 'e1', ts: Date.now(), payload: { kind: 'runner.hello', runnerId: 'runner-1' } },
      session,
    );
    await flush();
    t.transport.emitEnvelope(
      { v: WORKER_PROTOCOL_VERSION, type: 'heartbeat', id: heartbeatId, ts: Date.now(), payload: { ts: Date.now(), inUse: 1 } },
      session,
    );
    await flush();
  }

  it('acks a heartbeat with the active workspace set, correlated to that beat', async () => {
    const t = makeService();
    t.workspaces.active['runner-1'] = ['ws-a', 'ws-b'];

    await helloThenHeartbeat(t, 'hb-7');

    expect(t.workspaces.calls).toEqual(['runner-1']);
    const ack = t.transport.pushed.find((p) => p.type === 'heartbeat');
    expect(ack).toBeDefined();
    expect(ack!.sessionId).toBe('sh_session_1');
    expect(ack!.correlationId).toBe('hb-7');
    expect(ack!.payload.workspaces).toEqual({ active: ['ws-a', 'ws-b'] });
  });

  /**
   * An empty list is an answer, not a missing one: the backend looked
   * and the runner should be hosting nothing. The runner only tells the
   * two apart because they are structurally different on the wire, so
   * the empty case must still ship the `workspaces` key.
   */
  it('acks with an explicitly empty set when the runner has nothing active', async () => {
    const t = makeService();
    t.workspaces.active['runner-1'] = [];

    await helloThenHeartbeat(t);

    const ack = t.transport.pushed.find((p) => p.type === 'heartbeat');
    expect(ack!.payload.workspaces).toEqual({ active: [] });
  });

  /**
   * Fail-closed: if the set cannot be built, the ack must omit it
   * entirely rather than send an empty one. An empty set would tell the
   * runner to kill everything the user has running.
   */
  it('omits the workspace set entirely when it cannot be built', async () => {
    const t = makeService();
    t.workspaces.failure = new Error('db down');

    await helloThenHeartbeat(t);

    const ack = t.transport.pushed.find((p) => p.type === 'heartbeat');
    expect(ack).toBeDefined();
    expect(ack!.payload.workspaces).toBeUndefined();
    // The heartbeat itself still counted for liveness.
    expect(t.runners.heartbeats).toEqual(['runner-1']);
  });

  it('does not ack a heartbeat from a session with no runner behind it', async () => {
    const t = makeService();
    t.transport.emitEnvelope(
      { v: WORKER_PROTOCOL_VERSION, type: 'heartbeat', id: 'h1', ts: Date.now(), payload: { ts: Date.now() } },
      { id: 'sh_unknown', organizationId: 'org-1', userId: 'owner-1' },
    );
    await flush();
    expect(t.workspaces.calls).toEqual([]);
    expect(t.transport.pushed.filter((p) => p.type === 'heartbeat')).toEqual([]);
  });

  it('an undeliverable ack does not break heartbeat handling', async () => {
    const t = makeService();
    t.workspaces.active['runner-1'] = ['ws-a'];
    t.transport.sessionExists = false;

    await helloThenHeartbeat(t);

    expect(t.runners.heartbeats).toEqual(['runner-1']);
  });

  /**
   * The runner id travels inside the hello payload, which the holder of
   * the session writes; the organization travels on the session, which
   * the bearer token proved. A session in org-2 claiming org-1's runner
   * must not be linked to it: getActiveSession picks the most recently
   * connected session, so the link would immediately redirect every
   * dispatch for that runner -- agent.spawn, coding.start, shell
   * commands -- to the claimant's machine.
   */
  it('refuses a runner.hello claiming a runner in another organization', async () => {
    const { runners, transport } = makeService();
    transport.emitEnvelope(
      {
        v: WORKER_PROTOCOL_VERSION,
        type: 'event',
        id: 'e1',
        ts: Date.now(),
        payload: { kind: 'runner.hello', runnerId: 'runner-1' },
      },
      { id: 'sh_attacker', organizationId: 'org-2', userId: 'attacker' },
    );
    await flush();

    expect(runners.membershipChecks).toEqual([
      { runnerId: 'runner-1', organizationId: 'org-2', userId: 'attacker' },
    ]);
    expect(runners.sessionConnects).toEqual([]);

    // And the refused claim leaves no cached mapping behind, so a
    // heartbeat on the same session cannot keep the victim's runner
    // looking alive either.
    transport.emitEnvelope(
      { v: WORKER_PROTOCOL_VERSION, type: 'heartbeat', id: 'h1', ts: Date.now(), payload: {} },
      { id: 'sh_attacker', organizationId: 'org-2', userId: 'attacker' },
    );
    await flush();
    expect(runners.heartbeats).toEqual([]);
  });

  /**
   * Same organization, different user: a colleague who learns the
   * runner's id (it is shown on the runner's page to anyone who can see
   * the runner) must not be able to attach their own daemon's session
   * to it and take over its dispatches.
   */
  it('refuses a runner.hello from another member of the same organization', async () => {
    const { runners, transport } = makeService();
    transport.emitEnvelope(
      {
        v: WORKER_PROTOCOL_VERSION,
        type: 'event',
        id: 'e1',
        ts: Date.now(),
        payload: { kind: 'runner.hello', runnerId: 'runner-1' },
      },
      { id: 'sh_colleague', organizationId: 'org-1', userId: 'colleague' },
    );
    await flush();
    expect(runners.sessionConnects).toEqual([]);

    transport.emitEnvelope(
      { v: WORKER_PROTOCOL_VERSION, type: 'heartbeat', id: 'h1', ts: Date.now(), payload: {} },
      { id: 'sh_colleague', organizationId: 'org-1', userId: 'colleague' },
    );
    await flush();
    expect(runners.heartbeats).toEqual([]);
  });

  it('passes the caller through to resolveForDispatch', async () => {
    const { svc: service, runners, transport } = makeService();
    const pushed = transport.waitForPush();
    const call = service.dispatch('runner-1', 'runner.info', {}, undefined, { callerUserId: 'owner-1', timeoutMs: 50 });
    await pushed;
    await call.catch(() => undefined);
    expect(runners.resolveCallers).toEqual(['owner-1']);
  });
});