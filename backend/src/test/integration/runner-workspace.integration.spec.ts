import { DataSource, Repository } from 'typeorm';

import { Runner, RunnerState, RunnerIsolationTier } from '../../entities/runner.entity';
import { RunnerSession } from '../../entities/runner-session.entity';
import { Workspace, WorkspaceStatus } from '../../entities/workspace.entity';
import { Tool } from '../../entities/tool.entity';
import { User } from '../../entities/user.entity';
import { Organization } from '../../entities/organization.entity';
import { RunnerService } from '../../modules/runner/runner.service';
import { RunnerCapabilityPublisher } from '../../modules/runner/runner-capability.publisher';
import { WorkspaceService } from '../../modules/workspace/workspace.service';
import { STALE_THRESHOLD_MS, OFFLINE_GRACE_MS } from '../../modules/runner/runner-state';

/**
 * End-to-end test against a real Postgres. Exercises the full surface
 * the routing layer will depend on: registration, single-runner cap,
 * heartbeat-driven state transitions, dispatch resolution, runner
 * disconnection -> stranding fan-out, TTL expiry sweep.
 *
 * Gated on RUN_DB_INTEGRATION=1 just like every other integration
 * spec in this repo. Uses its own schema so parallel jest workers
 * don't step on each other.
 */
const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;

jest.setTimeout(60_000);

