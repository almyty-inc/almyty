import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException, ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';

import { Runner, RunnerState, RunnerIsolationTier } from '../../entities/runner.entity';
import { RunnerSession } from '../../entities/runner-session.entity';
import { Workspace, WorkspaceStatus } from '../../entities/workspace.entity';
import { RunnerService } from './runner.service';
import { RunnerCapabilityPublisher } from './runner-capability.publisher';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { OrganizationRole } from '../../entities/user-organization.entity';
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
  let fakePublisher: { publish: jest.Mock; unpublish: jest.Mock; listForRunner: jest.Mock };

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
      /**
       * Conditional state write, modelled rather than stubbed. Every FSM
       * transition carries the state it believes the runner is in, and
       * the guard is the fix — a mock that always reported a hit would
       * let a heartbeat overwrite a drain without a test going red.
       */
      update: jest.fn(async (criteria: any, patch: any) => {
        let affected = 0;
        for (const r of runners._store.values()) {
          if (!Object.entries(criteria).every(([k, v]: any) => (r as any)[k] === v)) continue;
          Object.assign(r, patch);
          affected += 1;
        }
        return { affected };
      }),
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
      /**
       * SELECT DISTINCT ws."runnerId" ... JOIN runners r ... WHERE
       * ws.status = 'active' AND r.state IN ('offline','registered') —
       * the self-heal lookup for a runner that can no longer be running
       * the workspaces still pinned to it: flipped offline without its
       * fan-out, or re-registered after a crash.
       */
      createQueryBuilder: jest.fn(() => {
        let activeStatus: string | undefined;
        let goneStates: string[] | undefined;
        const qb: any = {
          select: () => qb,
          innerJoin: () => qb,
          where: (_clause: string, params: any) => { activeStatus = params?.active; return qb; },
          andWhere: (_clause: string, params: any) => { goneStates = params?.gone; return qb; },
          getRawMany: async () => {
            const ids = new Set<string>();
            for (const ws of workspaces._store.values() as Iterable<Workspace>) {
              if (activeStatus && ws.status !== activeStatus) continue;
              const runner = runners._store.get(ws.runnerId);
              if (!runner || !goneStates || !goneStates.includes(runner.state)) continue;
              ids.add(ws.runnerId);
            }
            return [...ids].map((runnerId) => ({ runnerId }));
          },
        };
        return qb;
      }),
    };


    fakePublisher = {
      publish: jest.fn().mockResolvedValue([]),
      unpublish: jest.fn().mockResolvedValue(0),
      listForRunner: jest.fn().mockResolvedValue([]),
    };

    // The REAL access policy over fake membership tables, so the
    // visibility decisions these tests make are the production ones.
    // org-1: user-1 (the owner in most tests), a colleague and an
    // outsider are plain members, `admin-1` is an org admin. user-1 and
    // the colleague are on team-1; the outsider and the admin are on no
    // team.
    const userOrgs = {
      rows: [
        { userId: ownerUserId, organizationId, role: OrganizationRole.MEMBER, isActive: true },
        { userId: 'colleague', organizationId, role: OrganizationRole.MEMBER, isActive: true },
        { userId: 'outsider', organizationId, role: OrganizationRole.MEMBER, isActive: true },
        { userId: 'admin-1', organizationId, role: OrganizationRole.ADMIN, isActive: true },
      ],
      findOne: async ({ where }: any) => userOrgs.rows.find(r =>
        r.userId === where.userId && r.organizationId === where.organizationId && r.isActive,
      ) ?? null,
      manager: { getRepository: () => ({ count: async () => 1 }) },
    };
    const userTeams = {
      createQueryBuilder: () => {
        let userId = '';
        const qb: any = {
          innerJoin: () => qb,
          where: (_c: string, p: any) => { userId = p.userId; return qb; },
          select: () => qb,
          getRawMany: async () => ([ownerUserId, 'colleague'].includes(userId) ? [{ teamId: 'team-1', role: 'member' }] : []),
        };
        return qb;
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        RunnerService,
        { provide: getRepositoryToken(Runner), useValue: runners },
        { provide: getRepositoryToken(RunnerSession), useValue: sessions },
        { provide: getRepositoryToken(Workspace), useValue: workspaces },
        { provide: RunnerCapabilityPublisher, useValue: fakePublisher },
        { provide: AccessPolicyService, useValue: new AccessPolicyService(userOrgs as any, userTeams as any) },
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

  it('register persists visibility="team" + teamId from the input', async () => {
    const result = await service.register(
      {
        name: 'team-runner',
        labels: {},
        runtimeInfo: validRuntimeInfo,
        config: validConfig,
        visibility: 'team',
        teamId: 'team-1',
      },
      ownerUserId,
      organizationId,
    );
    expect(result.runner.visibility).toBe('team');
    expect(result.runner.teamId).toBe('team-1');
  });

  it('register defaults visibility to "private" and nulls teamId when input is omitted', async () => {
    const result = await service.register(
      { name: 'org-runner', labels: {}, runtimeInfo: validRuntimeInfo, config: validConfig },
      ownerUserId,
      organizationId,
    );
    expect(result.runner.visibility).toBe('private');
    expect(result.runner.teamId).toBeNull();
  });

  it('register drops a stray teamId when visibility="org"', async () => {
    const result = await service.register(
      {
        name: 'org-stray',
        labels: {},
        runtimeInfo: validRuntimeInfo,
        config: validConfig,
        visibility: 'org',
        teamId: 'should-be-dropped' as any,
      },
      ownerUserId,
      organizationId,
    );
    expect(result.runner.visibility).toBe('org');
    expect(result.runner.teamId).toBeNull();
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
    const r = await service.resolveForDispatch(runner.id, ownerUserId);
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
      await expect(service.resolveForDispatch(runner.id, ownerUserId)).rejects.toBeInstanceOf(BadRequestException);
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

  // ── getUsable (coding-bridge authz scope) ───────────────────────────

  const registerAs = async (visibility?: 'org' | 'team' | 'private', owner = ownerUserId, name = 'r1') =>
    (await service.register(
      {
        name, labels: {}, runtimeInfo: validRuntimeInfo, config: validConfig,
        ...(visibility ? { visibility, teamId: visibility === 'team' ? 'team-1' : null } : {}),
      },
      owner, organizationId,
    )).runner;

  it('getUsable returns an org-wide runner to another member of the org', async () => {
    const runner = await registerAs('org');
    const found = await service.getUsable(runner.id, 'colleague', organizationId);
    expect(found.id).toBe(runner.id);
  });

  it('getUsable throws Forbidden for a runner in another org', async () => {
    const runner = await registerAs('org');
    await expect(service.getUsable(runner.id, ownerUserId, 'other-org'))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('getUsable throws NotFound for an unknown runner', async () => {
    await expect(service.getUsable('nope', ownerUserId, organizationId))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  // ── private visibility: the owner and nobody else ───────────────────

  describe('a private runner', () => {
    it('is what a runner gets when nobody chose a visibility', async () => {
      const runner = await registerAs();
      expect(runner.visibility).toBe('private');
    });

    it('is usable by its owner on every path', async () => {
      const runner = await registerAs('private');
      runner.state = RunnerState.ONLINE;
      await expect(service.getOne(runner.id, ownerUserId, organizationId)).resolves.toMatchObject({ id: runner.id });
      await expect(service.getUsable(runner.id, ownerUserId, organizationId)).resolves.toMatchObject({ id: runner.id });
      await expect(service.resolveForDispatch(runner.id, ownerUserId)).resolves.toMatchObject({ id: runner.id });
    });

    it('is invisible to another member of the same org: fetch, coding bridge and dispatch all 404', async () => {
      const runner = await registerAs('private');
      runner.state = RunnerState.ONLINE;
      await expect(service.getOne(runner.id, 'colleague', organizationId)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.getUsable(runner.id, 'colleague', organizationId)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.resolveForDispatch(runner.id, 'colleague')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('is invisible to an org admin too', async () => {
      const runner = await registerAs('private');
      runner.state = RunnerState.ONLINE;
      await expect(service.getOne(runner.id, 'admin-1', organizationId)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.resolveForDispatch(runner.id, 'admin-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('takes no dispatch with an unknown caller (an API-key gateway call, a system job)', async () => {
      const runner = await registerAs('private');
      runner.state = RunnerState.ONLINE;
      await expect(service.resolveForDispatch(runner.id)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cannot be renamed, relabelled, re-scoped or deleted by another member or an admin', async () => {
      const runner = await registerAs('private');
      for (const user of ['colleague', 'admin-1']) {
        await expect(service.update(runner.id, user, organizationId, { visibility: 'org' }))
          .rejects.toBeInstanceOf(NotFoundException);
        await expect(service.unregister(runner.id, user, organizationId))
          .rejects.toBeInstanceOf(NotFoundException);
      }
      expect(runners._store.get(runner.id)?.visibility).toBe('private');
    });
  });

  describe('a team runner', () => {
    it('is usable by a team member and refused to a member outside the team', async () => {
      const runner = await registerAs('team');
      runner.state = RunnerState.ONLINE;
      await expect(service.resolveForDispatch(runner.id, 'colleague')).resolves.toMatchObject({ id: runner.id });
      await expect(service.resolveForDispatch(runner.id, 'outsider')).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.resolveForDispatch(runner.id)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── names and re-registration ───────────────────────────────────────

  it('refuses a runner name another member of the org already uses (no takeover by name)', async () => {
    await registerAs('org', ownerUserId, 'franemb');
    await expect(registerAs('org', 'colleague', 'franemb')).rejects.toBeInstanceOf(ConflictException);
    await expect(service.create({ name: 'franemb' }, 'colleague', organizationId))
      .rejects.toBeInstanceOf(ConflictException);
    // The owner's runner, and its published tools, are untouched.
    const rows = Array.from(runners._store.values()) as Runner[];
    expect(rows.filter(r => r.name === 'franemb')).toHaveLength(1);
    expect(rows.find(r => r.name === 'franemb')?.ownerUserId).toBe(ownerUserId);
    expect(fakePublisher.publish).toHaveBeenCalledTimes(1);
  });

  it('re-registration from the daemon keeps the visibility and labels chosen on the web', async () => {
    const pending = await service.create(
      { name: 'franemb', labels: { env: 'dev' }, visibility: 'team', teamId: 'team-1' },
      ownerUserId, organizationId,
    );
    const { runner } = await service.register(
      { name: 'franemb', labels: {}, runtimeInfo: validRuntimeInfo, config: validConfig },
      ownerUserId, organizationId,
    );
    expect(runner.id).toBe(pending.id);
    expect(runner.visibility).toBe('team');
    expect(runner.teamId).toBe('team-1');
    expect(runner.labels).toEqual({ env: 'dev' });
  });

  // ── pending records (setup page) ────────────────────────────────────

  describe('the setup page record', () => {
    it('create makes a pending runner with no published tools', async () => {
      const runner = await service.create({ name: 'franemb', visibility: 'private' }, ownerUserId, organizationId);
      expect(runner.state).toBe(RunnerState.REGISTERED);
      expect(runner.runtimeInfo).toBeNull();
      expect(fakePublisher.publish).not.toHaveBeenCalled();
    });

    it('create is idempotent for the same name and refuses a second name (single runner cap)', async () => {
      const a = await service.create({ name: 'franemb' }, ownerUserId, organizationId);
      const b = await service.create({ name: 'franemb', visibility: 'org' }, ownerUserId, organizationId);
      expect(b.id).toBe(a.id);
      expect(b.visibility).toBe('org');
      await expect(service.create({ name: 'other' }, ownerUserId, organizationId))
        .rejects.toBeInstanceOf(ConflictException);
    });

    it('a pending runner can be renamed and deleted by its owner', async () => {
      const runner = await service.create({ name: 'franemb' }, ownerUserId, organizationId);
      const renamed = await service.update(runner.id, ownerUserId, organizationId, { name: 'franemb2' });
      expect(renamed.name).toBe('franemb2');
      await service.unregister(runner.id, ownerUserId, organizationId);
      expect(runners._store.has(runner.id)).toBe(false);
    });

    it('a runner that has connected keeps its name', async () => {
      const { runner } = await service.register(
        { name: 'franemb', labels: {}, runtimeInfo: validRuntimeInfo, config: validConfig },
        ownerUserId, organizationId,
      );
      await expect(service.update(runner.id, ownerUserId, organizationId, { name: 'renamed' }))
        .rejects.toBeInstanceOf(ConflictException);
    });
  });
});