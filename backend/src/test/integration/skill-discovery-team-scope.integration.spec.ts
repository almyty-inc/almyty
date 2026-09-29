import { ForbiddenException } from '@nestjs/common';
import { DataSource, ObjectLiteral, Repository } from 'typeorm';
import { versionsConfig } from 'typeorm-versions';

import { Organization } from '../../entities/organization.entity';
import { User } from '../../entities/user.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { Team } from '../../entities/team.entity';
import { UserTeam, TeamRole } from '../../entities/user-team.entity';
import { Gateway, GatewayKind, GatewayStatus, GatewayType } from '../../entities/gateway.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { Tool, ToolStatus, ToolType } from '../../entities/tool.entity';
import { UsageMetric } from '../../entities/usage-metric.entity';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { GatewaysStatsHelper } from '../../modules/gateways/gateways-stats.helper';

/**
 * Skill discovery across gateways (`GET /gateways/skills/search` and
 * `/gateways/all-skills`) shows a caller the gateways their gateway list
 * shows them -- a team gateway only to its team and org owners/admins, a
 * private one only to its owner -- and, on each, only what that gateway
 * serves (gateway-servable): the tool active and in the gateway's scope.
 *
 * Real Postgres, built by the migrations, so the SQL twin of the scope
 * rule runs against the real columns. Gated on RUN_DB_INTEGRATION=1 and
 * isolated in its own schema.
 */
const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'skill_discovery_team_scope_test';

jest.setTimeout(120_000);

type Who = 'admin' | 'teamMember' | 'outsider' | 'formerMember' | 'owner';

