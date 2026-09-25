import { DataSource, ObjectLiteral, Repository } from 'typeorm';
import { versionsConfig } from 'typeorm-versions';

import { Organization } from '../../entities/organization.entity';
import { User } from '../../entities/user.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { Team } from '../../entities/team.entity';
import { UserTeam, TeamRole } from '../../entities/user-team.entity';
import { Gateway, GatewayKind, GatewayStatus, GatewayType } from '../../entities/gateway.entity';
import { LlmProvider, LlmProviderStatus } from '../../entities/llm-provider.entity';
import { LlmProviderType } from '../../entities/llm-provider-type';
import { Tool, ToolType } from '../../entities/tool.entity';
import { Agent, AgentStatus } from '../../entities/agent.entity';
import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { Api } from '../../entities/api.entity';
import { AgentApp } from '../../entities/agent-app.entity';
import { AppDistribution } from '../../entities/agent-app-distribution.entity';
import { Runner } from '../../entities/runner.entity';
import { AuditLog } from '../../entities/audit-log.entity';
import { Message } from '../../entities/message.entity';
import { RequestLog } from '../../entities/request-log.entity';
import { UsageMetric, MetricStatus, MetricType } from '../../entities/usage-metric.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import { Conversation } from '../../entities/conversation.entity';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { AnalyticsService } from '../../modules/monitoring/analytics.service';
import { AnalyticsExportHelper } from '../../modules/monitoring/analytics-export.helper';
import { AnalyticsSummariesHelper } from '../../modules/monitoring/analytics-summaries.helper';
import { OnboardingService } from '../../modules/onboarding/onboarding.service';

/**
 * Analytics and the onboarding guide count what the caller may see, and
 * a team resource is seen only by its team and by org owners/admins
 * (AccessPolicyService). Traffic, executions, sessions and runs tied to a
 * team gateway, tool, provider or agent are left out for a member outside
 * that team -- a request log line naming a team gateway, or a tick for a
 * first call made through one, tells them the resource exists and how it
 * is used. A member whose team membership was deactivated is outside it.
 *
 * Real Postgres, built by the migrations. Gated on RUN_DB_INTEGRATION=1
 * and isolated in its own schema.
 */
const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'analytics_team_scope_test';

jest.setTimeout(120_000);

type Who = 'admin' | 'teamMember' | 'outsider' | 'formerMember';

