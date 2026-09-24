import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';

import { Runner, RunnerState, RunnerIsolationTier } from '../../entities/runner.entity';
import { Workspace, WorkspaceStatus } from '../../entities/workspace.entity';
import { WorkspaceService } from './workspace.service';
import { strandingQueryBuilder } from './strand-query.fixtures';

/**
 * WorkspaceService tests with mocked repos. Covers create's runner-
 * picker logic, lifecycle transitions, the TTL sweep, and the runner-
 * offline stranding fan-out. Pairs with workspace-stranding.spec.ts
 * for the integration-level test.
 */
describe('WorkspaceService', () => {
  let service: WorkspaceService;
  let workspaces: any;
  let runners: any;

  const ownerUserId = 'user-1';
  const organizationId = 'org-1';

  function makeRunner(overrides: Partial<Runner> = {}): Runner {
    return {
      id: 'r-1',
      name: 'r1',
      ownerUserId,
      organizationId,
      state: RunnerState.ONLINE,
      labels: {},
      runtimeInfo: null,
      config: {
        defaultIsolation: RunnerIsolationTier.HOST,
        maxConcurrent: 4,
        allowedCwdRoots: ['/'],
        denyPatterns: [],
        networkBlocked: false,
        installBlocked: false,
      },
      lastHeartbeatAt: new Date(),
      registeredAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    } as Runner;
  }

  beforeEach(async () => {
    runners = {
      _store: new Map<string, Runner>(),
      find: jest.fn(async ({ where }: any) =>
        (Array.from(runners._store.values()) as Runner[]).filter((r: any) =>
          Object.entries(where).every(([k, v]: any) => (r as any)[k] === v),
        ),
      ),
      findOne: jest.fn(async ({ where }: any) => {
        for (const r of runners._store.values()) {
          if (Object.entries(where).every(([k, v]: any) => (r as any)[k] === v)) return r;
        }
        return null;
      }),
    };

    workspaces = {
      _store: new Map<string, Workspace>(),
      _idSeq: 0,
      find: jest.fn(async ({ where, order }: any) => {
        const all = Array.from(workspaces._store.values()) as Workspace[];
        const filtered = all.filter((ws: any) => {
          for (const [k, v] of Object.entries(where)) {
            // crude In() / LessThanOrEqual() interpreters for tests
            if (v && typeof v === 'object' && '_value' in (v as any)) {
              const op = v as any;
              if (op._type === 'in') {
                if (!op._value.includes((ws as any)[k])) return false;
              } else if (op._type === 'lessThanOrEqual') {
                const ts = (ws as any)[k] as Date | null;
                if (!ts || ts.getTime() > op._value.getTime()) return false;
              } else {
                return false;
              }
            } else {
              if ((ws as any)[k] !== v) return false;
            }
          }
          return true;
        });
        if (order?.createdAt === 'DESC') filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return filtered;
      }),
      findOne: jest.fn(async ({ where }: any) => {
        for (const ws of workspaces._store.values()) {
          if (Object.entries(where).every(([k, v]: any) => (ws as any)[k] === v)) return ws;
        }
        return null;
      }),
      count: jest.fn(async ({ where }: any) =>
        Array.from(workspaces._store.values()).filter((ws: any) =>
          Object.entries(where).every(([k, v]: any) => (ws as any)[k] === v),
        ).length,
      ),
      create: jest.fn((data: Partial<Workspace>) => {
        workspaces._idSeq += 1;
        return {
          id: `w-${workspaces._idSeq}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          closedAt: null,
          closeReason: null,
          ttlAt: null,
          ...data,
        };
      }),
      save: jest.fn(async (ws: Workspace) => { workspaces._store.set(ws.id, ws); return ws; }),
      /**
       * Conditional column update, modelled rather than stubbed. The
       * `status: ACTIVE` in the criteria IS the fix — a mock that
       * ignored the guard and always reported a hit would let a lost
       * terminal transition back in without a test going red.
       */
      update: jest.fn(async (criteria: any, patch: any) => {
        let affected = 0;
        for (const ws of workspaces._store.values()) {
          if (!Object.entries(criteria).every(([k, v]: any) => (ws as any)[k] === v)) continue;
          Object.assign(ws, patch);
          affected += 1;
        }
        return { affected };
      }),
      createQueryBuilder: jest.fn(() => strandingQueryBuilder(() => workspaces._store.values())),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        WorkspaceService,
        { provide: getRepositoryToken(Workspace), useValue: workspaces },
        { provide: getRepositoryToken(Runner), useValue: runners },
      ],
    }).compile();
    service = moduleRef.get(WorkspaceService);
  });

  // ── create ──────────────────────────────────────────────────────────

  it('create pins workspace to the user single registered runner', async () => {
    const runner = makeRunner();
    runners._store.set(runner.id, runner);

    const ws = await service.create(
      { cwd: '/work/repo' },
      ownerUserId, organizationId,
    );
    expect(ws.runnerId).toBe(runner.id);
    expect(ws.status).toBe(WorkspaceStatus.ACTIVE);
    expect(ws.isolation).toBe(RunnerIsolationTier.HOST);
    expect(ws.ttlAt).toBeInstanceOf(Date);
  });

  it('create refuses when no runner is registered', async () => {
    await expect(service.create(
      { cwd: '/work/repo' }, ownerUserId, organizationId,
    )).rejects.toBeInstanceOf(NotFoundException);
  });

  it('create refuses when the runner is in a non-accepting state', async () => {
    const runner = makeRunner({ state: RunnerState.STALE });
    runners._store.set(runner.id, runner);
    await expect(service.create(
      { cwd: '/work/repo' }, ownerUserId, organizationId,
    )).rejects.toBeInstanceOf(ConflictException);
  });

  it('create rejects an invalid ttlMs', async () => {
    const runner = makeRunner();
    runners._store.set(runner.id, runner);
    await expect(service.create(
      { cwd: '/work/repo', ttlMs: -100 }, ownerUserId, organizationId,
    )).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create clamps ttlMs to the max (24h)', async () => {
    const runner = makeRunner();
    runners._store.set(runner.id, runner);
    const ws = await service.create(
      { cwd: '/work/repo', ttlMs: 1000 * 60 * 60 * 48 },
      ownerUserId, organizationId,
    );
    const span = ws.ttlAt!.getTime() - ws.createdAt.getTime();
    expect(span).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000); // tolerance
  });

  // ── release / sweep / strand ───────────────────────────────────────

  it('release marks workspace RELEASED with closeReason', async () => {
    const runner = makeRunner();
    runners._store.set(runner.id, runner);
    const ws = await service.create({ cwd: '/work' }, ownerUserId, organizationId);
    const released = await service.release(ws.id, ownerUserId, organizationId);
    expect(released.status).toBe(WorkspaceStatus.RELEASED);
    expect(released.closeReason).toEqual({ kind: 'released', detail: ownerUserId });
    expect(released.closedAt).toBeInstanceOf(Date);
  });

  it('release on an already-terminal workspace is idempotent', async () => {
    const runner = makeRunner();
    runners._store.set(runner.id, runner);
    const ws = await service.create({ cwd: '/work' }, ownerUserId, organizationId);
    ws.status = WorkspaceStatus.RELEASED;
    await workspaces.save(ws);
    const again = await service.release(ws.id, ownerUserId, organizationId);
    expect(again.status).toBe(WorkspaceStatus.RELEASED);
  });

  it('sweepExpired flips ACTIVE+ttl-passed workspaces to EXPIRED', async () => {
    const runner = makeRunner();
    runners._store.set(runner.id, runner);
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);
    workspaces._store.set('a', { id: 'a', runnerId: runner.id, ownerUserId, organizationId, status: WorkspaceStatus.ACTIVE, ttlAt: past, cwd: '/', isolation: RunnerIsolationTier.HOST, createdAt: new Date(), updatedAt: new Date(), closedAt: null, closeReason: null } as any);
    workspaces._store.set('b', { id: 'b', runnerId: runner.id, ownerUserId, organizationId, status: WorkspaceStatus.ACTIVE, ttlAt: future, cwd: '/', isolation: RunnerIsolationTier.HOST, createdAt: new Date(), updatedAt: new Date(), closedAt: null, closeReason: null } as any);

    // Real TypeORM LessThanOrEqual returns a FindOperator with _type
    // 'lessThanOrEqual' and _value <date>; the mock's interpreter
    // already understands that shape, so no monkey-patching needed.
    const expired = await service.sweepExpired();

    expect(expired.map(w => w.id)).toEqual(['a']);
    expect(workspaces._store.get('a').status).toBe(WorkspaceStatus.EXPIRED);
    expect(workspaces._store.get('b').status).toBe(WorkspaceStatus.ACTIVE);
  });

  it('markStrandedForRunners flips ACTIVE workspaces to STRANDED', async () => {
    const runner = makeRunner();
    runners._store.set(runner.id, runner);
    workspaces._store.set('a', {
      id: 'a', runnerId: runner.id, ownerUserId, organizationId,
      status: WorkspaceStatus.ACTIVE, ttlAt: null, cwd: '/',
      isolation: RunnerIsolationTier.HOST,
      createdAt: new Date(), updatedAt: new Date(), closedAt: null, closeReason: null,
    } as any);
    workspaces._store.set('b', {
      id: 'b', runnerId: runner.id, ownerUserId, organizationId,
      status: WorkspaceStatus.RELEASED, ttlAt: null, cwd: '/',
      isolation: RunnerIsolationTier.HOST,
      createdAt: new Date(), updatedAt: new Date(), closedAt: null, closeReason: null,
    } as any);

    // Real TypeORM In() already shapes the FindOperator the mock understands.
    const n = await service.markStrandedForRunners([runner.id]);

    expect(n).toBe(1);
    expect(workspaces._store.get('a').status).toBe(WorkspaceStatus.STRANDED);
    expect(workspaces._store.get('a').closeReason).toEqual({ kind: 'stranded', detail: runner.id });
    expect(workspaces._store.get('b').status).toBe(WorkspaceStatus.RELEASED);
  });

  // ── the set the heartbeat ack reports ──────────────────────────────

  /**
   * listActiveForRunner is what a runner's heartbeat ack is built from,
   * and the runner kills processes for every workspace NOT in it. So
   * the exact membership rule is load-bearing in both directions: a
   * terminal workspace that leaks into the list keeps its processes
   * alive forever, and an ACTIVE one that falls out of it has a user's
   * running work killed underneath them.
   *
   * ACTIVE is the only status that belongs. released, expired and
   * stranded are the three terminal states and every one of them means
   * "nothing should still be running for this workspace" — stranded
   * included, since it is set when the runner went offline and is
   * deliberately one-way, so a runner that comes back is holding
   * processes for work that is never resuming.
   */
  it('listActiveForRunner returns only ACTIVE workspaces for that runner', async () => {
    const mine = makeRunner();
    const theirs = makeRunner({ id: 'r-2', name: 'r2' });
    runners._store.set(mine.id, mine);
    runners._store.set(theirs.id, theirs);

    const row = (id: string, runnerId: string, status: WorkspaceStatus) => ({
      id, runnerId, ownerUserId, organizationId, status, ttlAt: null, cwd: '/',
      isolation: RunnerIsolationTier.HOST,
      createdAt: new Date(), updatedAt: new Date(), closedAt: null, closeReason: null,
    } as any);

    workspaces._store.set('a', row('a', mine.id, WorkspaceStatus.ACTIVE));
    workspaces._store.set('b', row('b', mine.id, WorkspaceStatus.RELEASED));
    workspaces._store.set('c', row('c', mine.id, WorkspaceStatus.EXPIRED));
    workspaces._store.set('d', row('d', mine.id, WorkspaceStatus.STRANDED));
    workspaces._store.set('e', row('e', theirs.id, WorkspaceStatus.ACTIVE));

    const active = await service.listActiveForRunner(mine.id);

    expect(active.map((w) => w.id)).toEqual(['a']);
  });

  it('listActiveForRunner is empty, not an error, for a runner with nothing active', async () => {
    const runner = makeRunner();
    runners._store.set(runner.id, runner);
    expect(await service.listActiveForRunner(runner.id)).toEqual([]);
  });


  it('getOne refuses cross-tenant read', async () => {
    const runner = makeRunner();
    runners._store.set(runner.id, runner);
    const ws = await service.create({ cwd: '/work' }, ownerUserId, organizationId);
    await expect(service.getOne(ws.id, 'other-user', organizationId))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getOne(ws.id, ownerUserId, 'other-org'))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('markStrandedForRunners leaves other runners’ workspaces active', async () => {
    const row = (id: string, runnerId: string) => ({
      id, runnerId, ownerUserId, organizationId, status: WorkspaceStatus.ACTIVE, ttlAt: null, cwd: '/',
      isolation: RunnerIsolationTier.HOST, createdAt: new Date(), updatedAt: new Date(), closedAt: null, closeReason: null,
    } as any);
    workspaces._store.set('a', row('a', 'r-1'));
    workspaces._store.set('z', row('z', 'r-other'));

    expect(await service.markStrandedForRunners(['r-1'])).toBe(1);
    expect(workspaces._store.get('z')).toMatchObject({ status: WorkspaceStatus.ACTIVE, closeReason: null });
  });

  // ── tenancy: the same user, a runner in another organization ────────
  //
  // The runner and workspace doubles evaluate `where`, but no test put a
  // second organization's rows in them, so the org half of the runner
  // picker and of listForOwner could be deleted with the module green.

  it('create never pins a workspace to the user’s runner in another organization', async () => {
    const elsewhere = makeRunner({ id: 'r-9', organizationId: 'org-2' });
    runners._store.set(elsewhere.id, elsewhere);

    await expect(service.create({ cwd: '/work' }, ownerUserId, organizationId))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(service.create({ cwd: '/work', runnerId: 'r-9' }, ownerUserId, organizationId))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(workspaces._store.size).toBe(0);
  });

  it('listForOwner lists only this organization’s workspaces', async () => {
    runners._store.set('r-1', makeRunner());
    runners._store.set('r-9', makeRunner({ id: 'r-9', organizationId: 'org-2' }));
    const mine = await service.create({ cwd: '/work' }, ownerUserId, organizationId);
    await service.create({ cwd: '/work' }, ownerUserId, 'org-2');

    expect((await service.listForOwner(ownerUserId, organizationId)).map((w) => w.id)).toEqual([mine.id]);
  });
});
