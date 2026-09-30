import { readFileSync } from 'fs';
import { join } from 'path';

import { NotFoundException } from '@nestjs/common';

import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { AgentExecution, AgentExecutionStatus } from '../../entities/agent-execution.entity';
import { Agent } from '../../entities/agent.entity';
import { Runner, RunnerIsolationTier } from '../../entities/runner.entity';
import { OrganizationRole } from '../../entities/user-organization.entity';
import { Workspace, WorkspaceStatus } from '../../entities/workspace.entity';
import { fakeManager, fakeRepository } from '../../test/fake-repository';
import { AgentRuntimeProcessor } from '../agents/agent-runtime.processor';
import { AgentRuntimeService } from '../agents/agent-runtime.service';
import { releaseRunWorkspaces } from './run-end-release';
import { WorkspaceService } from './workspace.service';

const ORG = 'org-1';
const RUN = '11111111-aaaa-4aaa-8aaa-111111111111';
const OTHER_RUN = '22222222-bbbb-4bbb-8bbb-222222222222';

function ws(id: string, overrides: Partial<Workspace> = {}): Partial<Workspace> {
  return {
    id,
    runnerId: 'runner-1',
    ownerUserId: 'user-1',
    organizationId: ORG,
    cwd: `/w/${id}`,
    isolation: RunnerIsolationTier.HOST,
    status: WorkspaceStatus.ACTIVE,
    ttlAt: new Date(Date.now() + 60_000),
    closeReason: null,
    closedAt: null,
    runId: null,
    agentId: null,
    ...overrides,
  };
}

/**
 * When a run ends -- completed, failed, cancelled, timed out -- the
 * workspaces it was given are released at once, so the runner's slot is
 * free. Only the row changes: the heartbeat stops the processes and the
 * folder stays on the machine. The one-hour limit stays as the safety net,
 * and so does the workspace tick for a run that ended somewhere nothing
 * released it.
 */