describeIfDb('Runner + Workspace (real Postgres)', () => {
  let ds: DataSource;
  let runners: RunnerService;
  let workspaces: WorkspaceService;
  let userId: string;
  let organizationId: string;

  beforeAll(async () => {
    const bootstrap = new DataSource({
      type: 'postgres',
      host: process.env.DATABASE_HOST || '127.0.0.1',
      port: Number(process.env.DATABASE_PORT || 5432),
      username: process.env.DATABASE_USERNAME || 'postgres',
      password: process.env.DATABASE_PASSWORD || '',
      database: process.env.DATABASE_NAME || 'almyty_test',
    });
    await bootstrap.initialize();
    await bootstrap.query('CREATE SCHEMA IF NOT EXISTS runner_workspace_test');
    // uuid-ossp lives in public schema; reach it via search_path so
    // uuid_generate_v4() resolves inside our isolated schema. Runtime
    // entities use TypeORM's @PrimaryGeneratedColumn('uuid') which
    // emits gen_random_uuid()-equivalent SQL, but the migrations our
    // entity tables descend from reference uuid_generate_v4 directly.
    await bootstrap.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await bootstrap.destroy();

    ds = new DataSource({
      type: 'postgres',
      host: process.env.DATABASE_HOST || '127.0.0.1',
      port: Number(process.env.DATABASE_PORT || 5432),
      username: process.env.DATABASE_USERNAME || 'postgres',
      password: process.env.DATABASE_PASSWORD || '',
      database: process.env.DATABASE_NAME || 'almyty_test',
      schema: 'runner_workspace_test',
      entities: [__dirname + '/../../entities/*.entity{.ts,.js}'],
      synchronize: true,
      dropSchema: true,
    });
    await ds.initialize();
    await ds.query('SET search_path TO runner_workspace_test, public');

    // Seed the org + user the runner/workspace records will FK to.
    const orgRepo = ds.getRepository(Organization);
    const userRepo = ds.getRepository(User);
    const org = await orgRepo.save(orgRepo.create({
      name: 'Test Org',
      slug: 'test-org',
    } as any));
    organizationId = (org as any).id;
    const user = await userRepo.save(userRepo.create({
      email: 'runner-test@example.com',
      passwordHash: 'x',
      firstName: 'R',
      lastName: 'T',
    } as any));
    userId = (user as any).id;

    const toolRepo = ds.getRepository(Tool);
    runners = new RunnerService(
      ds.getRepository(Runner),
      ds.getRepository(RunnerSession),
      ds.getRepository(Workspace),
      new RunnerCapabilityPublisher(toolRepo),
      {
        canAccess: jest.fn().mockResolvedValue({ allowed: true, reason: 'ok' }),
        assertCanScopeToTeam: jest.fn().mockResolvedValue(undefined),
      } as any,
    );
    workspaces = new WorkspaceService(
      ds.getRepository(Workspace),
      ds.getRepository(Runner),
    );
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  beforeEach(async () => {
    await ds.query("TRUNCATE TABLE workspaces, runner_sessions, runners CASCADE");
  });

  const validInput = {
    name: 'mac-laptop',
    labels: { env: 'dev' },
    runtimeInfo: {
      os: 'darwin', arch: 'arm64', hostname: 'mac', cpuCount: 8, memoryMb: 16_000,
      runnerVersion: '1.0.0', binaries: { node: 'v20', git: '2.47', python: null },
    },
    config: {
      defaultIsolation: RunnerIsolationTier.HOST,
      maxConcurrent: 4,
      allowedCwdRoots: ['/Users/frane/workspace'],
      denyPatterns: [],
      networkBlocked: false,
      installBlocked: false,
    },
  };

  // ── Full lifecycle ──────────────────────────────────────────────────

  it('register -> heartbeat (online) -> create workspace (busy) -> release (online)', async () => {
    const reg = await runners.register(validInput, userId, organizationId);
    expect(reg.runner.state).toBe(RunnerState.REGISTERED);

    const beat1 = await runners.heartbeat(reg.runner.id);
    expect(beat1.state).toBe(RunnerState.ONLINE);

    const ws = await workspaces.create(
      { cwd: '/Users/frane/workspace/sample', isolation: RunnerIsolationTier.HOST },
      userId, organizationId,
    );
    expect(ws.status).toBe(WorkspaceStatus.ACTIVE);

    const beat2 = await runners.heartbeat(reg.runner.id);
    expect(beat2.state).toBe(RunnerState.BUSY);

    const released = await workspaces.release(ws.id, userId, organizationId);
    expect(released.status).toBe(WorkspaceStatus.RELEASED);

    const beat3 = await runners.heartbeat(reg.runner.id);
    expect(beat3.state).toBe(RunnerState.ONLINE);
  });

  // ── Single-runner cap ───────────────────────────────────────────────

  it('refuses a second runner registration for the same (user, org)', async () => {
    await runners.register(validInput, userId, organizationId);
    await expect(runners.register(
      { ...validInput, name: 'second-runner' },
      userId, organizationId,
    )).rejects.toThrow(/single runner/i);
  });

  // ── Stranding fan-out on offline ────────────────────────────────────

  it('runner goes OFFLINE -> all active workspaces stranded', async () => {
    const reg = await runners.register(validInput, userId, organizationId);
    await runners.heartbeat(reg.runner.id);

    const ws = await workspaces.create({ cwd: '/x' }, userId, organizationId);
    expect(ws.status).toBe(WorkspaceStatus.ACTIVE);

    // Push the runner well past the OFFLINE grace window in a single
    // tick. We simulate this by manually backdating lastHeartbeatAt
    // and then calling tick(); the sweep flips runner -> OFFLINE,
    // then markStrandedForRunners flips workspaces -> STRANDED.
    const repo = ds.getRepository(Runner);
    await repo.update(reg.runner.id, {
      state: RunnerState.STALE,
      lastHeartbeatAt: new Date(Date.now() - STALE_THRESHOLD_MS - OFFLINE_GRACE_MS - 5_000),
    });

    const tick = await runners.tick();
    expect(tick.markStrandedFor).toContain(reg.runner.id);
    await workspaces.markStrandedForRunners(tick.markStrandedFor);

    const after = await ds.getRepository(Workspace).findOneByOrFail({ id: ws.id });
    expect(after.status).toBe(WorkspaceStatus.STRANDED);
    expect(after.closeReason).toEqual({ kind: 'stranded', detail: reg.runner.id });
  });

  // ── TTL expiry sweep ────────────────────────────────────────────────

  it('TTL-expired workspaces flip to EXPIRED on sweep', async () => {
    const reg = await runners.register(validInput, userId, organizationId);
    await runners.heartbeat(reg.runner.id);

    const ws = await workspaces.create(
      { cwd: '/x', ttlMs: 1 },
      userId, organizationId,
    );
    expect(ws.status).toBe(WorkspaceStatus.ACTIVE);

    // Wait past TTL.
    await new Promise(resolve => setTimeout(resolve, 50));
    const expired = await workspaces.sweepExpired();
    expect(expired.map(w => w.id)).toContain(ws.id);

    const after = await ds.getRepository(Workspace).findOneByOrFail({ id: ws.id });
    expect(after.status).toBe(WorkspaceStatus.EXPIRED);
  });

  // ── Dispatch refusal ────────────────────────────────────────────────

  it('resolveForDispatch refuses a STALE runner', async () => {
    const reg = await runners.register(validInput, userId, organizationId);
    await runners.heartbeat(reg.runner.id);
    await ds.getRepository(Runner).update(reg.runner.id, { state: RunnerState.STALE });

    await expect(runners.resolveForDispatch(reg.runner.id)).rejects.toThrow(/cannot accept dispatch/);
  });

  // ── Session lifecycle ──────────────────────────────────────────────

  it('session connect/disconnect rows persist; getActiveSession returns the live one', async () => {
    const reg = await runners.register(validInput, userId, organizationId);
    await runners.onSessionConnect(reg.runner.id, 'sh_abc', '127.0.0.1');
    const live1 = await runners.getActiveSession(reg.runner.id);
    expect(live1?.streamableSessionId).toBe('sh_abc');

    await runners.onSessionDisconnect('sh_abc');
    const live2 = await runners.getActiveSession(reg.runner.id);
    expect(live2).toBeNull();

    // Reconnect with the same id reuses the row, not a duplicate.
    await runners.onSessionConnect(reg.runner.id, 'sh_abc');
    const live3 = await runners.getActiveSession(reg.runner.id);
    expect(live3?.streamableSessionId).toBe('sh_abc');

    const all = await ds.getRepository(RunnerSession).find({ where: { runnerId: reg.runner.id } });
    expect(all).toHaveLength(1);
  });
});
