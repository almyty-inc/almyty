import { BadRequestException, NotFoundException } from '@nestjs/common';
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
import { ExecutionAccessService, gatewayPrincipal } from '../../common/authorization/execution-access.service';
import { RunnerService } from '../../modules/runner/runner.service';
import { RunnerCapabilityPublisher } from '../../modules/runner/runner-capability.publisher';
import { WorkspaceService } from '../../modules/workspace/workspace.service';

/**
 * Label routing against a real Postgres: runners with json label
 * columns, real sessions, the real access policy and the real
 * migrations. A dispatch or a workspace that asks for `gpu=yes` lands on
 * an online runner with that label which its caller may use, and when
 * there is none the answer is "No machine with gpu=yes is online".
 *
 * One organization: alice and bob are plain members, carol an org admin,
 * dave a member on the Build team with alice. One runner per member.
 *
 * Gated on RUN_DB_INTEGRATION=1 like every other integration spec.
 */
const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'runner_label_routing_test';

jest.setTimeout(60_000);

describeIfDb('Runner label routing (real Postgres)', () => {
  let ds: DataSource;
  let runners: RunnerService;
  let workspaces: WorkspaceService;
  let policy: AccessPolicyService;
  let organizationId: string;
  let otherOrganizationId: string;
  let alice: string;
  let bob: string;
  let carol: string;
  let dave: string;
  let buildTeam: string;

  const connection = {
    type: 'postgres' as const,
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || '',
    database: process.env.DATABASE_NAME || 'almyty_test',
  };

  const input = (name: string, labels: Record<string, string>) => ({
    name,
    labels,
    runtimeInfo: {
      os: 'darwin', arch: 'arm64', hostname: name, cpuCount: 8, memoryMb: 16_000,
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

  /** Register a machine, bring it online and give it a live daemon session. */
  const machine = async (
    owner: string,
    name: string,
    labels: Record<string, string>,
    opts: { visibility?: 'org' | 'team' | 'private'; state?: RunnerState; session?: boolean; org?: string } = {},
  ) => {
    const { runner } = await runners.register(
      {
        ...input(name, labels),
        visibility: opts.visibility ?? 'org',
        teamId: opts.visibility === 'team' ? buildTeam : null,
      },
      owner,
      opts.org ?? organizationId,
    );
    await ds.getRepository(Runner).update({ id: runner.id }, { state: opts.state ?? RunnerState.ONLINE, lastHeartbeatAt: new Date() });
    if (opts.session !== false) await runners.onSessionConnect(runner.id, `sh_${name}`);
    return runner;
  };

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

    const orgs = ds.getRepository(Organization);
    organizationId = ((await orgs.save(orgs.create({ name: 'Label Org', slug: 'label-org' } as any))) as any).id;
    otherOrganizationId = ((await orgs.save(orgs.create({ name: 'Other Org', slug: 'other-org' } as any))) as any).id;
    const makeUser = async (email: string, role: OrganizationRole, orgIds = [organizationId]) => {
      const user = await ds.getRepository(User).save(
        ds.getRepository(User).create({ email, passwordHash: 'x', firstName: 'T', lastName: 'U' } as any),
      );
      const id = (user as any).id as string;
      for (const org of orgIds) {
        await ds.getRepository(UserOrganization).save(
          ds.getRepository(UserOrganization).create({ userId: id, organizationId: org, role, isActive: true }),
        );
      }
      return id;
    };
    alice = await makeUser('alice@example.com', OrganizationRole.MEMBER, [organizationId, otherOrganizationId]);
    bob = await makeUser('bob@example.com', OrganizationRole.MEMBER);
    carol = await makeUser('carol@example.com', OrganizationRole.ADMIN);
    dave = await makeUser('dave@example.com', OrganizationRole.MEMBER);
    buildTeam = ((await ds.getRepository(Team).save(ds.getRepository(Team).create({ name: 'Build', organizationId } as any))) as any).id;
    for (const userId of [alice, dave]) {
      await ds.getRepository(UserTeam).save(ds.getRepository(UserTeam).create({ userId, teamId: buildTeam, role: TeamRole.MEMBER, isActive: true }));
    }

    policy = new AccessPolicyService(ds.getRepository(UserOrganization), ds.getRepository(UserTeam));
    runners = new RunnerService(
      ds.getRepository(Runner),
      ds.getRepository(RunnerSession),
      ds.getRepository(Workspace),
      new RunnerCapabilityPublisher(ds.getRepository(Tool)),
      policy,
      new ExecutionAccessService(policy),
    );
    workspaces = new WorkspaceService(ds.getRepository(Workspace), ds.getRepository(Runner), policy, runners);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  beforeEach(async () => {
    await ds.query('TRUNCATE TABLE workspaces, runner_sessions, runners CASCADE');
    await ds.query(`DELETE FROM tools WHERE "runnerConfig" IS NOT NULL`);
    await ds.getRepository(UserOrganization).update({ userId: bob, organizationId }, { isActive: true });
  });

  it('picks the online runner whose stored labels include every requirement', async () => {
    await machine(bob, 'bob-mac', { os: 'mac' });
    const gpuMac = await machine(carol, 'carol-gpu-mac', { os: 'mac', gpu: 'yes' });
    await machine(dave, 'dave-linux-gpu', { os: 'linux', gpu: 'yes' });

    await expect(runners.resolveByLabels({ os: 'mac', gpu: 'yes' }, alice, organizationId))
      .resolves.toMatchObject({ id: gpuMac.id });
    await expect(runners.resolveByLabels({ OS: 'Mac', gpu: 'YES' }, alice, organizationId))
      .resolves.toMatchObject({ id: gpuMac.id });
  });

  it('says plainly when no online machine matches', async () => {
    await machine(bob, 'bob-mac', { os: 'mac' });
    await machine(carol, 'carol-gpu-offline', { gpu: 'yes' }, { state: RunnerState.OFFLINE });
    await machine(dave, 'dave-gpu-nosession', { gpu: 'yes' }, { session: false });
    const err = await runners.resolveByLabels({ gpu: 'yes' }, alice, organizationId).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err.message).toBe('No machine with gpu=yes is online');
  });

  it('keeps to the runners the caller may use: private is the owner\'s, team is the team\'s', async () => {
    await machine(bob, 'bob-private-gpu', { gpu: 'yes' }, { visibility: 'private' });
    const teamGpu = await machine(dave, 'build-gpu', { gpu: 'yes' }, { visibility: 'team' });

    // alice is on Build: the team machine, never bob's private one.
    await expect(runners.resolveByLabels({ gpu: 'yes' }, alice, organizationId)).resolves.toMatchObject({ id: teamGpu.id });
    // bob is on no team: only his own.
    await expect(runners.resolveByLabels({ gpu: 'yes' }, bob, organizationId)).resolves.toMatchObject({ name: 'bob-private-gpu' });
    // No known caller: org-wide runners only, and there are none.
    await expect(runners.resolveByLabels({ gpu: 'yes' }, null, organizationId)).rejects.toThrow('No machine with gpu=yes is online');
    // A gateway of another scope: none either.
    const orgGateway = gatewayPrincipal({ id: '00000000-0000-4000-8000-0000000000aa', organizationId, visibility: 'org' } as any);
    await expect(runners.resolveByLabels({ gpu: 'yes' }, orgGateway, organizationId)).rejects.toThrow('No machine with gpu=yes is online');
    // Build's gateway reaches Build's machine.
    const buildGateway = gatewayPrincipal({ id: '00000000-0000-4000-8000-0000000000ab', organizationId, visibility: 'team', teamId: buildTeam } as any);
    await expect(runners.resolveByLabels({ gpu: 'yes' }, buildGateway, organizationId)).resolves.toMatchObject({ id: teamGpu.id });
  });

  it('never reaches a runner of a deactivated member or of another organization', async () => {
    await machine(bob, 'bob-gpu', { gpu: 'yes' });
    await machine(alice, 'alice-elsewhere-gpu', { gpu: 'yes' }, { org: otherOrganizationId });
    await expect(runners.resolveByLabels({ gpu: 'yes' }, dave, organizationId)).resolves.toMatchObject({ name: 'bob-gpu' });
    await ds.getRepository(UserOrganization).update({ userId: bob, organizationId }, { isActive: false });
    await expect(runners.resolveByLabels({ gpu: 'yes' }, dave, organizationId)).rejects.toThrow('No machine with gpu=yes is online');
  });

  it('creates a workspace on the matching machine, and refuses a named runner without the label', async () => {
    const gpuBox = await machine(bob, 'bob-gpu', { gpu: 'yes' });
    const ws = await workspaces.create({ cwd: '/tmp/work', labels: 'gpu=yes' }, alice, organizationId);
    expect(ws.runnerId).toBe(gpuBox.id);
    expect(ws.ownerUserId).toBe(alice);
    const row = await ds.getRepository(Workspace).findOneByOrFail({ id: ws.id });
    expect(row.runnerId).toBe(gpuBox.id);

    await expect(workspaces.create({ cwd: '/tmp/work', labels: 'os=mac' }, alice, organizationId))
      .rejects.toThrow('No machine with os=mac is online');

    const aliceMac = await machine(alice, 'alice-mac', { os: 'mac' });
    await expect(workspaces.create({ cwd: '/tmp/work', runnerId: aliceMac.id, labels: 'gpu=yes' }, alice, organizationId))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(workspaces.create({ cwd: '/tmp/work', labels: 'gpu' }, alice, organizationId))
      .rejects.toBeInstanceOf(BadRequestException);
  });
});
