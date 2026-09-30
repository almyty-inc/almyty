import { NotFoundException } from '@nestjs/common';

import { Agent } from '../../entities/agent.entity';
import { RunnerIsolationTier, RunnerState } from '../../entities/runner.entity';
import { Workspace, WorkspaceStatus } from '../../entities/workspace.entity';
import { fakeManager, fakeRepository } from '../../test/fake-repository';
import { WorkspaceService } from '../workspace/workspace.service';
import { RunWorkspaceService, workspaceFolderName } from './run-workspace.service';
import { RunnerCallError, RUNNER_CALL_ERRORS } from './runner-call.service';

/**
 * An agent run that calls a runner tool needing a workspace, and names
 * none, gets one on that runner: the runner makes the folder, the row is
 * the run user's, attributed to the agent and run, and the rest of the run
 * reuses it. It is an ordinary workspace afterwards (release, TTL,
 * stranding), and a runner at its limit or unable to make the folder
 * fails the call with a sentence that says why.
 */
const ORG = 'org-1';
const USER = 'user-1';
const RUN = 'aaaabbbb-1111-4111-8111-111111111111';
const AGENT = 'agent-1';

function runner(overrides: Record<string, any> = {}) {
  return {
    id: 'runner-1',
    name: 'laptop',
    state: RunnerState.ONLINE,
    organizationId: ORG,
    ownerUserId: USER,
    labels: {},
    config: { defaultIsolation: RunnerIsolationTier.HOST, maxConcurrent: 2 },
    ...overrides,
  };
}

function build(opts: { runner?: any; prepare?: jest.Mock; seed?: any[] } = {}) {
  const workspaces = fakeRepository<Workspace>({ seed: opts.seed ?? [], idPrefix: 'ws' });
  const agents = fakeRepository<Agent>([{ id: AGENT, name: 'Support Bot', organizationId: ORG } as any]);
  fakeManager([[Workspace, workspaces], [Agent, agents]]);
  const theRunner = opts.runner ?? runner();
  const runners = {
    resolveForDispatch: jest.fn(async () => theRunner),
    resolveByLabels: jest.fn(async () => theRunner),
  };
  const prepare =
    opts.prepare ??
    jest.fn(async (_runnerId: string, _method: string, params: any) => ({ ok: true, result: { cwd: `/home/me/.almyty/workspaces/${params.name}` } }));
  const calls = { dispatch: prepare };
  const svc = new RunWorkspaceService(workspaces as any, agents as any, runners as any, calls as any);
  const acquire = (overrides: Record<string, any> = {}) =>
    svc.acquire({
      runnerId: 'runner-1',
      organizationId: ORG,
      runId: RUN,
      agentId: AGENT,
      callerUserId: USER,
      principal: { kind: 'user', userId: USER, source: 'session' },
      ...overrides,
    });
  return { svc, workspaces, runners, prepare, acquire };
}