describe('a run\'s workspaces are released when it ends', () => {
  it('releases the run\'s active workspaces and nothing else', async () => {
    const repo = fakeRepository<Workspace>([
      ws('mine-a', { runId: RUN }),
      ws('mine-b', { runId: RUN, runnerId: 'runner-2' }),
      ws('mine-stranded', { runId: RUN, status: WorkspaceStatus.STRANDED, closeReason: { kind: 'stranded', detail: 'runner-3' } }),
      ws('other-run', { runId: OTHER_RUN }),
      ws('api-made'),
    ]);

    const released = await releaseRunWorkspaces(repo as any, RUN);

    expect(released).toBe(2);
    expect(repo.row('mine-a')).toMatchObject({ status: WorkspaceStatus.RELEASED, closeReason: { kind: 'released', detail: `run ${RUN} ended` } });
    expect(repo.row('mine-b')!.status).toBe(WorkspaceStatus.RELEASED);
    expect(repo.row('mine-a')!.closedAt).toBeInstanceOf(Date);
    // Terminal states are one-way: a stranded one stays stranded.
    expect(repo.row('mine-stranded')).toMatchObject({ status: WorkspaceStatus.STRANDED, closeReason: { kind: 'stranded' } });
    expect(repo.row('other-run')!.status).toBe(WorkspaceStatus.ACTIVE);
    expect(repo.row('api-made')!.status).toBe(WorkspaceStatus.ACTIVE);
  });

  it('never fails the run\'s end', async () => {
    const broken = { update: jest.fn().mockRejectedValue(new Error('db down')) };
    await expect(releaseRunWorkspaces(broken as any, RUN)).resolves.toBe(0);
    await expect(releaseRunWorkspaces(undefined, RUN)).resolves.toBe(0);
  });

  it('the autonomous step loop releases them when the run is done, and not while it continues', async () => {
    const workspaces = fakeRepository<Workspace>([ws('w', { runId: RUN })]);
    let result: 'continue' | 'done' = 'continue';
    const runtime = { processStep: jest.fn(async () => result) };
    const processor = new AgentRuntimeProcessor(runtime as any, { add: jest.fn() } as any, {} as any, fakeRepository() as any, workspaces as any);

    await processor.handleNextStep({ data: { runId: RUN, seq: 1 } } as any);
    expect(workspaces.row('w')!.status).toBe(WorkspaceStatus.ACTIVE);

    result = 'done';
    await processor.handleNextStep({ data: { runId: RUN, seq: 2 } } as any);
    expect(workspaces.row('w')!.status).toBe(WorkspaceStatus.RELEASED);
  });

  it('a run the queue gave up on is failed and its workspaces released', async () => {
    const workspaces = fakeRepository<Workspace>([ws('w', { runId: RUN })]);
    const runs = fakeRepository<AgentRun>([{ id: RUN, status: AgentRunStatus.RUNNING, steps: [] } as any]);
    const processor = new AgentRuntimeProcessor({} as any, {} as any, {} as any, runs as any, workspaces as any);
    await processor.onFailed({ name: 'next-step', id: 'j', attemptsMade: 3, opts: { attempts: 3 }, data: { runId: RUN } } as any, new Error('boom'));
    expect(runs.row(RUN)!.status).toBe(AgentRunStatus.FAILED);
    expect(workspaces.row('w')!.status).toBe(WorkspaceStatus.RELEASED);
  });

  it('cancelling a run releases its workspaces', async () => {
    const workspaces = fakeRepository<Workspace>([ws('w', { runId: RUN })]);
    const runs = fakeRepository<AgentRun>();
    const run = { id: RUN, status: AgentRunStatus.RUNNING, isDone: () => false } as any;
    const service = Object.create(AgentRuntimeService.prototype) as any;
    Object.assign(service, {
      runRepository: runs,
      workspaceRepository: workspaces,
      getRun: jest.fn(async () => run),
      emitEvent: jest.fn(),
    });

    await service.cancelRun(RUN, ORG);

    expect(run.status).toBe(AgentRunStatus.CANCELLED);
    expect(workspaces.row('w')!.status).toBe(WorkspaceStatus.RELEASED);
  });

  it('a workflow run releases its workspaces on every way out of execute', () => {
    const engine = readFileSync(join(__dirname, '..', 'agents', 'agent-execution.engine.ts'), 'utf8');
    const finallyBlock = engine.slice(engine.indexOf('} finally {', engine.indexOf('async execute(')));
    expect(finallyBlock.slice(0, 800)).toContain('await releaseRunWorkspaces(this.workspaceRepository, execution.id);');
  });

  it('the workspace tick releases the workspaces of runs that ended elsewhere (reaper, collaboration)', async () => {
    const workspaces = fakeRepository<Workspace>([
      ws('auto-ended', { runId: RUN }),
      ws('auto-running', { runId: OTHER_RUN }),
      ws('flow-ended', { runId: 'exec-1' }),
      ws('flow-waiting', { runId: 'exec-2' }),
      ws('api-made'),
    ]);
    const runs = fakeRepository<AgentRun>([
      { id: RUN, status: AgentRunStatus.TIMEOUT } as any,
      { id: OTHER_RUN, status: AgentRunStatus.WAITING_APPROVAL } as any,
    ]);
    const executions = fakeRepository<AgentExecution>([
      { id: 'exec-1', status: AgentExecutionStatus.FAILED } as any,
      { id: 'exec-2', status: AgentExecutionStatus.RUNNING } as any,
    ]);
    fakeManager([[Workspace, workspaces], [AgentRun, runs], [AgentExecution, executions]]);
    const service = new WorkspaceService(workspaces as any, fakeRepository() as any);

    const released = await service.releaseForEndedRuns();

    expect(released).toBe(2);
    expect(workspaces.row('auto-ended')!.status).toBe(WorkspaceStatus.RELEASED);
    expect(workspaces.row('flow-ended')!.status).toBe(WorkspaceStatus.RELEASED);
    expect(workspaces.row('auto-running')!.status).toBe(WorkspaceStatus.ACTIVE);
    expect(workspaces.row('flow-waiting')!.status).toBe(WorkspaceStatus.ACTIVE);
    expect(workspaces.row('api-made')!.status).toBe(WorkspaceStatus.ACTIVE);
  });
});

/**
 * Who sees a workspace: its owner; the owner of the runner it is on (another
 * member's agent run working on their machine); and org owners and admins,
 * for every team and org-wide runner. A private runner is its owner's alone,
 * admins included. Everyone else is told "not found", on the API.
 */
