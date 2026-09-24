import { EventEmitter } from 'events';

import { RunnerState } from '../../entities/runner.entity';
import { WorkspaceStatus } from '../../entities/workspace.entity';
import { WORKER_PROTOCOL_VERSION } from '../mcp/types/worker-protocol.types';
import { RunnerCallService, RUNNER_CALL_ERRORS } from './runner-call.service';
import { WorkspaceService } from '../workspace/workspace.service';
import { fakeRepository } from '../../test/fake-repository';

/**
 * A dispatch that names a workspace must name a live one of the caller's
 * on the runner it is going to.
 *
 * The workspaceId rode straight into the envelope. WorkspaceService.getOne
 * says it is "used by every dispatch path before routing"; nothing called
 * it, and the runner daemon only checks the id is a non-empty string. So a
 * released or TTL-expired workspace kept working (its TTL bounded nothing),
 * any made-up id was accepted, and a caller could file work under another
 * user's workspace or one pinned to a different runner.
 */
const RUNNER = 'runner-1';
const OWNER = 'owner-1';
const WS_ACTIVE = '11111111-1111-4111-8111-111111111111';
const WS_RELEASED = '22222222-2222-4222-8222-222222222222';
const WS_OTHER_RUNNER = '33333333-3333-4333-8333-333333333333';
const WS_EXPIRED_UNSWEPT = '44444444-4444-4444-8444-444444444444';
const WS_UNKNOWN = '55555555-5555-4555-8555-555555555555';
/** A runner that answers every request it is actually sent. */
class AnsweringTransport extends EventEmitter {
  pushed: any[] = [];
  push(sessionId: string, type: string, payload: any, correlationId?: string) {
    this.pushed.push({ sessionId, type, payload, correlationId });
    queueMicrotask(() =>
      this.emit('envelope', {
        v: WORKER_PROTOCOL_VERSION,
        type: 'response',
        id: correlationId,
        ts: Date.now(),
        payload: { ok: true, result: 'ran' },
      }),
    );
    return { v: WORKER_PROTOCOL_VERSION, type, id: correlationId, ts: Date.now(), payload };
  }
}

function build() {
  const transport = new AnsweringTransport();
  const runners = {
    async resolveForDispatch() {
      return { id: RUNNER, name: 'laptop', state: RunnerState.ONLINE, organizationId: 'org-1', ownerUserId: OWNER };
    },
    async getActiveSession() {
      return { runnerId: RUNNER, streamableSessionId: 'sh_1' };
    },
  };
  const base = { organizationId: 'org-1', ownerUserId: OWNER, runnerId: RUNNER, cwd: '/w', ttlAt: null };
  const workspaceRows = fakeRepository<any>([
    { ...base, id: WS_ACTIVE, status: WorkspaceStatus.ACTIVE, ttlAt: new Date(Date.now() + 60_000) },
    { ...base, id: WS_RELEASED, status: WorkspaceStatus.RELEASED },
    { ...base, id: WS_OTHER_RUNNER, status: WorkspaceStatus.ACTIVE, runnerId: 'runner-2' },
    { ...base, id: WS_EXPIRED_UNSWEPT, status: WorkspaceStatus.ACTIVE, ttlAt: new Date(Date.now() - 1_000) },
  ]);
  const workspaces = new WorkspaceService(workspaceRows as any, fakeRepository() as any);
  const svc = new RunnerCallService(runners as any, transport as any, workspaces);
  const run = (workspaceId: string, callerUserId: string | null = OWNER) =>
    svc.dispatch(RUNNER, 'shell.exec', { command: 'ls' }, workspaceId, { timeoutMs: 500, callerUserId });
  return { svc, transport, run };
}

describe('RunnerCallService.dispatch checks the workspace it is handed', () => {
  it('delivers work for the caller\'s own active workspace on that runner', async () => {
    const { transport, run } = build();
    await expect(run(WS_ACTIVE)).resolves.toEqual({ ok: true, result: 'ran' });
    // The verified workspace's root goes with it: the runner runs shell.exec there.
    expect(transport.pushed[0].payload).toEqual({
      method: 'shell.exec',
      params: { command: 'ls' },
      workspaceId: WS_ACTIVE,
      workspaceCwd: '/w',
    });
  });

  it.each([
    ['a released workspace', WS_RELEASED, OWNER],
    ['a workspace past its TTL the sweep has not reached yet', WS_EXPIRED_UNSWEPT, OWNER],
    ['a workspace pinned to another runner', WS_OTHER_RUNNER, OWNER],
    ['a workspace id that does not exist', WS_UNKNOWN, OWNER],
    ['something that is not a workspace id at all', 'anything', OWNER],
    ['another user\'s workspace', WS_ACTIVE, 'colleague'],
    ['a caller nobody identified', WS_ACTIVE, null],
  ])('refuses %s and sends nothing', async (_label, workspaceId, caller) => {
    const { transport, run } = build();
    await expect(run(workspaceId, caller)).rejects.toMatchObject({ code: RUNNER_CALL_ERRORS.WORKSPACE_NOT_FOUND });
    expect(transport.pushed).toHaveLength(0);
  });

  it('still dispatches workspace-less calls', async () => {
    const { svc, transport } = build();
    await expect(svc.dispatch(RUNNER, 'runner.info', {}, undefined, { timeoutMs: 500 })).resolves.toMatchObject({ ok: true });
    expect(transport.pushed[0].payload).toEqual({ method: 'runner.info', params: {} });
  });
});
