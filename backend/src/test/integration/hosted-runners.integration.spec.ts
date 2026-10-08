import * as crypto from 'crypto';
import { readdirSync } from 'fs';
import { join } from 'path';
import { DataSource } from 'typeorm';

import { Environment } from '../../entities/environment.entity';
import { HostedRunner } from '../../entities/hosted-runner.entity';
import { RunnerEnrollmentToken } from '../../entities/runner-enrollment-token.entity';
import { RunnerUsageInterval } from '../../entities/runner-usage-interval.entity';
import { Runner, RunnerIsolationTier, RunnerState } from '../../entities/runner.entity';
import { RunnerSession } from '../../entities/runner-session.entity';
import { Workspace, WorkspaceStatus } from '../../entities/workspace.entity';
import { Tool } from '../../entities/tool.entity';
import { UserOrganization } from '../../entities/user-organization.entity';
import { UserTeam } from '../../entities/user-team.entity';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { RunnerService } from '../../modules/runner/runner.service';
import { RunnerCapabilityPublisher } from '../../modules/runner/runner-capability.publisher';
import { RunnerCredentialService, runnerSessionUser } from '../../modules/runner/runner-credential';
import { WorkspaceService } from '../../modules/workspace/workspace.service';
import { HostedAdapterRegistry } from '../../modules/hosted-runners/adapters/adapter.registry';
import { StubHostedAdapter } from '../../modules/hosted-runners/adapters/stub.adapter';
import { DEFAULT_HOSTED_RUNNER_SETTINGS, HostedRunnerSettingsService } from '../../modules/hosted-runners/hosted-runner-settings';
import { HostedRunnersService, HostedTarget } from '../../modules/hosted-runners/hosted-runners.service';
import { HostedRunnersProcessor } from '../../modules/hosted-runners/hosted-runners.processor';
import { EnrollmentService } from '../../modules/hosted-runners/enrollment.service';
import { HostedUsageService } from '../../modules/hosted-runners/hosted-usage.service';
import { HostedRunners1791000200000 } from '../../migrations/1791000200000-HostedRunners';
import { provisionExtensionsInPublic } from './test-db-extensions';

/**
 * Hosted runners against a real Postgres, with the stub adapter standing
 * in for the cluster: the migration's indexes and checks, and a hosted
 * workspace's whole life -- made on first use, woken, enrolled, ready,
 * idle and suspended (never stranded), woken again on the same volume,
 * noticed, expired and torn down -- with the usage intervals it leaves.
 */
const describeIfDb = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;
jest.setTimeout(120_000);

const connection = () => ({
  type: 'postgres' as const,
  host: process.env.DATABASE_HOST || '127.0.0.1',
  port: Number(process.env.DATABASE_PORT || 5432),
  username: process.env.DATABASE_USERNAME || 'postgres',
  password: process.env.DATABASE_PASSWORD || 'postgres',
  database: process.env.DATABASE_NAME || 'almyty_test',
});

async function freshSchema(schema: string): Promise<void> {
  const bootstrap = new DataSource(connection());
  await bootstrap.initialize();
  await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await bootstrap.query(`CREATE SCHEMA "${schema}"`);
  await provisionExtensionsInPublic((sql, params) => bootstrap.query(sql, params as any[]));
  await bootstrap.destroy();
}

function dataSource(schema: string, migrations: any[] | string[]): DataSource {
  return new DataSource({
    ...connection(),
    schema,
    extra: { options: `-c search_path=${schema},public` },
    entities: [join(__dirname, '..', '..', 'entities', '*.entity{.ts,.js}')],
    migrations,
    migrationsTransactionMode: 'all',
    logging: false,
  });
}