describe('who sees and releases a runner\'s workspaces', () => {
  const ME = 'user-me';
  const ALICE = 'user-alice';
  const BOB = 'user-bob';
  const ADMIN = 'user-admin';

  function setup() {
    const runners = fakeRepository<Runner>([
      { id: 'r-alice-org', ownerUserId: ALICE, organizationId: ORG, visibility: 'org' } as any,
      { id: 'r-alice-private', ownerUserId: ALICE, organizationId: ORG, visibility: 'private' } as any,
      { id: 'r-bob-team', ownerUserId: BOB, organizationId: ORG, visibility: 'team' } as any,
      { id: 'r-elsewhere', ownerUserId: ALICE, organizationId: 'org-2', visibility: 'org' } as any,
    ]);
    const workspaces = fakeRepository<Workspace>([
      ws('mine-on-alice', { runnerId: 'r-alice-org', ownerUserId: ME, runId: RUN, agentId: 'agent-1' }),
      ws('bob-on-alice', { runnerId: 'r-alice-org', ownerUserId: BOB }),
      ws('alice-private', { runnerId: 'r-alice-private', ownerUserId: ALICE }),
      ws('alice-on-bob', { runnerId: 'r-bob-team', ownerUserId: ALICE }),
      ws('other-org', { runnerId: 'r-elsewhere', ownerUserId: BOB, organizationId: 'org-2' }),
    ]);
    const agents = fakeRepository<Agent>([{ id: 'agent-1', name: 'Support Bot', organizationId: ORG } as any]);
    fakeManager([[Workspace, workspaces], [Agent, agents]]);
    const roles: Record<string, OrganizationRole> = { [ADMIN]: OrganizationRole.ADMIN, [ME]: OrganizationRole.MEMBER };
    const accessPolicy = { getOrgRole: jest.fn(async (u: string) => roles[u] ?? OrganizationRole.MEMBER) };
    const service = new WorkspaceService(workspaces as any, runners as any, accessPolicy as any);
    const ids = async (user: string) => (await service.listForOwner(user, ORG)).map((w) => w.id).sort();
    return { service, workspaces, ids };
  }

  it('a member sees only their own', async () => {
    const { ids } = setup();
    expect(await ids(ME)).toEqual(['mine-on-alice']);
  });

  it('the runner\'s owner sees every workspace on their runners, other members\' agent runs included', async () => {
    const { ids } = setup();
    expect(await ids(ALICE)).toEqual(['alice-on-bob', 'alice-private', 'bob-on-alice', 'mine-on-alice']);
  });

  it('an org admin sees every workspace on team and org-wide runners, but not on someone\'s private runner', async () => {
    const { ids } = setup();
    expect(await ids(ADMIN)).toEqual(['alice-on-bob', 'bob-on-alice', 'mine-on-alice']);
  });

  it('opening one follows the same rule, and says "not found" otherwise', async () => {
    const { service } = setup();
    await expect(service.getOne('bob-on-alice', ALICE, ORG)).resolves.toMatchObject({ id: 'bob-on-alice' });
    await expect(service.getOne('bob-on-alice', ADMIN, ORG)).resolves.toMatchObject({ id: 'bob-on-alice' });
    await expect(service.getOne('bob-on-alice', ME, ORG)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getOne('alice-private', ADMIN, ORG)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getOne('other-org', BOB, ORG)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('the runner\'s owner can release another member\'s workspace on their machine; a member cannot', async () => {
    const { service, workspaces } = setup();
    await expect(service.release('bob-on-alice', ME, ORG)).rejects.toBeInstanceOf(NotFoundException);
    expect(workspaces.row('bob-on-alice')!.status).toBe(WorkspaceStatus.ACTIVE);

    const released = await service.release('bob-on-alice', ALICE, ORG);
    expect(released.status).toBe(WorkspaceStatus.RELEASED);
    expect(released.closeReason).toEqual({ kind: 'released', detail: ALICE });
  });

  it('the list carries the agent name of workspaces agent runs were given', async () => {
    const { service } = setup();
    const [mine] = await service.listForOwner(ME, ORG);
    expect(mine.agent).toEqual({ id: 'agent-1', name: 'Support Bot' });
  });
});