describeIfDb('skill discovery across gateways stays inside team scope and what each gateway serves (real Postgres)', () => {
  let ds: DataSource;
  let organizationId: string;
  let teamId: string;
  let otherTeamId: string;
  const users = {} as Record<Who, string>;
  const gw = {} as Record<'org' | 'team' | 'otherTeam' | 'ownerPrivate', string>;
  let stats: GatewaysStatsHelper;

  const connection = () => ({
    type: 'postgres' as const,
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || '',
    database: process.env.DATABASE_NAME || 'almyty_test',
  });
  const repo = <T extends ObjectLiteral>(entity: new () => T): Repository<T> => ds.getRepository(entity);
  const insert = async (entity: new () => any, data: Record<string, unknown>): Promise<string> =>
    ((await repo(entity).save(repo(entity).create(data as any))) as any).id;

  beforeAll(async () => {
    const bootstrap = new DataSource(connection());
    await bootstrap.initialize();
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await bootstrap.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public`);
    await bootstrap.destroy();

    ds = new DataSource(versionsConfig({
      ...connection(),
      schema: SCHEMA,
      entities: [__dirname + '/../../entities/*.entity{.ts,.js}'],
      extra: { options: `-c search_path=${SCHEMA},public` },
      migrations: [__dirname + '/../../migrations/*{.ts,.js}'],
      migrationsRun: true,
      dropSchema: true,
    }) as any);
    await ds.initialize();
    await ds.query(`SET search_path TO ${SCHEMA}, public`);

    organizationId = await insert(Organization, { name: 'Skill Scope Org', slug: 'skill-scope-org' });
    const roles: Array<[Who, OrganizationRole]> = [
      ['admin', OrganizationRole.ADMIN],
      ['teamMember', OrganizationRole.MEMBER],
      ['outsider', OrganizationRole.MEMBER],
      ['formerMember', OrganizationRole.MEMBER],
      ['owner', OrganizationRole.MEMBER],
    ];
    for (const [who, role] of roles) {
      users[who] = await insert(User, { email: `${who}@skill-scope.test`, passwordHash: 'x', firstName: who, lastName: 'T' });
      await insert(UserOrganization, { userId: users[who], organizationId, role, isActive: true, inviteAccepted: true });
    }
    teamId = await insert(Team, { name: 'Payments', organizationId });
    otherTeamId = await insert(Team, { name: 'Support', organizationId });
    await insert(UserTeam, { userId: users.teamMember, teamId, role: TeamRole.MEMBER, isActive: true });
    await insert(UserTeam, { userId: users.formerMember, teamId, role: TeamRole.MEMBER, isActive: false });
    await insert(UserTeam, { userId: users.outsider, teamId: otherTeamId, role: TeamRole.MEMBER, isActive: true });

    const gateway = (tag: string, scope: Record<string, unknown>) =>
      insert(Gateway, {
        name: `${tag} gw`, type: GatewayType.MCP, kind: GatewayKind.TOOL, endpoint: `/${tag}-gw`, organizationId,
        status: GatewayStatus.ACTIVE, configuration: {}, ownerUserId: users.owner, teamId: null, ...scope,
      });
    gw.org = await gateway('org', { visibility: 'org' });
    gw.team = await gateway('team', { visibility: 'team', teamId });
    gw.otherTeam = await gateway('other-team', { visibility: 'team', teamId: otherTeamId });
    gw.ownerPrivate = await gateway('owner-private', { visibility: 'private' });

    const tool = (name: string, extra: Record<string, unknown> = {}) =>
      insert(Tool, {
        name, description: `skill ${name}`, type: ToolType.FUNCTION, parameters: {}, organizationId,
        visibility: 'org', teamId: null, createdBy: users.owner, status: ToolStatus.ACTIVE, ...extra,
      });
    const attach = (gatewayId: string, toolId: string, isActive = true) =>
      insert(GatewayTool, { gatewayId, toolId, isActive });

    await attach(gw.org, await tool('skill_org'));
    await attach(gw.org, await tool('skill_draft', { status: ToolStatus.DRAFT }));
    await attach(gw.org, await tool('skill_retired', { status: ToolStatus.DEPRECATED }));
    await attach(gw.org, await tool('skill_detached'), false);
    await attach(gw.org, await tool('skill_team_on_org_gw', { visibility: 'team', teamId }));
    await attach(gw.org, await tool('skill_private_on_org_gw', { visibility: 'private' }));
    await attach(gw.team, await tool('skill_team', { visibility: 'team', teamId }));
    await attach(gw.otherTeam, await tool('skill_other_team', { visibility: 'team', teamId: otherTeamId }));
    await attach(gw.ownerPrivate, await tool('skill_owner_private', { visibility: 'private' }));

    const policy = new AccessPolicyService(repo(UserOrganization), repo(UserTeam));
    stats = new GatewaysStatsHelper(repo(Gateway), repo(Organization), repo(UsageMetric), undefined as any, policy);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  const found = async (who: Who) =>
    (await stats.searchSkillsAcrossGateways(organizationId, 'skill', users[who])).map((r) => r.toolName).sort();
  const gateways = async (who: Who) =>
    (await stats.getAllUserGateways(organizationId, users[who])).map((g) => g.id).sort();

  it('a member outside the team does not get the team gateway or its skills', async () => {
    expect(await gateways('outsider')).toEqual([gw.org, gw.otherTeam].sort());
    expect(await found('outsider')).toEqual(['skill_org', 'skill_other_team']);
  });

  it('a departed team member is outside it', async () => {
    expect(await gateways('formerMember')).toEqual([gw.org]);
    expect(await found('formerMember')).toEqual(['skill_org']);
  });

  it("the team's member gets its gateway and its skills", async () => {
    expect(await gateways('teamMember')).toEqual([gw.org, gw.team].sort());
    expect(await found('teamMember')).toEqual(['skill_org', 'skill_team']);
  });

  it('an org admin gets every team gateway, but not a private one', async () => {
    expect(await gateways('admin')).toEqual([gw.org, gw.team, gw.otherTeam].sort());
    expect(await found('admin')).toEqual(['skill_org', 'skill_other_team', 'skill_team']);
  });

  it('the owner gets their private gateway and what it serves', async () => {
    expect(await gateways('owner')).toEqual([gw.org, gw.ownerPrivate].sort());
    expect(await found('owner')).toEqual(['skill_org', 'skill_owner_private']);
  });

  it('a draft, retired, detached or out-of-scope tool is nobody\'s result', async () => {
    const hidden = ['skill_draft', 'skill_retired', 'skill_detached', 'skill_team_on_org_gw', 'skill_private_on_org_gw'];
    for (const who of ['admin', 'teamMember', 'outsider', 'formerMember', 'owner'] as const) {
      const names = await found(who);
      for (const name of hidden) expect(names).not.toContain(name);
    }
  });

  it('a non-member of the organization is refused', async () => {
    const stranger = await insert(User, { email: 'stranger@skill-scope.test', passwordHash: 'x', firstName: 's', lastName: 'T' });
    await expect(stats.getAllUserGateways(organizationId, stranger)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(stats.searchSkillsAcrossGateways(organizationId, 'skill', stranger)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
