import { DataSource, ObjectLiteral, Repository } from 'typeorm';
import { versionsConfig } from 'typeorm-versions';

import { Organization } from '../../entities/organization.entity';
import { User } from '../../entities/user.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { Team } from '../../entities/team.entity';
import { UserTeam, TeamRole } from '../../entities/user-team.entity';
import { Tool, ToolStatus, ToolType } from '../../entities/tool.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import { Gateway, GatewayKind, GatewayStatus, GatewayType } from '../../entities/gateway.entity';
import { UsageMetric, MetricType, MetricStatus } from '../../entities/usage-metric.entity';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { ToolsStatsHelper } from '../../modules/tools/tools-stats.helper';
import { GatewaysStatsHelper } from '../../modules/gateways/gateways-stats.helper';

/**
 * The tools and gateways overview numbers count only what the caller may
 * see, by the same rule the lists apply: org-wide rows, the caller's own
 * teams' rows, the caller's own private rows (an org admin: every
 * non-private row). A team's or another member's private tool or gateway
 * moves none of the counts, totals or averages -- including the gateway
 * average response time, which reads only the visible gateways' metrics.
 *
 * Real Postgres, built by the migrations. Gated on RUN_DB_INTEGRATION=1 and
 * isolated in its own schema.
 */
const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'overview_stats_scope_test';

jest.setTimeout(120_000);

describeIfDb('overview stats are scoped to what the caller may see (real Postgres)', () => {
  let ds: DataSource;
  let organizationId: string;
  let tools: ToolsStatsHelper;
  let gateways: GatewaysStatsHelper;
  const users = {} as Record<'member' | 'outsider' | 'admin' | 'owner', string>;
  const ids = {} as Record<'orgTool' | 'teamTool' | 'privateTool' | 'orgGw' | 'teamGw' | 'privateGw', string>;

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

    organizationId = await insert(Organization, { name: 'Stats Org', slug: 'stats-org' });
    const team = await insert(Team, { name: 'T', organizationId });
    const roles: Record<keyof typeof users, OrganizationRole> = {
      member: OrganizationRole.MEMBER,
      outsider: OrganizationRole.MEMBER,
      admin: OrganizationRole.ADMIN,
      owner: OrganizationRole.MEMBER,
    };
    for (const key of Object.keys(roles) as Array<keyof typeof users>) {
      users[key] = await insert(User, { email: `${key}@stats.test`, passwordHash: 'x', firstName: key, lastName: 'T' });
      await insert(UserOrganization, { userId: users[key], organizationId, role: roles[key], isActive: true, inviteAccepted: true });
    }
    await insert(UserTeam, { userId: users.member, teamId: team, role: TeamRole.MEMBER, isActive: true });

    // One tool and one gateway per scope. Each scope's traffic is a
    // different order of magnitude, so any leak shows in the numbers.
    const scopes = {
      org: { visibility: 'org', teamId: null, owner: users.admin, time: 10, requests: 10 },
      team: { visibility: 'team', teamId: team, owner: users.member, time: 1_000, requests: 100 },
      private: { visibility: 'private', teamId: null, owner: users.owner, time: 100_000, requests: 1_000 },
    } as const;
    for (const [scope, s] of Object.entries(scopes)) {
      const tool = await insert(Tool, {
        name: `${scope}_tool`, type: ToolType.FUNCTION, status: ToolStatus.ACTIVE, parameters: {}, organizationId,
        visibility: s.visibility, teamId: s.teamId, createdBy: s.owner,
      });
      await insert(ToolExecution, {
        organizationId, userId: s.owner, toolId: tool, parameters: {}, success: true, executionTime: s.time,
      });
      const gateway = await insert(Gateway, {
        name: `${scope} gw`, type: GatewayType.MCP, kind: GatewayKind.TOOL, endpoint: `/${scope}`, organizationId,
        status: GatewayStatus.ACTIVE, configuration: {}, visibility: s.visibility, teamId: s.teamId,
        ownerUserId: s.visibility === 'private' ? s.owner : null,
        totalRequests: s.requests, successfulRequests: s.requests,
      });
      await insert(UsageMetric, {
        type: MetricType.RESPONSE_TIME, value: s.time, status: MetricStatus.SUCCESS,
        gatewayId: gateway, organizationId, timestamp: new Date(),
      });
      ids[`${scope}Tool` as keyof typeof ids] = tool;
      ids[`${scope}Gw` as keyof typeof ids] = gateway;
    }
    // A request that went through no gateway at all (a dashboard call).
    await insert(UsageMetric, {
      type: MetricType.RESPONSE_TIME, value: 5_000_000, status: MetricStatus.SUCCESS, organizationId, timestamp: new Date(),
    });

    const policy = new AccessPolicyService(repo(UserOrganization), repo(UserTeam));
    tools = new ToolsStatsHelper(repo(Tool), repo(ToolExecution), policy);
    gateways = new GatewaysStatsHelper(repo(Gateway), repo(Organization), repo(UsageMetric), null as any, policy);
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await ds.destroy();
    }
  });

  describe('tools', () => {
    const cases: Array<[string, () => string | null, string[], number]> = [
      ['a member outside the team', () => users.outsider, ['org_tool'], 10],
      ["the team's member", () => users.member, ['org_tool', 'team_tool'], 505],
      ['an org admin', () => users.admin, ['org_tool', 'team_tool'], 505],
      ['the private tool owner', () => users.owner, ['org_tool', 'private_tool'], 50_005],
      ['no known caller', () => null, ['org_tool'], 10],
    ];

    it.each(cases)('%s: counts, totals and top tools cover only the visible tools', async (_who, caller, names, avg) => {
      const stats = await tools.getOrganizationToolStats(organizationId, caller());
      expect(stats.totalTools).toBe(names.length);
      expect(stats.activeTools).toBe(names.length);
      expect(stats.totalExecutions).toBe(names.length);
      expect(stats.averageExecutionTime).toBe(avg);
      expect(stats.topUsedTools.map((t) => t.tool.name).sort()).toEqual(names);
    });
  });

  describe('gateways', () => {
    const cases: Array<[string, () => string, string[], number, number]> = [
      ['a member outside the team', () => users.outsider, ['org gw'], 10, 10],
      ["the team's member", () => users.member, ['org gw', 'team gw'], 110, 505],
      ['an org admin', () => users.admin, ['org gw', 'team gw'], 110, 505],
      ['the private gateway owner', () => users.owner, ['org gw', 'private gw'], 1_010, 50_005],
    ];

    it.each(cases)('%s: counts, totals, average and top gateways cover only the visible gateways', async (_who, caller, names, requests, avg) => {
      const stats = await gateways.getOrganizationGatewayStats(organizationId, caller());
      expect(stats.totalGateways).toBe(names.length);
      expect(stats.activeGateways).toBe(names.length);
      expect(stats.totalRequests).toBe(requests);
      expect(stats.averageResponseTime).toBe(avg);
      expect(stats.topGateways.map((t) => t.gateway.name).sort()).toEqual(names);
    });
  });
});
