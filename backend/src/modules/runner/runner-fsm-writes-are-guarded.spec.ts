import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { Runner, RunnerState, RunnerIsolationTier } from '../../entities/runner.entity';
import { RunnerSession } from '../../entities/runner-session.entity';
import { Workspace, WorkspaceStatus } from '../../entities/workspace.entity';
import { RunnerService } from './runner.service';
import { RunnerCapabilityPublisher } from './runner-capability.publisher';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { STALE_THRESHOLD_MS, OFFLINE_GRACE_MS, canAcceptWork } from './runner-state';

/**
 * Three writers race for a runner's `state`: the heartbeat, the tick
 * sweep, and the CLI's drain on the way down. `nextState` scores a
 * SNAPSHOT, and an unconditional save() then wrote that snapshot's
 * verdict back however long ago it was taken — so a heartbeat already
 * in flight when a graceful shutdown landed put ONLINE back over the
 * committed DRAINING, and `resolveForDispatch` kept handing work to a
 * runner whose process had exited.
 *
 * And separately, needing no concurrency at all: the tick flips a
 * runner OFFLINE and RETURNS the workspaces to strand, which a second
 * write then strands. A pod dying between the two left the runner
 * OFFLINE with its workspaces ACTIVE — and the tick's own WHERE clause
 * only looked at ONLINE/BUSY/STALE/DRAINING, so it never examined that
 * runner again. The workspaces stayed active forever, the heartbeat's
 * workspace count stayed wrong, the user was never told their work was
 * gone, and only manual SQL could fix it.
 *
 * The runners fake hands out detached copies and models a conditional
 * UPDATE, so a stale snapshot really can try to overwrite a committed
 * state.
 */