async function seedMember(ds: DataSource, label: string): Promise<{ organizationId: string; userId: string }> {
  const organizationId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  await ds.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $2)`, [organizationId, `org-${label}-${organizationId.slice(0, 6)}`]);
  await ds.query(
    `INSERT INTO users (id, email, "passwordHash", "firstName", "lastName", "isActive") VALUES ($1, $2, 'x', 'Ada', 'Owner', true)`,
    [userId, `${label}-${userId.slice(0, 6)}@example.com`],
  );
  await ds.query(
    `INSERT INTO user_organizations ("userId", "organizationId", role, "isActive", "inviteAccepted") VALUES ($1, $2, 'owner', true, true)`,
    [userId, organizationId],
  );
  return { organizationId, userId };
}

describeIfDb('hosted runners (real Postgres)', () => {
  const SCHEMA = 'hosted_runners_test';
  let ds: DataSource;
  let stub: StubHostedAdapter;
  let settings: HostedRunnerSettingsService;
  let hosted: HostedRunnersService;
  let processor: HostedRunnersProcessor;
  let enrollment: EnrollmentService;
  let usage: HostedUsageService;
  let runners: RunnerService;
  let workspaces: WorkspaceService;
  let credentials: RunnerCredentialService;
  let notifications: { emit: jest.Mock };
  let capacity: { maxConcurrentRunners: number; maxWorkspaces: number; resourceClasses: string[] | null };
  const previousProvider = process.env.HOSTED_RUNNERS_PROVIDER;

  beforeAll(async () => {
    process.env.HOSTED_RUNNERS_PROVIDER = 'stub';
    await freshSchema(SCHEMA);
    ds = dataSource(SCHEMA, [join(__dirname, '..', '..', 'migrations', '*{.ts,.js}')]);
    await ds.initialize();
    await ds.runMigrations();

    settings = new HostedRunnerSettingsService({ ...DEFAULT_HOSTED_RUNNER_SETTINGS, apiUrl: 'https://api.almyty.test' }, { HOSTED_RUNNERS_ENABLED: 'true' });
    const accessPolicy = new AccessPolicyService(ds.getRepository(UserOrganization), ds.getRepository(UserTeam));
    notifications = { emit: jest.fn(async () => undefined) };
    capacity = { maxConcurrentRunners: 2, maxWorkspaces: 10, resourceClasses: null };
    const queue: any = { add: jest.fn(async () => undefined), getRepeatableJobs: jest.fn(async () => []) };
    hosted = new HostedRunnersService(
      ds.getRepository(HostedRunner),
      ds.getRepository(Environment),
      ds.getRepository(Workspace),
      ds.getRepository(Runner),
      queue,
      ds,
      settings,
      accessPolicy,
      { capacityFor: async () => capacity },
      undefined,
      undefined,
      undefined,
      notifications as any,
    );
    credentials = new RunnerCredentialService();
    enrollment = new EnrollmentService(ds.getRepository(RunnerEnrollmentToken), ds.getRepository(HostedRunner), ds.getRepository(Runner), credentials, settings);
    usage = new HostedUsageService(ds.getRepository(RunnerUsageInterval));
    stub = new StubHostedAdapter();
    const registry = new HostedAdapterRegistry();
    registry.register(stub);
    processor = new HostedRunnersProcessor(queue, ds.getRepository(HostedRunner), ds.getRepository(Environment), ds.getRepository(Workspace), ds.getRepository(Runner), registry, hosted, enrollment, usage, settings);
    runners = new RunnerService(ds.getRepository(Runner), ds.getRepository(RunnerSession), ds.getRepository(Workspace), new RunnerCapabilityPublisher(ds.getRepository(Tool)), accessPolicy);
    workspaces = new WorkspaceService(ds.getRepository(Workspace), ds.getRepository(Runner), accessPolicy);
  });

  afterAll(async () => {
    if (previousProvider === undefined) delete process.env.HOSTED_RUNNERS_PROVIDER;
    else process.env.HOSTED_RUNNERS_PROVIDER = previousProvider;
    if (ds?.isInitialized) await ds.destroy();
  });

  async function environment(organizationId: string, ownerUserId: string, name = 'app'): Promise<Environment> {
    return ds.getRepository(Environment).save(ds.getRepository(Environment).create({
      organizationId,
      ownerUserId,
      visibility: 'private',
      teamId: null,
      name,
      description: null,
      repo: { url: 'https://github.com/acme/app', ref: 'main', connectionId: null },
      image: { base: 'standard', ref: 'almyty/runner-env:standard' },
      setupScript: 'npm ci',
      envBindings: [],
      cache: { paths: [] },
      egress: { allowHosts: ['registry.npmjs.org'] },
      resourceClass: 'small',
      idleTimeoutMinutes: 15,
      clusterConnectionId: null,
      version: 1,
    }));
  }

  /** What a pod does when it starts: enroll with the token in its Secret, connect, heartbeat. */
  async function podStarts(hostedRunnerId: string, organizationId: string): Promise<string> {
    const token = stub.pods.get(hostedRunnerId)!.secretEnv!.ALMYTY_ENROLLMENT_TOKEN;
    const enrolled = await enrollment.enroll({
      token,
      runtimeInfo: { os: 'linux', arch: 'x64', hostname: 'pod', cpuCount: 1, memoryMb: 2048, runnerVersion: '1.5.3', binaries: {} },
    });
    const claims = credentials.verify(enrolled.credential)!;
    expect(claims).toMatchObject({ runnerId: enrolled.runnerId, organizationId, hostedRunnerId });
    // The stream binds the session to the runner the credential names.
    expect(await runners.isOwnedBy(enrolled.runnerId, organizationId, runnerSessionUser(enrolled.runnerId))).toBe(true);
    const session = `sess-${crypto.randomUUID()}`;
    await runners.onSessionConnect(enrolled.runnerId, session);
    await runners.heartbeat(enrolled.runnerId);
    return enrolled.runnerId;
  }

  describe('the schema', () => {
    it('keeps one self-hosted runner per account and allows any number of hosted ones', async () => {
      const { organizationId, userId } = await seedMember(ds, 'uq');
      const insert = (kind: 'self' | 'hosted', name: string) =>
        ds.query(
          `INSERT INTO runners (name, "ownerUserId", "organizationId", kind, "hostedRunnerId") VALUES ($1, $2, $3, $4, $5)`,
          [name, userId, organizationId, kind, kind === 'hosted' ? crypto.randomUUID() : null],
        );
      await insert('self', 'laptop');
      await expect(insert('self', 'desktop')).rejects.toThrow(/UQ_runners_owner_org/);
      await insert('hosted', 'env-a-1');
      await insert('hosted', 'env-a-2');
      // A hosted runner always names its hosted_runners row, a self one never.
      await expect(ds.query(`INSERT INTO runners (name, "ownerUserId", "organizationId", kind) VALUES ('x', $1, $2, 'hosted')`, [userId, organizationId])).rejects.toThrow(/CHK_runners_kind/);
    });

    it('lets only a persistent workspace be suspended, and only one live one per environment, owner and agent', async () => {
      const { organizationId, userId } = await seedMember(ds, 'ws');
      const env = await environment(organizationId, userId);
      const [runner] = await ds.query(
        `INSERT INTO runners (name, "ownerUserId", "organizationId", kind, "hostedRunnerId") VALUES ('env-x', $1, $2, 'hosted', $3) RETURNING id`,
        [userId, organizationId, crypto.randomUUID()],
      );
      const insert = (kind: string, status: string) =>
        ds.query(
          `INSERT INTO workspaces ("runnerId", "ownerUserId", "organizationId", cwd, isolation, status, kind, "environmentId") VALUES ($1, $2, $3, '/workspace', 'host', $4, $5, $6)`,
          [runner.id, userId, organizationId, status, kind, kind === 'persistent' ? env.id : null],
        );
      await expect(insert('job', 'suspended')).rejects.toThrow(/CHK_workspaces_status/);
      await insert('persistent', 'suspended');
      await expect(insert('persistent', 'active')).rejects.toThrow(/UQ_workspaces_persistent_live/);
      await ds.query(`UPDATE workspaces SET status = 'released' WHERE kind = 'persistent' AND "environmentId" = $1`, [env.id]);
      await insert('persistent', 'active');
    });

    it('allows one open usage interval per hosted runner', async () => {
      const { organizationId } = await seedMember(ds, 'usage');
      const hr = crypto.randomUUID();
      const insert = () =>
        ds.query(
          `INSERT INTO runner_usage_intervals ("organizationId", "hostedRunnerId", "environmentId", "workspaceId", "resourceClass", "startedAt") VALUES ($1, $2, $3, $4, 'small', now())`,
          [organizationId, hr, crypto.randomUUID(), crypto.randomUUID()],
        );
      await insert();
      await expect(insert()).rejects.toThrow(/UQ_runner_usage_intervals_open/);
    });
  });

  describe('a hosted workspace\'s life', () => {
    let organizationId: string;
    let userId: string;
    let env: Environment;
    let first: HostedTarget;
    const caller = () => ({ organizationId, callerUserId: userId });
    const hrRow = async (id: string) => (await ds.getRepository(HostedRunner).findOneByOrFail({ id }));
    const wsRow = async (id: string) => (await ds.getRepository(Workspace).findOneByOrFail({ id }));

    beforeAll(async () => {
      ({ organizationId, userId } = await seedMember(ds, 'life'));
      env = await environment(organizationId, userId);
    });

    it('is made on first use, parked, and woken: the call is told to try again', async () => {
      first = await hosted.resolveTarget(env.id, caller());
      expect(first).toMatchObject({ kind: 'waking', retryAfterMs: settings.current.wake.retryAfterSeconds * 1000 });
      const ws = await wsRow(first.workspaceId);
      expect(ws).toMatchObject({ kind: 'persistent', status: WorkspaceStatus.SUSPENDED, environmentId: env.id, ownerUserId: userId, runId: null, ttlAt: null, cwd: '/workspace' });
      const runner = await ds.getRepository(Runner).findOneByOrFail({ id: ws.runnerId });
      expect(runner).toMatchObject({ kind: 'hosted', hostedRunnerId: first.hostedRunnerId, visibility: 'private' });
      expect((await hrRow(first.hostedRunnerId)).desired).toMatchObject({ replicas: 1, resourceClass: 'small' });
      // A second call finds the same workspace.
      expect((await hosted.resolveTarget(env.id, caller())).workspaceId).toBe(first.workspaceId);
    });

    it('starts a pod with a single-use token; the runner enrolls with it and the machine goes ready', async () => {
      await processor.reconcile(first.hostedRunnerId);
      expect((await hrRow(first.hostedRunnerId)).state).toBe('provisioning');
      expect(stub.pods.get(first.hostedRunnerId)!.replicas).toBe(1);
      const tokenRows = await ds.getRepository(RunnerEnrollmentToken).findBy({ hostedRunnerId: first.hostedRunnerId });
      const token = stub.pods.get(first.hostedRunnerId)!.secretEnv!.ALMYTY_ENROLLMENT_TOKEN;
      expect(tokenRows.map((t) => t.tokenHash)).toEqual([crypto.createHash('sha256').update(token).digest('hex')]);

      await podStarts(first.hostedRunnerId, organizationId);
      // The token is spent.
      await expect(enrollment.enroll({ token, runtimeInfo: {} as any })).rejects.toThrow(/not valid/);

      await processor.reconcile(first.hostedRunnerId);
      expect(await hrRow(first.hostedRunnerId)).toMatchObject({ state: 'ready' });
      expect((await wsRow(first.workspaceId)).status).toBe(WorkspaceStatus.ACTIVE);
      const open = await ds.getRepository(RunnerUsageInterval).findBy({ hostedRunnerId: first.hostedRunnerId });
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({ endedAt: null, resourceClass: 'small', environmentId: env.id, workspaceId: first.workspaceId });

      const ready = await hosted.resolveTarget(env.id, caller());
      expect(ready).toMatchObject({ kind: 'ready', workspaceId: first.workspaceId });
      // Dispatch accepts the persistent workspace like any live one of the caller's.
      const runnerId = (ready as any).runnerId;
      expect(await workspaces.findForDispatch(first.workspaceId, runnerId, userId)).toMatchObject({ id: first.workspaceId });
      expect(await workspaces.findForDispatch(first.workspaceId, runnerId, crypto.randomUUID())).toBeNull();
    });

    it('goes idle and is suspended, never stranded, and its usage interval closes', async () => {
      const longAgo = new Date(Date.now() - settings.minutes(env.idleTimeoutMinutes + 1));
      await ds.getRepository(HostedRunner).update({ id: first.hostedRunnerId }, { lastActiveAt: longAgo });
      expect(await hosted.suspendIdle(new Date())).toEqual([first.hostedRunnerId]);
      await processor.reconcile(first.hostedRunnerId);
      expect((await hrRow(first.hostedRunnerId)).state).toBe('suspending');
      await processor.reconcile(first.hostedRunnerId);
      expect((await hrRow(first.hostedRunnerId)).state).toBe('suspended');
      const ws = await wsRow(first.workspaceId);
      expect(ws.status).toBe(WorkspaceStatus.SUSPENDED);
      expect(stub.pods.get(first.hostedRunnerId)).toMatchObject({ volume: true, secretEnv: null });
      const [interval] = await ds.getRepository(RunnerUsageInterval).findBy({ hostedRunnerId: first.hostedRunnerId });
      expect(interval.endedAt).not.toBeNull();

      // The runner went away; the runner tick and the stranding fan-out
      // leave a hosted workspace alone, and run-end release never sees it.
      const runner = await ds.getRepository(Runner).findOneByOrFail({ id: ws.runnerId });
      expect(runner.state).toBe(RunnerState.OFFLINE);
      await ds.getRepository(Workspace).update({ id: ws.id }, { status: WorkspaceStatus.ACTIVE });
      const tick = await runners.tick(new Date(Date.now() + 3_600_000));
      expect(tick.markStrandedFor).not.toContain(runner.id);
      expect(await workspaces.markStrandedForRunners([runner.id])).toBe(0);
      expect(await workspaces.releaseForEndedRuns()).toBe(0);
      await ds.getRepository(Workspace).update({ id: ws.id }, { status: WorkspaceStatus.SUSPENDED });
    });

    it('wakes again on the same volume, with a new token, and records a second interval', async () => {
      const again = await hosted.resolveTarget(env.id, caller());
      expect(again).toMatchObject({ kind: 'waking', workspaceId: first.workspaceId, hostedRunnerId: first.hostedRunnerId });
      const provisions = stub.calls.filter((c) => c === `provision:${first.hostedRunnerId}`).length;
      await processor.reconcile(first.hostedRunnerId);
      expect(stub.calls.filter((c) => c === `provision:${first.hostedRunnerId}`).length).toBe(provisions);
      await podStarts(first.hostedRunnerId, organizationId);
      await processor.reconcile(first.hostedRunnerId);
      expect((await hrRow(first.hostedRunnerId)).state).toBe('ready');
      expect((await wsRow(first.workspaceId)).status).toBe(WorkspaceStatus.ACTIVE);
      expect(await ds.getRepository(RunnerUsageInterval).countBy({ hostedRunnerId: first.hostedRunnerId })).toBe(2);
      const minutes = await usage.minutesByClass(organizationId, new Date(Date.now() - 86_400_000), new Date(Date.now() + 60_000));
      expect(Object.keys(minutes)).toEqual(['small']);
    });

    it('is noticed on the notice day and expired, volume and all, after the retention window', async () => {
      await hosted.suspend(first.workspaceId, userId, organizationId);
      await processor.reconcile(first.hostedRunnerId);
      await processor.reconcile(first.hostedRunnerId);
      expect((await wsRow(first.workspaceId)).status).toBe(WorkspaceStatus.SUSPENDED);

      const day = settings.minutes(24 * 60);
      const { keepDays, noticeDay } = settings.current.suspendedRetention;
      await ds.getRepository(Workspace).update({ id: first.workspaceId }, { lastActiveAt: new Date(Date.now() - (noticeDay + 1) * day) });
      expect(await hosted.sweepSuspended(new Date())).toEqual({ noticed: 1, expired: 0 });
      expect(notifications.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'environments.workspace_expiring', userIds: [userId] }));
      expect(await hosted.sweepSuspended(new Date())).toEqual({ noticed: 0, expired: 0 });

      await ds.getRepository(Workspace).update({ id: first.workspaceId }, { lastActiveAt: new Date(Date.now() - (keepDays + 1) * day) });
      expect(await hosted.sweepSuspended(new Date())).toEqual({ noticed: 0, expired: 1 });
      expect((await wsRow(first.workspaceId)).status).toBe(WorkspaceStatus.EXPIRED);
      await processor.reconcile(first.hostedRunnerId);
      expect(await hrRow(first.hostedRunnerId)).toMatchObject({ state: 'torn_down', externalRef: null });
      expect(stub.calls).toContain(`teardown:${first.hostedRunnerId}:delete`);

      // Used again, the environment gets a fresh workspace.
      const fresh = await hosted.resolveTarget(env.id, caller());
      expect(fresh.workspaceId).not.toBe(first.workspaceId);
    });
  });

  describe('capacity and access', () => {
    it('refuses a new workspace past the organization\'s capacity and a wake past its concurrency', async () => {
      const { organizationId, userId } = await seedMember(ds, 'cap');
      const a = await environment(organizationId, userId, 'a');
      const b = await environment(organizationId, userId, 'b');
      capacity = { maxConcurrentRunners: 1, maxWorkspaces: 1, resourceClasses: null };
      try {
        await hosted.resolveTarget(a.id, { organizationId, callerUserId: userId });
        await expect(hosted.resolveTarget(b.id, { organizationId, callerUserId: userId })).rejects.toMatchObject({ code: 'capacity_exhausted' });
        capacity = { maxConcurrentRunners: 1, maxWorkspaces: 5, resourceClasses: null };
        await expect(hosted.resolveTarget(b.id, { organizationId, callerUserId: userId })).rejects.toMatchObject({ code: 'CAPACITY_EXHAUSTED' });
      } finally {
        capacity = { maxConcurrentRunners: 2, maxWorkspaces: 10, resourceClasses: null };
      }
    });

    it('does not let another member use a private environment', async () => {
      const { organizationId, userId } = await seedMember(ds, 'priv');
      const env = await environment(organizationId, userId);
      const other = crypto.randomUUID();
      await ds.query(
        `INSERT INTO users (id, email, "passwordHash", "firstName", "lastName", "isActive") VALUES ($1, $2, 'x', 'Bo', 'Member', true)`,
        [other, `bo-${other.slice(0, 6)}@example.com`],
      );
      await ds.query(`INSERT INTO user_organizations ("userId", "organizationId", role, "isActive", "inviteAccepted") VALUES ($1, $2, 'member', true, true)`, [other, organizationId]);
      await expect(hosted.resolveTarget(env.id, { organizationId, callerUserId: other })).rejects.toMatchObject({ code: 'runner_not_found' });
    });
  });
});

/**
 * The migration on a database that already has runners and workspaces:
 * every existing runner becomes `self` and every workspace `job`, the
 * one-runner index keeps covering them, and down() restores the schema.
 */
describeIfDb('HostedRunners migration on existing data', () => {
  const SCHEMA = 'hosted_runners_migration_test';
  const TARGET = '1791000200000';
  let ds: DataSource;

  beforeAll(async () => {
    await freshSchema(SCHEMA);
    const dir = join(__dirname, '..', '..', 'migrations');
    const before = readdirSync(dir)
      .filter((f) => /^\d+-.*\.ts$/.test(f) && f.split('-')[0] < TARGET)
      .sort()
      .flatMap((f) => Object.values(require(join(dir, f))).filter((v) => typeof v === 'function'));
    ds = dataSource(SCHEMA, before as any[]);
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  async function run(direction: 'up' | 'down'): Promise<void> {
    const q = ds.createQueryRunner();
    await q.startTransaction();
    try {
      await new HostedRunners1791000200000()[direction](q);
      await q.commitTransaction();
    } catch (err) {
      await q.rollbackTransaction();
      throw err;
    } finally {
      await q.release();
    }
  }

  it('reads existing runners as self and workspaces as job, then reverses', async () => {
    const { organizationId, userId } = await seedMember(ds, 'mig');
    const [runner] = await ds.query(`INSERT INTO runners (name, "ownerUserId", "organizationId", state) VALUES ('laptop', $1, $2, 'online') RETURNING id`, [userId, organizationId]);
    for (const status of ['active', 'released', 'stranded']) {
      await ds.query(
        `INSERT INTO workspaces ("runnerId", "ownerUserId", "organizationId", cwd, isolation, status) VALUES ($1, $2, $3, '/w', $4, $5)`,
        [runner.id, userId, organizationId, RunnerIsolationTier.HOST, status],
      );
    }

    await run('up');
    expect(await ds.query(`SELECT kind, "hostedRunnerId" FROM runners WHERE id = $1`, [runner.id])).toEqual([{ kind: 'self', hostedRunnerId: null }]);
    const kinds = await ds.query(`SELECT DISTINCT kind FROM workspaces WHERE "runnerId" = $1`, [runner.id]);
    expect(kinds).toEqual([{ kind: 'job' }]);
    await expect(
      ds.query(`INSERT INTO runners (name, "ownerUserId", "organizationId") VALUES ('second', $1, $2)`, [userId, organizationId]),
    ).rejects.toThrow(/UQ_runners_owner_org/);

    await run('down');
    const columns = await ds.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'runners' AND column_name = 'kind'`, [SCHEMA]);
    expect(columns).toEqual([]);
    expect(await ds.query(`SELECT count(*)::int AS n FROM workspaces WHERE "runnerId" = $1`, [runner.id])).toEqual([{ n: 3 }]);
    await expect(ds.query(`INSERT INTO workspaces ("runnerId", "ownerUserId", "organizationId", cwd, isolation, status) VALUES ($1, $2, $3, '/w', 'host', 'suspended')`, [runner.id, userId, organizationId])).rejects.toThrow(/workspaces_status_check/);
    // And forward again, as a redeploy would.
    await run('up');
  });
});
