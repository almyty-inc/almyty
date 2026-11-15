import { randomUUID } from 'crypto';
import { ConflictException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';

import { Runner, RunnerIsolationTier } from '../../entities/runner.entity';
import { RunnerSession } from '../../entities/runner-session.entity';
import { Workspace, WorkspaceStatus } from '../../entities/workspace.entity';
import { Tool } from '../../entities/tool.entity';
import { Agent } from '../../entities/agent.entity';
import { User } from '../../entities/user.entity';
import { Organization } from '../../entities/organization.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { UserTeam } from '../../entities/user-team.entity';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { RunnerService } from '../../modules/runner/runner.service';
import { RunnerCapabilityPublisher } from '../../modules/runner/runner-capability.publisher';
import { RunWorkspaceService } from '../../modules/runner/run-workspace.service';
import { provisionExtensionsInPublic } from './test-db-extensions';

/**
 * Deleting a runner that has served an agent run's shell tool, against a
 * real Postgres.
 *
 * The staging gate saw that DELETE get no answer for over three minutes:
 * the request reached the tool cleanup and then waited in the runner's
 * delete. The delete takes row locks on the runner and, by ON DELETE
 * CASCADE, on every workspace the run was given; with no time bound it
 * waited for as long as anything else held one. These tests give the
 * runner a run's workspace the way a tool call does (RunWorkspaceService),
 * then delete it: alone it must finish at once and release the workspace;
 * against a transaction that holds the workspace row (seen in pg_locks /
 * pg_stat_activity as the blocker) it must answer 409 within its lock
 * timeout, and succeed once the holder is gone.
 */
const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'runner_delete_after_run_test';

jest.setTimeout(90_000);

describeIfDb('Deleting a runner that served a run (real Postgres)', () => {
  let ds: DataSource;
  let runners: RunnerService;
  let runWorkspaces: RunWorkspaceService;
  let userId: string;
  let organizationId: string;

  const connection = {
    type: 'postgres' as const,
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || '',
    database: process.env.DATABASE_NAME || 'almyty_test',
  };

  beforeAll(async () => {
    const bootstrap = new DataSource(connection);
    await bootstrap.initialize();
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await provisionExtensionsInPublic((sql, params) => bootstrap.query(sql, params as any[]));
    await bootstrap.destroy();

    ds = new DataSource({
      ...connection,
      schema: SCHEMA,
      entities: [__dirname + '/../../entities/*.entity{.ts,.js}'],
      extra: { options: `-c search_path=${SCHEMA},public` },
      migrations: [__dirname + '/../../migrations/*{.ts,.js}'],
      migrationsRun: true,
      migrationsTransactionMode: 'each',
      dropSchema: true,
    });
    await ds.initialize();

    const org = await ds.getRepository(Organization).save({ name: 'Delete Org', slug: 'delete-org' } as any);
    organizationId = (org as any).id;
    const user = await ds.getRepository(User).save({ email: 'runner-delete@example.com', passwordHash: 'x', firstName: 'R', lastName: 'D' } as any);
    userId = (user as any).id;
    await ds.getRepository(UserOrganization).save({ userId, organizationId, role: OrganizationRole.OWNER, isActive: true } as any);

    runners = new RunnerService(
      ds.getRepository(Runner),
      ds.getRepository(RunnerSession),
      ds.getRepository(Workspace),
      new RunnerCapabilityPublisher(ds.getRepository(Tool)),
      new AccessPolicyService(ds.getRepository(UserOrganization), ds.getRepository(UserTeam)),
    );
    // The runner makes the folder; here it answers at once with one.
    const calls = { dispatch: async () => ({ ok: true, result: { cwd: '/tmp/run-folder' } }) };
    runWorkspaces = new RunWorkspaceService(ds.getRepository(Workspace), ds.getRepository(Agent), runners, calls as any);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  beforeEach(async () => {
    await ds.query('TRUNCATE TABLE workspaces, runner_sessions, runners CASCADE');
    await ds.query(`DELETE FROM tools WHERE "runnerConfig"->>'runnerId' IS NOT NULL`);
  });

  /** A connected runner with its tools published, and a run's workspace on it. */
  async function runnerThatServedARun(): Promise<{ runner: Runner; workspace: Workspace }> {
    const { runner } = await runners.register({
      name: 'gate-runner',
      labels: {},
      runtimeInfo: {
        os: 'darwin', arch: 'arm64', hostname: 'mac', cpuCount: 8, memoryMb: 16_000,
        runnerVersion: '1.5.9', binaries: { node: 'v26', git: '2.47', python: null },
      },
      config: {
        defaultIsolation: RunnerIsolationTier.HOST, maxConcurrent: 4, allowedCwdRoots: ['/tmp'],
        denyPatterns: [], networkBlocked: false, installBlocked: false,
      },
    } as any, userId, organizationId);
    await runners.heartbeat(runner.id);
    const workspace = await runWorkspaces.acquire({ runnerId: runner.id, organizationId, runId: randomUUID(), callerUserId: userId });
    expect(workspace.status).toBe(WorkspaceStatus.ACTIVE);
    expect(await ds.query(`SELECT 1 FROM tools WHERE "runnerConfig"->>'runnerId' = $1`, [runner.id])).not.toHaveLength(0);
    return { runner, workspace };
  }

  async function timed<T>(work: () => Promise<T>): Promise<{ ms: number; result?: T; error?: unknown }> {
    const started = Date.now();
    try {
      const result = await work();
      return { ms: Date.now() - started, result };
    } catch (error) {
      return { ms: Date.now() - started, error };
    }
  }

  it('deletes at once, with its workspace and its tools', async () => {
    const { runner, workspace } = await runnerThatServedARun();
    const { ms, error } = await timed(() => runners.unregister(runner.id, userId, organizationId));
    expect(error).toBeUndefined();
    expect(ms).toBeLessThan(3_000);
    expect(await ds.getRepository(Runner).findOneBy({ id: runner.id })).toBeNull();
    expect(await ds.getRepository(Workspace).findOneBy({ id: workspace.id })).toBeNull();
    expect(await ds.query(`SELECT 1 FROM tools WHERE "runnerConfig"->>'runnerId' = $1`, [runner.id])).toHaveLength(0);
  });

  it('answers 409 within its lock timeout while another transaction holds the workspace, then deletes once it is gone', async () => {
    const { runner, workspace } = await runnerThatServedARun();
    const holder: QueryRunner = ds.createQueryRunner();
    await holder.connect();
    try {
      await holder.startTransaction();
      await holder.query(`UPDATE workspaces SET "updatedAt" = now() WHERE id = $1`, [workspace.id]);
      const [{ pid: holderPid }] = await holder.query('SELECT pg_backend_pid() AS pid');

      const attempt = timed(() => runners.unregister(runner.id, userId, organizationId));
      // While it waits, Postgres names the holder as what blocks it.
      let blockedBy: number[] = [];
      for (let i = 0; i < 40 && !blockedBy.length; i++) {
        const rows = await ds.query(
          `SELECT pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%workspaces%'`,
        );
        blockedBy = rows.flatMap((r: any) => r.blockers);
        if (!blockedBy.length) await new Promise((r) => setTimeout(r, 100));
      }
      expect(blockedBy).toContain(holderPid);

      const { ms, error } = await attempt;
      expect(error).toBeInstanceOf(ConflictException);
      expect(ms).toBeLessThan(10_000);
      // Nothing half-done: the runner, its workspace and its tools are all still there.
      expect(await ds.getRepository(Runner).findOneBy({ id: runner.id })).not.toBeNull();
      expect(await ds.query(`SELECT 1 FROM tools WHERE "runnerConfig"->>'runnerId' = $1`, [runner.id])).not.toHaveLength(0);
    } finally {
      if (holder.isTransactionActive) await holder.rollbackTransaction();
      await holder.release();
    }

    const again = await timed(() => runners.unregister(runner.id, userId, organizationId));
    expect(again.error).toBeUndefined();
    expect(again.ms).toBeLessThan(3_000);
    expect(await ds.getRepository(Workspace).findOneBy({ id: workspace.id })).toBeNull();
  });
});
