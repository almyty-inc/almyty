import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { IsNull } from 'typeorm';

import { Runner, RunnerState, RunnerIsolationTier } from '../../entities/runner.entity';
import { RunnerSession } from '../../entities/runner-session.entity';
import { Workspace, WorkspaceStatus } from '../../entities/workspace.entity';
import { RunnerService } from './runner.service';
import { RunnerCapabilityPublisher } from './runner-capability.publisher';
import { STALE_THRESHOLD_MS, OFFLINE_GRACE_MS } from './runner-state';

/**
 * Service-level tests with mocked repositories. The pure FSM is tested
 * separately (runner-state.spec.ts); this file exercises the parts of
 * RunnerService that depend on persistence: registration policy,
 * session lifecycle, heartbeat-driven workspace count lookup, and
 * dispatch resolution.
 */
describe('RunnerService', () => {
  let service: RunnerService;
  let runners: any;
  let sessions: any;
  let workspaces: any;

  const ownerUserId = 'user-1';
  const organizationId = 'org-1';

  const validRuntimeInfo = {
    os: 'darwin', arch: 'arm64', hostname: 'mac', cpuCount: 8, memoryMb: 16_000,
    runnerVersion: '1.0.0', binaries: { node: 'v20.0.0', git: 'git version 2.47.0', python: null },
  };
  const validConfig = {
    defaultIsolation: RunnerIsolationTier.HOST,
    maxConcurrent: 4,
    allowedCwdRoots: ['/Users/frane/workspace'],
    denyPatterns: ['*.env'],
    networkBlocked: false,
    installBlocked: false,
  };

  beforeEach(async () => {
    runners = {
      _store: new Map<string, Runner>(),
      findOne: jest.fn(async ({ where }: any) => {
        for (const r of runners._store.values()) {
          if (Object.entries(where).every(([k, v]: [string, any]) => (r as any)[k] === v)) return r;
        }
        return null;
      }),
      find: jest.fn(async ({ where }: any) => {
        const all = Array.from(runners._store.values());
        if (Array.isArray(where)) {
          return all.filter(r => where.some((w: any) => Object.entries(w).every(([k, v]: any) => (r as any)[k] === v)));
        }
        return all.filter(r => Object.entries(where).every(([k, v]: [string, any]) => (r as any)[k] === v));
      }),
      create: jest.fn((data: Partial<Runner>) => ({
        id: data.id ?? `r-${runners._store.size + 1}`,
        labels: {}, runtimeInfo: null, config: null, lastHeartbeatAt: null,
        state: RunnerState.REGISTERED,
        registeredAt: new Date(), updatedAt: new Date(),
        ...data,
      })),
      save: jest.fn(async (r: Runner) => { runners._store.set(r.id, r); return r; }),
      remove: jest.fn(async (r: Runner) => { runners._store.delete(r.id); }),
    };
    sessions = {
      _store: new Map<string, RunnerSession>(),
      findOne: jest.fn(async ({ where, order }: any) => {
        const matches: RunnerSession[] = Array.from(sessions._store.values() as Iterable<RunnerSession>).filter(s => {
          for (const [k, v] of Object.entries(where)) {
            // crude IsNull() impl for the test
            if (v && typeof v === 'object' && (v as any)._type === 'isNull') {
              if ((s as any)[k] !== null) return false;
              continue;
            }
            if ((s as any)[k] !== v) return false;
          }
          return true;
        });
        if (order?.connectedAt === 'DESC') matches.sort((a, b) => b.connectedAt.getTime() - a.connectedAt.getTime());
        return matches[0] ?? null;
      }),
      create: jest.fn((data: Partial<RunnerSession>) => ({
        id: data.id ?? `s-${sessions._store.size + 1}`,
        connectedAt: new Date(),
        disconnectedAt: null,
        remoteAddress: null,
        ...data,
      })),
      save: jest.fn(async (s: RunnerSession) => { sessions._store.set(s.id, s); return s; }),
      update: jest.fn(async (where: any, set: any) => {
        for (const s of sessions._store.values()) {
          if (s.streamableSessionId === where.streamableSessionId && s.disconnectedAt === null) {
            Object.assign(s, set);
          }
        }
      }),
    };
    workspaces = {
      _store: new Map<string, Workspace>(),
      count: jest.fn(async ({ where }: any) =>
        Array.from(workspaces._store.values()).filter(ws =>
          Object.entries(where).every(([k, v]: any) => (ws as any)[k] === v),
        ).length,
      ),
    };


    const fakePublisher = {
      publish: jest.fn().mockResolvedValue([]),
      unpublish: jest.fn().mockResolvedValue(0),
      listForRunner: jest.fn().mockResolvedValue([]),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        RunnerService,
        { provide: getRepositoryToken(Runner), useValue: runners },
        { provide: getRepositoryToken(RunnerSession), useValue: sessions },
        { provide: getRepositoryToken(Workspace), useValue: workspaces },
        { provide: RunnerCapabilityPublisher, useValue: fakePublisher },
      ],
    }).compile();
    service = moduleRef.get(RunnerService);
  });

  const afterEachRestore: Array<() => void> = [];
  afterEach(() => { afterEachRestore.splice(0).forEach(fn => fn()); });

  // ── register ────────────────────────────────────────────────────────

  it('register creates a new runner and resets transient fields', async () => {
    const result = await service.register(
      { name: 'mac-laptop', labels: { env: 'dev' }, runtimeInfo: validRuntimeInfo, config: validConfig },
      ownerUserId, organizationId,
    );
    expect(result.runner.name).toBe('mac-laptop');
    expect(result.runner.state).toBe(RunnerState.REGISTERED);
    expect(result.runner.lastHeartbeatAt).toBeNull();
    expect(result.runner.runtimeInfo).toEqual(validRuntimeInfo);
    expect(result.effectiveConfig).toEqual(validConfig);
  });

  it('register rejects an invalid name', async () => {
    await expect(service.register(
      { name: 'has spaces', labels: {}, runtimeInfo: validRuntimeInfo, config: validConfig },
      ownerUserId, organizationId,
    )).rejects.toBeInstanceOf(BadRequestException);
  });

  it('register refuses a second runner for the same (user, org)', async () => {
    await service.register(
      { name: 'first', labels: {}, runtimeInfo: validRuntimeInfo, config: validConfig },
      ownerUserId, organizationId,
    );
    await expect(service.register(
      { name: 'second', labels: {}, runtimeInfo: validRuntimeInfo, config: validConfig },
      ownerUserId, organizationId,
    )).rejects.toBeInstanceOf(ConflictException);
  });

  it('re-registration with the same name updates in place and resets state', async () => {
    const first = await service.register(
      { name: 'mac-laptop', labels: {}, runtimeInfo: validRuntimeInfo, config: validConfig },
      ownerUserId, organizationId,
    );
    // Promote first to ONLINE so we can prove re-register resets it.
    first.runner.state = RunnerState.ONLINE;
    first.runner.lastHeartbeatAt = new Date();
    await runners.save(first.runner);

    const newRuntime = { ...validRuntimeInfo, runnerVersion: '1.0.1' };
    const again = await service.register(
      { name: 'mac-laptop', labels: { tier: 'a' }, runtimeInfo: newRuntime, config: validConfig },
      ownerUserId, organizationId,
    );
    expect(again.runner.id).toBe(first.runner.id);
    expect(again.runner.state).toBe(RunnerState.REGISTERED);
    expect(again.runner.lastHeartbeatAt).toBeNull();
    expect(again.runner.runtimeInfo?.runnerVersion).toBe('1.0.1');
    expect(again.runner.labels).toEqual({ tier: 'a' });
  });

  // ── heartbeat -> state machine ──────────────────────────────────────

  it('heartbeat with no workspaces brings REGISTERED to ONLINE', async () => {
    const { runner } = await service.register(
      { name: 'r1', labels: {}, runtimeInfo: validRuntimeInfo, config: validConfig },
      ownerUserId, organizationId,
    );
    const updated = await service.heartbeat(runner.id);
    expect(updated.state).toBe(RunnerState.ONLINE);
    expect(updated.lastHeartbeatAt).toBeInstanceOf(Date);
  });

  it('heartbeat with active workspaces brings runner to BUSY', async () => {
    const { runner } = await service.register(
      { name: 'r1', labels: {}, runtimeInfo: validRuntimeInfo, config: validConfig },
      ownerUserId, organizationId,
    );
    workspaces._store.set('w1', { id: 'w1', runnerId: runner.id, status: WorkspaceStatus.ACTIVE } as any);
    const updated = await service.heartbeat(runner.id);
    expect(updated.state).toBe(RunnerState.BUSY);
  });

  // ── tick: stale + offline + stranding fan-out ───────────────────────

  it('tick flips long-silent runners to STALE and reports them', async () => {
    const { runner } = await service.register(
      { name: 'r1', labels: {}, runtimeInfo: validRuntimeInfo, config: validConfig },
      ownerUserId, organizationId,
    );
    await service.heartbeat(runner.id);
    runner.lastHeartbeatAt = new Date(Date.now() - STALE_THRESHOLD_MS - 5_000);
    await runners.save(runner);

    const result = await service.tick(new Date());
    expect(result.transitioned).toBe(1);
    const after = await runners.findOne({ where: { id: runner.id } });
    expect(after?.state).toBe(RunnerState.STALE);
  });

  it('tick flips STALE to OFFLINE after the grace window and reports for stranding', async () => {
    const { runner } = await service.register(
      { name: 'r1', labels: {}, runtimeInfo: validRuntimeInfo, config: validConfig },
      ownerUserId, organizationId,
    );
    runner.state = RunnerState.STALE;
    runner.lastHeartbeatAt = new Date(Date.now() - STALE_THRESHOLD_MS - OFFLINE_GRACE_MS - 5_000);
    await runners.save(runner);

    const result = await service.tick(new Date());
    expect(result.markStrandedFor).toEqual([runner.id]);
    const after = await runners.findOne({ where: { id: runner.id } });
    expect(after?.state).toBe(RunnerState.OFFLINE);
  });

  // ── sessions ────────────────────────────────────────────────────────

  it('onSessionConnect inserts a new session row when none exists', async () => {
    const { runner } = await service.register(
      { name: 'r1', labels: {}, runtimeInfo: validRuntimeInfo, config: validConfig },
      ownerUserId, organizationId,
    );
    const row = await service.onSessionConnect(runner.id, 'sh_abc', '127.0.0.1');
    expect(row.streamableSessionId).toBe('sh_abc');
    expect(row.disconnectedAt).toBeNull();
  });

  it('onSessionConnect is idempotent for the same (runner, session)', async () => {
    const { runner } = await service.register(
      { name: 'r1', labels: {}, runtimeInfo: validRuntimeInfo, config: validConfig },
      ownerUserId, organizationId,
    );
    const r1 = await service.onSessionConnect(runner.id, 'sh_abc');
    const r2 = await service.onSessionConnect(runner.id, 'sh_abc');
    expect(r2.id).toBe(r1.id);
    expect(sessions._store.size).toBe(1);
  });

  it('onSessionDisconnect stamps disconnectedAt on the matching row', async () => {
    const { runner } = await service.register(
      { name: 'r1', labels: {}, runtimeInfo: validRuntimeInfo, config: validConfig },
      ownerUserId, organizationId,
    );
    await service.onSessionConnect(runner.id, 'sh_abc');
    await service.onSessionDisconnect('sh_abc');
    const row = Array.from(sessions._store.values())[0] as RunnerSession;
    expect(row.disconnectedAt).toBeInstanceOf(Date);
  });

  // ── dispatch resolution ─────────────────────────────────────────────

  it('resolveForDispatch returns the runner when ONLINE', async () => {
    const { runner } = await service.register(
      { name: 'r1', labels: {}, runtimeInfo: validRuntimeInfo, config: validConfig },
      ownerUserId, organizationId,
    );
    runner.state = RunnerState.ONLINE;
    await runners.save(runner);
    const r = await service.resolveForDispatch(runner.id);
    expect(r.state).toBe(RunnerState.ONLINE);
  });

  it('resolveForDispatch refuses STALE / OFFLINE / DRAINING runners', async () => {
    const { runner } = await service.register(
      { name: 'r1', labels: {}, runtimeInfo: validRuntimeInfo, config: validConfig },
      ownerUserId, organizationId,
    );
    for (const s of [RunnerState.STALE, RunnerState.OFFLINE, RunnerState.DRAINING, RunnerState.REGISTERED]) {
      runner.state = s;
      await runners.save(runner);
      await expect(service.resolveForDispatch(runner.id)).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('resolveForDispatch throws NotFoundException for an unknown runner id', async () => {
    await expect(service.resolveForDispatch('not-a-runner'))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  // ── drain ───────────────────────────────────────────────────────────

  it('drain moves a live runner to DRAINING but keeps it in the table', async () => {
    const { runner } = await service.register(
      { name: 'r1', labels: {}, runtimeInfo: validRuntimeInfo, config: validConfig },
      ownerUserId, organizationId,
    );
    runner.state = RunnerState.ONLINE;
    await runners.save(runner);
    const drained = await service.drain(runner.id);
    expect(drained.state).toBe(RunnerState.DRAINING);
  });
});
