import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Runner, RunnerIsolationTier, RunnerState } from '../../entities/runner.entity';
import { RunnerSession } from '../../entities/runner-session.entity';
import { Workspace } from '../../entities/workspace.entity';
import { Tool } from '../../entities/tool.entity';
import { User } from '../../entities/user.entity';
import { Organization } from '../../entities/organization.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { UserTeam, TeamRole } from '../../entities/user-team.entity';
import { Team } from '../../entities/team.entity';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { ExecutionAccessService, gatewayPrincipal, userPrincipal } from '../../common/authorization/execution-access.service';
import { RunnerService } from '../../modules/runner/runner.service';
import { RunnerCapabilityPublisher } from '../../modules/runner/runner-capability.publisher';

/**
 * Runner visibility against a real Postgres, through the real access
 * policy and the real migrations (including 1750808000000-
 * PrivateVisibility). The unit specs model the repositories; this one
 * proves the SQL: the list filter, the owner-bound hello check, the
 * published tools' visibility and the table's CHECK constraint.
 *
 * One organization, three people: alice and bob are plain members,
 * carol is an org admin.
 *
 * Gated on RUN_DB_INTEGRATION=1 like every other integration spec.
 */
const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'runner_visibility_test';

jest.setTimeout(60_000);

describeIfDb('Runner visibility (real Postgres)', () => {
  let ds: DataSource;
  let runners: RunnerService;
  let policy: AccessPolicyService;
  let organizationId: string;
  let alice: string;
  let bob: string;
  let carol: string;

  const connection = {
    type: 'postgres' as const,
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || '',
    database: process.env.DATABASE_NAME || 'almyty_test',
  };

  const input = (name: string) => ({
    name,
    labels: {},
    runtimeInfo: {
      os: 'darwin', arch: 'arm64', hostname: 'mac', cpuCount: 8, memoryMb: 16_000,
      runnerVersion: '1.5.0', binaries: { node: 'v22' },
    },
    config: {
      defaultIsolation: RunnerIsolationTier.HOST,
      maxConcurrent: 2,
      allowedCwdRoots: [],
      denyPatterns: [],
      networkBlocked: false,
      installBlocked: true,
    },
  });

  beforeAll(async () => {
    const bootstrap = new DataSource(connection);
    await bootstrap.initialize();
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await bootstrap.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public`);
    await bootstrap.destroy();

    ds = new DataSource({
      ...connection,
      schema: SCHEMA,
      entities: [__dirname + '/../../entities/*.entity{.ts,.js}'],
      extra: { options: `-c search_path=${SCHEMA},public` },
      migrations: [__dirname + '/../../migrations/*{.ts,.js}'],
      migrationsRun: true,
      dropSchema: true,
    });
    await ds.initialize();

    const org = await ds.getRepository(Organization).save(
      ds.getRepository(Organization).create({ name: 'Visibility Org', slug: 'visibility-org' } as any),
    );
    organizationId = (org as any).id;
    const makeUser = async (email: string, role: OrganizationRole) => {
      const user = await ds.getRepository(User).save(
        ds.getRepository(User).create({ email, passwordHash: 'x', firstName: 'T', lastName: 'U' } as any),
      );
      const id = (user as any).id as string;
      await ds.getRepository(UserOrganization).save(
        ds.getRepository(UserOrganization).create({ userId: id, organizationId, role, isActive: true }),
      );
      return id;
    };
    alice = await makeUser('alice@example.com', OrganizationRole.MEMBER);
    bob = await makeUser('bob@example.com', OrganizationRole.MEMBER);
    carol = await makeUser('carol@example.com', OrganizationRole.ADMIN);

    policy = new AccessPolicyService(ds.getRepository(UserOrganization), ds.getRepository(UserTeam));
    runners = new RunnerService(
      ds.getRepository(Runner),
      ds.getRepository(RunnerSession),
      ds.getRepository(Workspace),
      new RunnerCapabilityPublisher(ds.getRepository(Tool)),
      policy,
    );
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  beforeEach(async () => {
    await ds.query('TRUNCATE TABLE workspaces, runner_sessions, runners CASCADE');
    await ds.query(`DELETE FROM tools WHERE "runnerConfig" IS NOT NULL`);
  });

  it('lists a private runner to its owner only -- not to another member, not to an admin', async () => {
    const { runner } = await runners.register({ ...input('alice-mac'), visibility: 'private' }, alice, organizationId);

    expect((await runners.listVisible(alice, organizationId)).map(r => r.id)).toEqual([runner.id]);
    expect(await runners.listVisible(bob, organizationId)).toEqual([]);
    expect(await runners.listVisible(carol, organizationId)).toEqual([]);
  });

  it('lists an org-wide runner to every member', async () => {
    const { runner } = await runners.register({ ...input('shared-box'), visibility: 'org' }, alice, organizationId);
    for (const user of [alice, bob, carol]) {
      expect((await runners.listVisible(user, organizationId)).map(r => r.id)).toEqual([runner.id]);
    }
  });

  it('fetch and dispatch of a private runner answer 404 to everyone but the owner', async () => {
    const { runner } = await runners.register({ ...input('alice-mac'), visibility: 'private' }, alice, organizationId);
    await ds.getRepository(Runner).update({ id: runner.id }, { state: RunnerState.ONLINE });

    await expect(runners.getOne(runner.id, alice, organizationId)).resolves.toMatchObject({ id: runner.id });
    await expect(runners.resolveForDispatch(runner.id, alice)).resolves.toMatchObject({ id: runner.id });
    for (const user of [bob, carol]) {
      await expect(runners.getOne(runner.id, user, organizationId)).rejects.toBeInstanceOf(NotFoundException);
      await expect(runners.resolveForDispatch(runner.id, user)).rejects.toBeInstanceOf(NotFoundException);
    }
  });

  it('binds a daemon session only to a runner of the same user (runner.hello check)', async () => {
    const { runner } = await runners.register(input('alice-mac'), alice, organizationId);
    expect(await runners.isOwnedBy(runner.id, organizationId, alice)).toBe(true);
    expect(await runners.isOwnedBy(runner.id, organizationId, bob)).toBe(false);
    expect(await runners.isOwnedBy(runner.id, organizationId, carol)).toBe(false);
  });

  it('publishes runner tools with the runner\'s visibility and owner, so the tool list hides them too', async () => {
    const { runner } = await runners.register({ ...input('alice-mac'), visibility: 'private' }, alice, organizationId);
    const tools = await ds.getRepository(Tool).find({ where: { organizationId } });
    const mine = tools.filter(t => (t.runnerConfig as any)?.runnerId === runner.id);
    expect(mine.length).toBeGreaterThan(0);
    for (const tool of mine) {
      expect(tool.visibility).toBe('private');
      expect(tool.createdBy).toBe(alice);
    }

    const visibleTo = async (user: string) => {
      const qb = ds.getRepository(Tool).createQueryBuilder('tool');
      await policy.applyListFilter(qb, { id: user }, organizationId, 'tool', { ownerColumn: 'createdBy' });
      return (await qb.getMany()).filter(t => (t.runnerConfig as any)?.runnerId === runner.id);
    };
    expect((await visibleTo(alice)).length).toBe(mine.length);
    expect(await visibleTo(bob)).toEqual([]);
    expect(await visibleTo(carol)).toEqual([]);
  });

  it('refuses a second member registering a name already in use, leaving the owner\'s tools on the owner\'s runner', async () => {
    const { runner } = await runners.register({ ...input('franemb'), visibility: 'org' }, alice, organizationId);
    await expect(runners.register({ ...input('franemb'), visibility: 'org' }, bob, organizationId))
      .rejects.toBeInstanceOf(ConflictException);

    const tools = await ds.getRepository(Tool).find({ where: { organizationId } });
    const named = tools.filter(t => t.name.startsWith('runner.franemb.'));
    expect(named.length).toBeGreaterThan(0);
    for (const tool of named) expect((tool.runnerConfig as any).runnerId).toBe(runner.id);
  });

  it('keeps the web-chosen visibility when the daemon re-registers without one', async () => {
    const pending = await runners.create({ name: 'alice-mac', visibility: 'org' }, alice, organizationId);
    const { runner } = await runners.register(input('alice-mac'), alice, organizationId);
    expect(runner.id).toBe(pending.id);
    expect(runner.visibility).toBe('org');
  });

  it('the database refuses a private row without an owner', async () => {
    await expect(ds.query(
      `INSERT INTO tools (name, "organizationId", visibility, "createdBy") VALUES ('orphan', $1, 'private', NULL)`,
      [organizationId],
    )).rejects.toThrow(/visibility_team_chk/);
  });

  it("dispatch from a gateway run is judged by the gateway's scope: a team runner takes work from its team's gateway only", async () => {
    // The gateway run has no user; before, it was judged as nobody, so a
    // team runner refused its own team's gateway while the tool it serves
    // was allowed (ExecutionAccessService's gateway rule).
    const team = await ds.getRepository(Team).save(ds.getRepository(Team).create({ name: 'Build', organizationId } as any));
    const teamId = (team as any).id as string;
    const otherTeam = await ds.getRepository(Team).save(ds.getRepository(Team).create({ name: 'Ops', organizationId } as any));
    await ds.getRepository(UserTeam).save(ds.getRepository(UserTeam).create({ userId: alice, teamId, role: TeamRole.MEMBER, isActive: true }));
    const gated = new RunnerService(
      ds.getRepository(Runner),
      ds.getRepository(RunnerSession),
      ds.getRepository(Workspace),
      new RunnerCapabilityPublisher(ds.getRepository(Tool)),
      policy,
      new ExecutionAccessService(policy),
    );
    const { runner } = await gated.register({ ...input('build-box'), visibility: 'team', teamId }, alice, organizationId);
    await ds.getRepository(Runner).update({ id: runner.id }, { state: RunnerState.ONLINE });
    const viaGateway = (visibility: 'org' | 'team' | 'private', over: Record<string, any> = {}) =>
      gatewayPrincipal({ id: '00000000-0000-4000-8000-0000000000aa', organizationId, visibility, ...over });

    await expect(gated.resolveForDispatch(runner.id, viaGateway('team', { teamId }))).resolves.toMatchObject({ id: runner.id });
    await expect(gated.resolveForDispatch(runner.id, viaGateway('private', { ownerUserId: alice }))).resolves.toMatchObject({ id: runner.id });
    for (const principal of [
      viaGateway('org'),
      viaGateway('team', { teamId: (otherTeam as any).id }),
      viaGateway('private', { ownerUserId: bob }),
    ]) {
      await expect(gated.resolveForDispatch(runner.id, principal)).rejects.toBeInstanceOf(NotFoundException);
    }
    // A user principal is still that user.
    await expect(gated.resolveForDispatch(runner.id, userPrincipal(alice))).resolves.toMatchObject({ id: runner.id });
    await expect(gated.resolveForDispatch(runner.id, userPrincipal(bob))).rejects.toBeInstanceOf(NotFoundException);
  });
});