describe('RunWorkspaceService.acquire', () => {
  it('has the runner make a folder and records the workspace for the run', async () => {
    const { acquire, prepare, workspaces } = build();
    const before = Date.now();

    const ws = await acquire();

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith('runner-1', 'workspace.prepare', { name: 'support-bot-aaaabbbb' }, undefined, expect.objectContaining({ callerUserId: USER }));
    const row = workspaces.row(ws.id)!;
    expect(row).toMatchObject({
      runnerId: 'runner-1',
      ownerUserId: USER,
      organizationId: ORG,
      cwd: '/home/me/.almyty/workspaces/support-bot-aaaabbbb',
      isolation: RunnerIsolationTier.HOST,
      status: WorkspaceStatus.ACTIVE,
      name: 'support-bot-aaaabbbb',
      agentId: AGENT,
      runId: RUN,
    });
    // The ordinary default time limit: an hour.
    expect(row.ttlAt!.getTime()).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);
    expect(row.ttlAt!.getTime()).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);
  });

  it('reuses the run\'s workspace for the rest of the run', async () => {
    const { acquire, prepare, workspaces } = build();
    const first = await acquire();
    const second = await acquire();
    expect(second.id).toBe(first.id);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(workspaces.rows()).toHaveLength(1);
  });

  it('makes one workspace for calls of the same run that arrive together', async () => {
    const { acquire, prepare, workspaces } = build();
    const [a, b, c] = await Promise.all([acquire(), acquire(), acquire()]);
    expect(new Set([a.id, b.id, c.id]).size).toBe(1);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(workspaces.rows()).toHaveLength(1);
  });

  it('gives another run its own workspace', async () => {
    const { acquire, workspaces } = build();
    const mine = await acquire();
    const theirs = await acquire({ runId: 'ccccdddd-2222-4222-8222-222222222222' });
    expect(theirs.id).not.toBe(mine.id);
    expect(theirs.name).toBe('support-bot-ccccdddd');
    expect(workspaces.rows()).toHaveLength(2);
  });

  it('after the workspace is released, the run\'s next call gets a new one in the same folder', async () => {
    const { acquire, workspaces } = build();
    const first = await acquire();
    const service = new WorkspaceService(workspaces as any, fakeRepository() as any);
    await service.release(first.id, USER, ORG);

    const next = await acquire();

    expect(next.id).not.toBe(first.id);
    expect(next.cwd).toBe(first.cwd);
    expect(workspaces.row(first.id)!.status).toBe(WorkspaceStatus.RELEASED);
  });

  it('expires a workspace past its time limit that the sweep has not reached, and makes a fresh one', async () => {
    const stale = {
      id: 'ws-stale', runnerId: 'runner-1', ownerUserId: USER, organizationId: ORG, cwd: '/w', isolation: RunnerIsolationTier.HOST,
      status: WorkspaceStatus.ACTIVE, ttlAt: new Date(Date.now() - 1000), runId: RUN, agentId: AGENT, name: 'support-bot-aaaabbbb',
    };
    const { acquire, workspaces } = build({ seed: [stale] });
    const ws = await acquire();
    expect(ws.id).not.toBe('ws-stale');
    expect(workspaces.row('ws-stale')).toMatchObject({ status: WorkspaceStatus.EXPIRED, closeReason: { kind: 'expired' } });
  });

  it('refuses at the runner\'s limit, without asking the runner for a folder', async () => {
    const busy = (id: string) => ({
      id, runnerId: 'runner-1', ownerUserId: 'someone', organizationId: ORG, cwd: `/${id}`, isolation: RunnerIsolationTier.HOST,
      status: WorkspaceStatus.ACTIVE, ttlAt: new Date(Date.now() + 60_000),
    });
    const { acquire, prepare, workspaces } = build({ seed: [busy('ws-a'), busy('ws-b')] });

    const err = await acquire().catch((e) => e);

    expect(err).toBeInstanceOf(RunnerCallError);
    expect(err.code).toBe(RUNNER_CALL_ERRORS.RUNNER_AT_CAPACITY);
    expect(err.message).toContain('maxConcurrent 2');
    expect(prepare).not.toHaveBeenCalled();
    expect(workspaces.rows()).toHaveLength(2);
  });

  it('refuses on a runner that cannot take work', async () => {
    const { acquire, prepare } = build({ runner: runner({ state: RunnerState.DRAINING }) });
    await expect(acquire()).rejects.toMatchObject({ code: RUNNER_CALL_ERRORS.RUNNER_OFFLINE });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('a runner too old to make folders is a clear error, and nothing is recorded', async () => {
    const prepare = jest.fn(async () => ({ ok: false, error: { code: -32603, message: 'unknown method workspace.prepare' } }));
    const { acquire, workspaces } = build({ prepare });
    await expect(acquire()).rejects.toMatchObject({
      code: RUNNER_CALL_ERRORS.WORKSPACE_UNAVAILABLE,
      message: 'runner laptop cannot make workspaces automatically; update @almyty/runner on that machine',
    });
    expect(workspaces.rows()).toHaveLength(0);
  });

  it('a folder the runner refuses is a clear error with the runner\'s reason', async () => {
    const prepare = jest.fn(async () => {
      throw new RunnerCallError(RUNNER_CALL_ERRORS.RUNNER_ERROR, 'cwd is outside allowedCwdRoots: /x', { code: -32603, message: 'cwd is outside allowedCwdRoots: /x' });
    });
    const { acquire, workspaces } = build({ prepare });
    await expect(acquire()).rejects.toMatchObject({
      code: RUNNER_CALL_ERRORS.WORKSPACE_UNAVAILABLE,
      message: 'runner laptop could not make a workspace folder: cwd is outside allowedCwdRoots: /x',
    });
    expect(workspaces.rows()).toHaveLength(0);
  });

  it('passes a runner that did not answer through as it is', async () => {
    const prepare = jest.fn(async () => {
      throw new RunnerCallError(RUNNER_CALL_ERRORS.TIMEOUT, 'runner laptop did not respond within 15000ms');
    });
    const { acquire } = build({ prepare });
    await expect(acquire()).rejects.toMatchObject({ code: RUNNER_CALL_ERRORS.TIMEOUT });
  });

  it('goes on the runner the agent\'s labels pick, preferring the tool\'s own', async () => {
    const { acquire, runners } = build();
    await acquire({ labels: { gpu: 'yes' } });
    expect(runners.resolveByLabels).toHaveBeenCalledWith({ gpu: 'yes' }, expect.anything(), ORG, { preferRunnerId: 'runner-1' });
  });

  it('answers a runner the caller may not use as not found', async () => {
    const { svc, runners } = build();
    runners.resolveForDispatch.mockRejectedValueOnce(new NotFoundException('runner not found'));
    await expect(
      svc.acquire({ runnerId: 'runner-1', organizationId: ORG, runId: RUN, callerUserId: USER }),
    ).rejects.toMatchObject({ code: RUNNER_CALL_ERRORS.RUNNER_NOT_FOUND });
  });

  it('holds a private gateway\'s run to the gateway owner, and refuses an org-wide gateway\'s', async () => {
    const { acquire, workspaces, prepare } = build();
    const ws = await acquire({
      callerUserId: null,
      principal: { kind: 'gateway', gatewayId: 'gw', organizationId: ORG, visibility: 'private', teamId: null, ownerUserId: USER },
    });
    expect(workspaces.row(ws.id)!.ownerUserId).toBe(USER);

    prepare.mockClear();
    await expect(
      acquire({
        runId: 'eeeeffff-3333-4333-8333-333333333333',
        callerUserId: null,
        principal: { kind: 'gateway', gatewayId: 'gw', organizationId: ORG, visibility: 'org', teamId: null, ownerUserId: USER },
      }),
    ).rejects.toMatchObject({ code: RUNNER_CALL_ERRORS.WORKSPACE_REQUIRED });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('takes the other pod\'s workspace when it recorded the run\'s first', async () => {
    const { acquire, workspaces } = build();
    const save = workspaces.save.getMockImplementation()!;
    workspaces.save.mockImplementationOnce(async (entity: any) => {
      // The other pod's row lands between our lookup and our insert.
      await save({ ...entity, id: 'ws-other-pod' });
      throw Object.assign(new Error('duplicate key'), { code: '23505' });
    });
    const ws = await acquire();
    expect(ws.id).toBe('ws-other-pod');
    expect(workspaces.rows()).toHaveLength(1);
  });
});

describe('the workspace list says which agent made each one', () => {
  it('attaches the agent\'s id and name, nothing else of it', async () => {
    const { acquire, workspaces } = build();
    await acquire();
    const service = new WorkspaceService(workspaces as any, fakeRepository() as any);
    const [ws] = await service.listForOwner(USER, ORG);
    expect(ws.agent).toEqual({ id: AGENT, name: 'Support Bot' });
    expect(ws.runId).toBe(RUN);
  });
});

describe('workspaceFolderName', () => {
  it('is the agent name as a slug plus the start of the run id', () => {
    expect(workspaceFolderName('Support Bot!', RUN)).toBe('support-bot-aaaabbbb');
    expect(workspaceFolderName('  Ünïcode / path ../x ', RUN)).toBe('n-code-path-x-aaaabbbb');
  });

  it('falls back to run-<id> without an agent name', () => {
    expect(workspaceFolderName('', RUN)).toBe('run-aaaabbbb');
    expect(workspaceFolderName('!!!', RUN)).toBe('run-aaaabbbb');
  });

  it('stays within what the runner accepts', () => {
    const name = workspaceFolderName('x'.repeat(200), RUN);
    expect(name).toMatch(/^[a-z0-9][a-z0-9-]{0,79}$/);
  });
});
