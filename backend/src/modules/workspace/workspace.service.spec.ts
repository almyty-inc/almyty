import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';

import { Runner, RunnerState, RunnerIsolationTier } from '../../entities/runner.entity';
import { Workspace, WorkspaceStatus } from '../../entities/workspace.entity';
import { WorkspaceService } from './workspace.service';

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

  // ── visibility ──────────────────────────────────────────────────────

  it('getOne refuses cross-tenant read', async () => {
    const runner = makeRunner();
    runners._store.set(runner.id, runner);
    const ws = await service.create({ cwd: '/work' }, ownerUserId, organizationId);
    await expect(service.getOne(ws.id, 'other-user', organizationId))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getOne(ws.id, ownerUserId, 'other-org'))
      .rejects.toBeInstanceOf(NotFoundException);
  });
});