describeIfDb('analytics and onboarding stay inside the viewer\'s team scope (real Postgres)', () => {
  let ds: DataSource;
  let organizationId: string;
  let teamId: string;
  const users = {} as Record<Who, string>;
  const team = {} as Record<'gateway' | 'tool' | 'provider' | 'agent' | 'run', string>;
  const org = {} as Record<'gateway' | 'tool' | 'provider' | 'agent' | 'run', string>;
  const logs = {} as Record<'teamGateway' | 'teamTool' | 'orgGateway', string>;
  let analytics: AnalyticsService;
  let onboarding: OnboardingService;

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

    organizationId = await insert(Organization, { name: 'Team Scope Org', slug: 'team-scope-org' });
    const roles: Array<[Who, OrganizationRole]> = [
      ['admin', OrganizationRole.ADMIN],
      ['teamMember', OrganizationRole.MEMBER],
      ['outsider', OrganizationRole.MEMBER],
      ['formerMember', OrganizationRole.MEMBER],
    ];
    for (const [who, role] of roles) {
      users[who] = await insert(User, { email: `${who}@team-scope.test`, passwordHash: 'x', firstName: who, lastName: 'T' });
      await insert(UserOrganization, { userId: users[who], organizationId, role, isActive: true, inviteAccepted: true });
    }
    teamId = await insert(Team, { name: 'Payments', organizationId });
    await insert(UserTeam, { userId: users.teamMember, teamId, role: TeamRole.MEMBER, isActive: true });
    await insert(UserTeam, { userId: users.formerMember, teamId, role: TeamRole.MEMBER, isActive: false });

    for (const [bag, scope] of [[team, { visibility: 'team', teamId }], [org, { visibility: 'org', teamId: null }]] as const) {
      const tag = scope.visibility;
      bag.gateway = await insert(Gateway, {
        name: `${tag} gw`, type: GatewayType.MCP, kind: GatewayKind.TOOL, endpoint: `/${tag}-gw`, organizationId,
        status: GatewayStatus.ACTIVE, configuration: {}, ...scope, ownerUserId: users.teamMember,
      });
      bag.tool = await insert(Tool, {
        name: `${tag}_tool`, type: ToolType.FUNCTION, parameters: {}, organizationId, ...scope, createdBy: users.teamMember,
      });
      bag.provider = await insert(LlmProvider, {
        name: `${tag} provider`, type: LlmProviderType.OPENAI, organizationId, configuration: { model: 'x' },
        status: LlmProviderStatus.ACTIVE, ...scope, ownerUserId: users.teamMember,
      });
      bag.agent = await insert(Agent, {
        name: `${tag} agent`, status: AgentStatus.ACTIVE, organizationId, pipeline: { nodes: [], edges: [] },
        ...scope, createdBy: users.teamMember,
      });
      bag.run = await insert(AgentRun, { agentId: bag.agent, organizationId, userId: users.teamMember, status: AgentRunStatus.COMPLETED });
      await insert(UsageMetric, {
        type: MetricType.REQUEST_COUNT, value: 1, status: MetricStatus.SUCCESS, gatewayId: bag.gateway, organizationId, timestamp: new Date(),
      });
      await insert(ToolExecution, { organizationId, userId: users.teamMember, toolId: bag.tool, parameters: {}, success: true, executionTime: 3 });
      await insert(Conversation, { providerId: bag.provider, organizationId, userId: users.teamMember, context: {} });
    }

    const log = (data: Record<string, unknown>) => insert(RequestLog, {
      method: 'POST', statusCode: 200, responseTime: 5, organizationId, userAgent: 'claude-code/1.0', timestamp: new Date(), ...data,
    });
    logs.teamGateway = await log({ path: '/team-gw/mcp', gatewayId: team.gateway });
    logs.teamTool = await log({ path: `/tools/${team.tool}/execute`, toolId: team.tool });
    logs.orgGateway = await log({ path: '/org-gw/mcp', gatewayId: org.gateway, toolId: org.tool });

    const policy = new AccessPolicyService(repo(UserOrganization), repo(UserTeam));
    analytics = new AnalyticsService(
      repo(RequestLog), repo(UsageMetric), repo(ToolExecution), repo(Conversation), repo(Message), repo(AuditLog), repo(AgentRun),
      new AnalyticsExportHelper(repo(RequestLog), repo(ToolExecution), repo(Conversation)),
      new AnalyticsSummariesHelper(repo(AuditLog), repo(AgentRun)),
    );
    onboarding = new OnboardingService(
      repo(LlmProvider), repo(Api), repo(Gateway), repo(Agent), repo(RequestLog), repo(User), repo(Tool),
      repo(AgentApp), repo(AppDistribution), repo(Runner), policy,
    );
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  const inScope: Who[] = ['admin', 'teamMember'];
  const outOfScope: Who[] = ['outsider', 'formerMember'];

  it.each(inScope)('%s sees the team\'s traffic in the request log', async (who) => {
    const ids = (await analytics.getRequestLogs({ organizationId, page: 1, limit: 50, callerId: users[who] })).data.map((l) => l.id);
    expect(ids.sort()).toEqual([logs.teamGateway, logs.teamTool, logs.orgGateway].sort());
  });

  it.each(outOfScope)('%s does not see a team gateway\'s or team tool\'s traffic in the request log', async (who) => {
    const page = await analytics.getRequestLogs({ organizationId, page: 1, limit: 50, callerId: users[who] });
    expect(page.data.map((l) => l.id)).toEqual([logs.orgGateway]);
    expect(page.total).toBe(1);
    // Asking for the team gateway or tool by id is the same empty answer as an unknown id.
    expect((await analytics.getRequestLogs({ organizationId, page: 1, limit: 50, gatewayId: team.gateway, callerId: users[who] })).total).toBe(0);
    expect((await analytics.getRequestLogs({ organizationId, page: 1, limit: 50, toolId: team.tool, callerId: users[who] })).total).toBe(0);
  });

  it.each(outOfScope)('%s: overview tiles and the timeline count only org traffic', async (who) => {
    const overview = await analytics.getOverview(organizationId, users[who]);
    expect(overview.last24h.requests).toBe(1);
    expect(overview.last24h.toolExecutions).toBe(1);
    expect(overview.last24h.llmSessions).toBe(1);
    const timeline = await analytics.getTimeline(organizationId, '24h', 'hour', users[who]);
    expect(timeline.reduce((sum, b) => sum + b.requests, 0)).toBe(1);
  });

  it.each(inScope)('%s: overview tiles and the timeline count the team\'s traffic too', async (who) => {
    const overview = await analytics.getOverview(organizationId, users[who]);
    expect(overview.last24h.requests).toBe(3);
    expect(overview.last24h.toolExecutions).toBe(2);
    expect(overview.last24h.llmSessions).toBe(2);
    const timeline = await analytics.getTimeline(organizationId, '24h', 'hour', users[who]);
    expect(timeline.reduce((sum, b) => sum + b.requests, 0)).toBe(3);
  });

  it.each(outOfScope)('%s: per-gateway, per-tool, per-provider and per-agent breakdowns leave the team out', async (who) => {
    expect((await analytics.getGatewayUsage(organizationId, '7d', users[who])).map((r) => r.gatewayId)).toEqual([org.gateway]);
    expect((await analytics.getToolUsage(organizationId, '7d', users[who])).map((r) => r.toolId)).toEqual([org.tool]);
    expect((await analytics.getLlmUsage(organizationId, '7d', users[who])).map((r) => r.providerId)).toEqual([org.provider]);
    const runs = await analytics.getAgentRunsSummary(organizationId, users[who]);
    expect(runs.totals.total).toBe(1);
    expect(runs.byAgent.map((r) => r.agentId)).toEqual([org.agent]);
  });

  it.each(inScope)('%s: per-gateway, per-tool, per-provider and per-agent breakdowns include the team', async (who) => {
    expect((await analytics.getGatewayUsage(organizationId, '7d', users[who])).map((r) => r.gatewayId).sort()).toEqual([org.gateway, team.gateway].sort());
    expect((await analytics.getToolUsage(organizationId, '7d', users[who])).map((r) => r.toolId).sort()).toEqual([org.tool, team.tool].sort());
    expect((await analytics.getLlmUsage(organizationId, '7d', users[who])).map((r) => r.providerId).sort()).toEqual([org.provider, team.provider].sort());
    expect((await analytics.getAgentRunsSummary(organizationId, users[who])).totals.total).toBe(2);
  });

  describe('onboarding', () => {
    beforeAll(async () => {
      // Only the team's traffic: with the org gateway's call in, the step is ticked for everyone.
      await repo(RequestLog).delete({ id: logs.orgGateway });
    });

    it.each(outOfScope)('%s: a first call made only through a team gateway or tool ticks nothing', async (who) => {
      const state = await onboarding.getState(organizationId, users[who]);
      expect(state.steps.first_call).toBe(false);
      expect(state.steps.external_client).toBe(false);
      expect(state.activatedRealAt).toBeNull();
    });

    it.each(inScope)('%s: the team\'s first call ticks the steps', async (who) => {
      const state = await onboarding.getState(organizationId, users[who]);
      expect(state.steps.first_call).toBe(true);
      expect(state.steps.external_client).toBe(true);
    });
  });
});