describe('runner FSM writes are guarded', () => {
  let service: RunnerService;
  let runnerRows: Map<string, Runner>;
  let workspaceRows: Map<string, Workspace>;
  let runners: any;
  let workspaces: any;

  const detach = (r: Runner): Runner => ({ ...r }) as Runner;
  const matches = (row: any, where: Record<string, any>) =>
    Object.entries(where).every(([k, v]) => row[k] === v);

  const seedRunner = (overrides: Partial<Runner> = {}): Runner => {
    const runner = {
      id: 'r-1',
      name: 'laptop',
      ownerUserId: 'u-1',
      organizationId: 'org-1',
      state: RunnerState.ONLINE,
      labels: {},
      runtimeInfo: null,
      config: { defaultIsolation: RunnerIsolationTier.HOST },
      lastHeartbeatAt: new Date(),
      visibility: 'org',
      teamId: null,
      registeredAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    } as Runner;
    runnerRows.set(runner.id, runner);
    return runner;
  };

  const seedWorkspace = (overrides: Partial<Workspace> = {}): Workspace => {
    const ws = {
      id: `w-${workspaceRows.size + 1}`,
      runnerId: 'r-1',
      ownerUserId: 'u-1',
      organizationId: 'org-1',
      cwd: '/work',
      isolation: RunnerIsolationTier.HOST,
      status: WorkspaceStatus.ACTIVE,
      ttlAt: null,
      closeReason: null,
      closedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    } as Workspace;
    workspaceRows.set(ws.id, ws);
    return ws;
  };

  beforeEach(async () => {
    runnerRows = new Map<string, Runner>();
    workspaceRows = new Map<string, Workspace>();

    runners = {
      findOne: jest.fn(async ({ where }: any) => {
        const hit = [...runnerRows.values()].find((r) => matches(r, where));
        return hit ? detach(hit) : null;
      }),
      find: jest.fn(async ({ where }: any) => {
        const all = [...runnerRows.values()];
        const clauses = Array.isArray(where) ? where : [where];
        return all.filter((r) => clauses.some((w) => matches(r, w))).map(detach);
      }),
      create: jest.fn((data: any) => data),
      /** TypeORM's save of a loaded entity: every column. */
      save: jest.fn(async (r: Runner) => { runnerRows.set(r.id, { ...r }); return r; }),
      /** A conditional UPDATE: nothing happens unless the criteria still match. */
      update: jest.fn(async (criteria: any, patch: any) => {
        let affected = 0;
        for (const r of runnerRows.values()) {
          if (!matches(r, criteria)) continue;
          Object.assign(r, patch);
          affected += 1;
        }
        return { affected };
      }),
      remove: jest.fn(),
    };

    workspaces = {
      count: jest.fn(async ({ where }: any) =>
        [...workspaceRows.values()].filter((ws) => matches(ws, where)).length,
      ),
      createQueryBuilder: jest.fn(() => {
        let activeStatus: string | undefined;
        let goneStates: string[] | undefined;
        const qb: any = {
          select: () => qb,
          innerJoin: () => qb,
          where: (_c: string, p: any) => { activeStatus = p?.active; return qb; },
          andWhere: (_c: string, p: any) => { goneStates = p?.gone; return qb; },
          getRawMany: async () => {
            const ids = new Set<string>();
            for (const ws of workspaceRows.values()) {
              if (activeStatus && ws.status !== activeStatus) continue;
              const runner = runnerRows.get(ws.runnerId);
              if (!runner || !goneStates || !goneStates.includes(runner.state)) continue;
              ids.add(ws.runnerId);
            }
            return [...ids].map((runnerId) => ({ runnerId }));
          },
        };
        return qb;
      }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        RunnerService,
        { provide: getRepositoryToken(Runner), useValue: runners },
        { provide: getRepositoryToken(RunnerSession), useValue: { findOne: jest.fn(), update: jest.fn() } },
        { provide: getRepositoryToken(Workspace), useValue: workspaces },
        { provide: RunnerCapabilityPublisher, useValue: { publish: jest.fn(), unpublish: jest.fn() } },
        {
          provide: AccessPolicyService,
          useValue: {
            canAccess: jest.fn().mockResolvedValue({ allowed: true, reason: 'ok' }),
            assertCanScopeToTeam: jest.fn(),
          },
        },
      ],
    }).compile();
    service = moduleRef.get(RunnerService);
  });

  // ── a heartbeat must not revive a drained runner ──────────────────────

  it('a heartbeat in flight when a drain lands does not put the runner back online', async () => {
    seedRunner({ state: RunnerState.ONLINE });

    // The heartbeat reads the runner as ONLINE; the CLI's shutdown
    // commits DRAINING while the heartbeat is counting workspaces.
    workspaces.count.mockImplementationOnce(async () => {
      await service.drain('r-1');
      return 0;
    });

    await service.heartbeat('r-1');

    const row = runnerRows.get('r-1')!;
    expect(row.state).toBe(RunnerState.DRAINING);
    // Which is the point: dispatch must stop for a process that exited.
    expect(canAcceptWork(row.state)).toBe(false);
  });

  it('heartbeat returns the row as it actually stands after losing the race', async () => {
    seedRunner({ state: RunnerState.ONLINE });
    workspaces.count.mockImplementationOnce(async () => {
      await service.drain('r-1');
      return 0;
    });

    const returned = await service.heartbeat('r-1');

    expect(returned.state).toBe(RunnerState.DRAINING);
  });

  it('a tick sweep does not overwrite a heartbeat that landed after its select', async () => {
    const silent = new Date(Date.now() - (STALE_THRESHOLD_MS + 1000));
    seedRunner({ state: RunnerState.ONLINE, lastHeartbeatAt: silent });

    // The sweep selected the runner as long-silent. A heartbeat arrives
    // before the sweep writes STALE.
    runners.find.mockImplementationOnce(async ({ where }: any) => {
      const clauses = Array.isArray(where) ? where : [where];
      const selected = [...runnerRows.values()]
        .filter((r) => clauses.some((w) => matches(r, w)))
        .map(detach);
      runnerRows.get('r-1')!.state = RunnerState.BUSY;
      runnerRows.get('r-1')!.lastHeartbeatAt = new Date();
      return selected;
    });

    const result = await service.tick(new Date());

    expect(runnerRows.get('r-1')!.state).toBe(RunnerState.BUSY);
    expect(result.transitioned).toBe(0);
  });

  it('a drain that lost to a concurrent transition reports the row as it stands', async () => {
    seedRunner({ state: RunnerState.ONLINE });
    runners.findOne.mockImplementationOnce(async ({ where }: any) => {
      const hit = [...runnerRows.values()].find((r) => matches(r, where));
      const snapshot = hit ? detach(hit) : null;
      runnerRows.get('r-1')!.state = RunnerState.OFFLINE;
      return snapshot;
    });

    const returned = await service.drain('r-1');

    expect(runnerRows.get('r-1')!.state).toBe(RunnerState.OFFLINE);
    expect(returned.state).toBe(RunnerState.OFFLINE);
  });

  // ── the tick heals a half-finished offline/strand pair ────────────────

  it('an OFFLINE runner whose workspaces were never stranded is returned again', async () => {
    // The residue of a pod that died between the two writes.
    seedRunner({ state: RunnerState.OFFLINE, lastHeartbeatAt: new Date(0) });
    seedWorkspace({ status: WorkspaceStatus.ACTIVE });

    const result = await service.tick(new Date());

    expect(result.markStrandedFor).toContain('r-1');
  });

  it('an OFFLINE runner with nothing left to strand is not returned', async () => {
    seedRunner({ state: RunnerState.OFFLINE, lastHeartbeatAt: new Date(0) });
    seedWorkspace({ status: WorkspaceStatus.STRANDED });

    const result = await service.tick(new Date());

    expect(result.markStrandedFor).toEqual([]);
  });

  /**
   * The other way a runner leaves ONLINE without passing through
   * OFFLINE: it crashed and the daemon came back inside the stale
   * window. register() resets the row to REGISTERED with no heartbeat,
   * and the tick's candidate list only covers ONLINE, BUSY, STALE and
   * DRAINING -- so the workspaces pinned to the machine that died were
   * never looked at again. They stayed ACTIVE, the heartbeat counted
   * them and put the fresh runner straight into BUSY, and the user was
   * never told the work was lost.
   *
   * An ACTIVE workspace against a REGISTERED runner is always residue:
   * WorkspaceService.create refuses any runner that is not ONLINE or
   * BUSY, so this pair cannot be created legitimately.
   */
  it('a re-registered runner still holding ACTIVE workspaces is returned for stranding', async () => {
    seedRunner({ state: RunnerState.REGISTERED, lastHeartbeatAt: null });
    seedWorkspace({ status: WorkspaceStatus.ACTIVE });

    const result = await service.tick(new Date());

    expect(result.markStrandedFor).toEqual(['r-1']);
  });

  it('a freshly registered runner with no workspaces is left alone', async () => {
    seedRunner({ state: RunnerState.REGISTERED, lastHeartbeatAt: null });

    const result = await service.tick(new Date());

    expect(result.markStrandedFor).toEqual([]);
    expect(result.transitioned).toBe(0);
  });

  it('a runner flipped OFFLINE by this tick is reported once, not twice', async () => {
    const longSilent = new Date(Date.now() - (STALE_THRESHOLD_MS + OFFLINE_GRACE_MS + 5000));
    seedRunner({ state: RunnerState.STALE, lastHeartbeatAt: longSilent });
    seedWorkspace({ status: WorkspaceStatus.ACTIVE });

    const result = await service.tick(new Date());

    expect(runnerRows.get('r-1')!.state).toBe(RunnerState.OFFLINE);
    expect(result.markStrandedFor).toEqual(['r-1']);
  });

  it('the normal transitions still happen', async () => {
    const silent = new Date(Date.now() - (STALE_THRESHOLD_MS + 1000));
    seedRunner({ state: RunnerState.ONLINE, lastHeartbeatAt: silent });

    const result = await service.tick(new Date());

    expect(runnerRows.get('r-1')!.state).toBe(RunnerState.STALE);
    expect(result.transitioned).toBe(1);
    expect(result.markStrandedFor).toEqual([]);
  });

  it('a heartbeat with active workspaces moves the runner to BUSY and records the beat', async () => {
    seedRunner({ state: RunnerState.ONLINE, lastHeartbeatAt: new Date(0) });
    seedWorkspace({ status: WorkspaceStatus.ACTIVE });

    const returned = await service.heartbeat('r-1');

    expect(returned.state).toBe(RunnerState.BUSY);
    expect(runnerRows.get('r-1')!.state).toBe(RunnerState.BUSY);
    expect(runnerRows.get('r-1')!.lastHeartbeatAt!.getTime()).toBeGreaterThan(0);
  });
});
