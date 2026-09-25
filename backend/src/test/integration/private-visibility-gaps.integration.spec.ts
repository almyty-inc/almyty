import { BadRequestException, ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { versionsConfig } from 'typeorm-versions';

import { Agent } from '../../entities/agent.entity';
import { AgentApp } from '../../entities/agent-app.entity';
import { AppDistribution } from '../../entities/agent-app-distribution.entity';
import { AgentExecution } from '../../entities/agent-execution.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { Api, ApiType } from '../../entities/api.entity';
import { ApiSchema } from '../../entities/api-schema.entity';
import { AuditLog } from '../../entities/audit-log.entity';
import { Conversation } from '../../entities/conversation.entity';
import { Gateway, GatewayKind, GatewayStatus, GatewayType } from '../../entities/gateway.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { LlmProvider, LlmProviderStatus } from '../../entities/llm-provider.entity';
import { LlmProviderType } from '../../entities/llm-provider-type';
import { Message } from '../../entities/message.entity';
import { Operation } from '../../entities/operation.entity';
import { Organization } from '../../entities/organization.entity';
import { RequestLog } from '../../entities/request-log.entity';
import { Resource } from '../../entities/resource.entity';
import { Runner } from '../../entities/runner.entity';
import { Tool, ToolType } from '../../entities/tool.entity';
import { ToolCategory } from '../../entities/tool-category.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import { ToolVersion } from '../../entities/tool-version.entity';
import { UsageMetric } from '../../entities/usage-metric.entity';
import { User } from '../../entities/user.entity';
import { OrganizationRole, UserOrganization } from '../../entities/user-organization.entity';
import { UserTeam } from '../../entities/user-team.entity';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { AgentReadinessService } from '../../modules/agents/agent-readiness.service';
import { AgentValidationHelper } from '../../modules/agents/agent-validation.helper';
import { AgentsService } from '../../modules/agents/agents.service';
import { ApisService } from '../../modules/apis/apis.service';
import { AnalyticsService } from '../../modules/monitoring/analytics.service';
import { AnalyticsSummariesHelper } from '../../modules/monitoring/analytics-summaries.helper';
import { OnboardingService } from '../../modules/onboarding/onboarding.service';
import { ToolsService } from '../../modules/tools/tools.service';
import { ToolsStatsHelper } from '../../modules/tools/tools-stats.helper';

/**
 * The Private tier's remaining gaps after #741, against a real Postgres
 * with the real migrations:
 *
 *  - counts a user sees (the platform guide, analytics overview and
 *    timeline) are the caller's visible set, not the org's;
 *  - an agent cannot be saved naming another member's private provider
 *    (collaboration model participants included), and readiness treats
 *    one as missing;
 *  - a shared tool, agent or API cannot be made private while shared
 *    agents or gateways use it -- the change is refused, naming them;
 *  - a name clash answers the same 409 whether the other row is private
 *    or not, and never says whose it is.
 *
 * Cast: `owner` owns the private rows (an org admin, so creating tools is
 * allowed); `member` is a plain member and `admin` another admin of the
 * same org. The admin bypass never reaches private rows.
 *
 * Gated on RUN_DB_INTEGRATION=1; own schema so parallel workers do not
 * race each other's DDL.
 */
const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'private_visibility_gaps_test';

jest.setTimeout(120_000);

describeIfDb('private visibility gaps (real Postgres)', () => {
  let ds: DataSource;
  let policy: AccessPolicyService;
  let agents: AgentsService;
  let tools: ToolsService;
  let apis: ApisService;
  let onboarding: OnboardingService;
  let analytics: AnalyticsService;
  let readiness: AgentReadinessService;

  let orgId: string;
  const users: Record<'owner' | 'member' | 'admin', string> = {} as any;
  const others = ['member', 'admin'] as const;

  let privateProvider: LlmProvider;
  let privateApi: Api;
  let privateTool: Tool;
  let privateGateway: Gateway;
  let privateAgent: Agent;

  const connection = () => ({
    type: 'postgres' as const,
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || '',
    database: process.env.DATABASE_NAME || 'almyty_test',
  });

  const repo = <T extends object>(entity: new () => T) => ds.getRepository(entity);
  const insert = async <T extends object>(entity: new () => T, data: Record<string, unknown>): Promise<T> =>
    repo(entity).save(repo(entity).create(data as any) as any) as Promise<T>;

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

    const org = await insert(Organization, { name: 'Gaps Org', slug: 'gaps-org' });
    orgId = (org as any).id;
    const roles: Record<keyof typeof users, OrganizationRole> = {
      owner: OrganizationRole.ADMIN,
      member: OrganizationRole.MEMBER,
      admin: OrganizationRole.ADMIN,
    };
    for (const key of Object.keys(roles) as Array<keyof typeof users>) {
      const user: any = await insert(User, { email: `${key}@gaps.test`, passwordHash: 'x', firstName: key, lastName: 'T' });
      users[key] = user.id;
      await insert(UserOrganization, { userId: user.id, organizationId: orgId, role: roles[key], isActive: true });
    }

    policy = new AccessPolicyService(repo(UserOrganization), repo(UserTeam));
    const audit = { log: jest.fn(), logCreate: jest.fn(), logUpdate: jest.fn(), logDelete: jest.fn(), computeChanges: jest.fn() } as any;
    tools = new ToolsService(
      repo(Tool), repo(ToolVersion), repo(ToolCategory), repo(ToolExecution), repo(Api), repo(Operation),
      repo(ApiSchema), repo(User), repo(Organization), audit, null as any,
      new ToolsStatsHelper(repo(Tool), repo(ToolExecution), policy), policy,
    );
    agents = new AgentsService(
      repo(Agent), repo(AgentExecution), repo(Organization), repo(User), { log: jest.fn() } as any,
      new AgentValidationHelper(), policy, { assertReady: jest.fn(), inspect: jest.fn() } as any,
    );
    apis = new ApisService(
      repo(Api), repo(ApiSchema), repo(Operation), repo(Resource), repo(Organization), null as any, tools,
      audit, ds, null as any, null as any, policy, null as any,
    );
    onboarding = new OnboardingService(
      repo(LlmProvider), repo(Api), repo(Gateway), repo(Agent), repo(RequestLog), repo(User), repo(Tool),
      repo(AgentApp), repo(AppDistribution), repo(Runner), policy,
    );
    analytics = new AnalyticsService(
      repo(RequestLog), repo(UsageMetric), repo(ToolExecution), repo(Conversation), repo(Message), repo(AuditLog),
      repo(AgentRun), null as any, new AnalyticsSummariesHelper(repo(AuditLog), repo(AgentRun)),
    );
    readiness = new AgentReadinessService(
      new AgentValidationHelper(), {} as any, {} as any, {} as any, repo(LlmProvider), repo(Organization),
    );

    // The owner's private footprint: one of everything the guide counts.
    privateProvider = await insert(LlmProvider, {
      name: 'Owner private OpenAI', type: LlmProviderType.OPENAI, organizationId: orgId,
      configuration: { model: 'gpt-x' }, status: LlmProviderStatus.ACTIVE, isHealthy: true,
      visibility: 'private', teamId: null, ownerUserId: users.owner,
    });
    privateApi = await apis.create(
      { name: 'Owner private API', type: ApiType.OPENAPI, baseUrl: 'https://private.example.com', organizationId: orgId, visibility: 'private' } as any,
      users.owner,
    );
    privateTool = await tools.createTool(
      { name: 'owner_private_tool', description: 'secret', type: ToolType.FUNCTION, parameters: {}, visibility: 'private' } as any,
      orgId,
      users.owner,
    );
    privateGateway = await insert(Gateway, {
      name: 'Owner private MCP', type: GatewayType.MCP, kind: GatewayKind.TOOL, endpoint: '/owner-private',
      organizationId: orgId, status: GatewayStatus.ACTIVE, configuration: {}, isSystem: false,
      visibility: 'private', teamId: null, ownerUserId: users.owner,
    });
    await insert(GatewayTool, { gatewayId: privateGateway.id, toolId: privateTool.id, isActive: true });
    privateAgent = await agents.createAgent(
      { name: 'Owner Private Agent', visibility: 'private', toolIds: [privateTool.id] },
      orgId,
      users.owner,
    );
    await repo(Agent).update({ id: privateAgent.id }, { successfulExecutions: 3 } as any);

    // Traffic through the private gateway and tool, and a session on the
    // private provider and agent, from an external client.
    const now = new Date();
    await insert(RequestLog, {
      method: 'POST', path: '/gaps-org/owner-private', statusCode: 200, responseTime: 7,
      gatewayId: privateGateway.id, organizationId: orgId, timestamp: now, userAgent: 'claude-code',
    });
    await insert(RequestLog, {
      method: 'POST', path: `/tools/${privateTool.id}/execute`, statusCode: 500, responseTime: 9,
      toolId: privateTool.id, organizationId: orgId, timestamp: now,
    });
    await insert(ToolExecution, {
      toolId: privateTool.id, organizationId: orgId, userId: users.owner, parameters: {}, success: true, executionTime: 10,
    });
    await insert(Conversation, {
      providerId: privateProvider.id, organizationId: orgId, userId: users.owner, context: {}, totalCost: 2,
    });
    await insert(Conversation, {
      agentId: privateAgent.id, organizationId: orgId, userId: users.owner, context: {}, totalCost: 3,
    });
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  // ── Gap 1: counts are the caller's visible set ──────────────────────

  describe('the platform guide', () => {
    it('ticks every step from the owner\'s private resources for the owner', async () => {
      const state = await onboarding.getState(orgId, users.owner);
      expect(state.steps).toMatchObject({
        provider: true, api: true, tools: true, gateway: true,
        first_call: true, external_client: true, agent: true, agent_run: true,
      });
      expect(state.links.gateway?.id).toBe(privateGateway.id);
      expect(state.links.agent?.id).toBe(privateAgent.id);
      expect(state.activatedRealAt).not.toBeNull();
    });

    it('ticks none of them, and links to none, for anyone else -- admins included', async () => {
      for (const who of others) {
        const state = await onboarding.getState(orgId, users[who]);
        expect(state.steps).toMatchObject({
          provider: false, api: false, tools: false, gateway: false,
          first_call: false, external_client: false, agent: false, agent_run: false,
        });
        expect(state.links.gateway).toBeNull();
        expect(state.links.agent).toBeNull();
        expect(state.activatedRealAt).toBeNull();
      }
    });
  });

  describe('analytics overview and timeline', () => {
    it('count the owner\'s private traffic, executions and sessions for the owner only', async () => {
      const mine = await analytics.getOverview(orgId, users.owner);
      expect(mine.last24h).toMatchObject({ requests: 2, errors: 1, toolExecutions: 1, llmSessions: 2 });
      expect(mine.last7d.llmCostCents).toBe(5);
      const myTimeline = await analytics.getTimeline(orgId, '24h', 'hour', users.owner);
      expect(myTimeline.reduce((n, b) => n + b.requests, 0)).toBe(2);

      for (const who of others) {
        const theirs = await analytics.getOverview(orgId, users[who]);
        expect(theirs.last24h).toMatchObject({ requests: 0, errors: 0, toolExecutions: 0, llmSessions: 0, avgResponseTime: 0 });
        expect(theirs.last7d).toMatchObject({ requests: 0, toolExecutions: 0, llmCostCents: 0 });
        const timeline = await analytics.getTimeline(orgId, '24h', 'hour', users[who]);
        expect(timeline.reduce((n, b) => n + b.requests, 0)).toBe(0);
      }
    });

    it('count none of them with no caller (fails closed)', async () => {
      const nobody = await analytics.getOverview(orgId, null);
      expect(nobody.last24h.requests).toBe(0);
      expect(nobody.last24h.llmSessions).toBe(0);
    });
  });

  // ── Gap 3: providers named at save time ─────────────────────────────

  describe('saving an agent that names a provider', () => {
    const modelParticipant = (providerId: string) => ({
      strategy: 'parallel' as const,
      participants: [
        { kind: 'model' as const, providerId, model: 'gpt-x' },
        { kind: 'model' as const, providerId, model: 'gpt-x' },
      ],
    });

    it('refuses another member\'s private provider in a collaboration model participant, as if it did not exist', async () => {
      const missing = '00000000-0000-4000-8000-000000000000';
      const errorFor = async (providerId: string) => {
        try {
          await agents.createAgent(
            { name: `Collab ${providerId.slice(0, 6)}`, mode: 'autonomous', collaboration: modelParticipant(providerId) as any },
            orgId,
            users.member,
          );
        } catch (e) {
          return e as Error;
        }
        throw new Error('expected a refusal');
      };
      const privateErr = await errorFor(privateProvider.id);
      const missingErr = await errorFor(missing);
      expect(privateErr).toBeInstanceOf(BadRequestException);
      expect(missingErr).toBeInstanceOf(BadRequestException);
      // Same words either way, bar the id the caller sent.
      expect(privateErr.message.replace(privateProvider.id, 'ID')).toBe(missingErr.message.replace(missing, 'ID'));
      expect(privateErr.message).not.toContain('Owner private OpenAI');
    });

    it('refuses it in modelConfig and in a pipeline node too, and on update', async () => {
      await expect(agents.createAgent(
        { name: 'Model config', modelConfig: { providerId: privateProvider.id, model: 'gpt-x' } },
        orgId,
        users.admin,
      )).rejects.toBeInstanceOf(BadRequestException);

      const agent = await agents.createAgent({ name: 'Plain member agent' }, orgId, users.member);
      await expect(agents.updateAgent(
        agent.id,
        { collaboration: modelParticipant(privateProvider.id) as any, mode: 'autonomous' },
        orgId,
        users.member,
      )).rejects.toBeInstanceOf(BadRequestException);
    });

    it('lets the owner use their own private provider', async () => {
      const agent = await agents.createAgent(
        { name: 'Owner collab', visibility: 'private', mode: 'autonomous', collaboration: modelParticipant(privateProvider.id) as any },
        orgId,
        users.owner,
      );
      expect(agent.id).toBeDefined();
    });

    it('readiness reads another member\'s private provider as missing', async () => {
      const pipeline = {
        nodes: [
          { id: 'in', type: 'input', position: { x: 0, y: 0 }, data: {} },
          { id: 'llm', type: 'llm_call', position: { x: 0, y: 0 }, data: { providerId: privateProvider.id, model: 'gpt-x', prompt: 'hi' } },
          { id: 'out', type: 'output', position: { x: 0, y: 0 }, data: {} },
        ],
        edges: [
          { id: 'e1', source: 'in', target: 'llm' },
          { id: 'e2', source: 'llm', target: 'out' },
        ],
      };
      const agent = Object.assign(new Agent(), { id: 'a-1', organizationId: orgId, mode: 'workflow', pipeline, settings: {} });
      await expect(readiness.inspect(agent as Agent, users.owner)).resolves.toEqual({ ready: true });
      for (const who of others) {
        const verdict = await readiness.inspect(agent as Agent, users[who]);
        expect(verdict.ready).toBe(false);
        expect(verdict.message).toMatch(/needs an available provider/);
      }
      expect((await readiness.inspect(agent as Agent, undefined)).ready).toBe(false);
    });
  });

  // ── Gap 4: going private with shared dependents ─────────────────────

  describe('making a shared tool, agent or API private', () => {
    it('is refused while a shared agent or gateway uses the tool, naming them', async () => {
      const tool = await tools.createTool(
        { name: 'shared_tool', description: 'x', type: ToolType.FUNCTION, parameters: {} } as any, orgId, users.owner,
      );
      const orgAgent = await agents.createAgent({ name: 'Org consumer', toolIds: [tool.id] }, orgId, users.admin);
      const gateway = await insert(Gateway, {
        name: 'Shared MCP', type: GatewayType.MCP, kind: GatewayKind.TOOL, endpoint: '/shared-mcp',
        organizationId: orgId, status: GatewayStatus.ACTIVE, configuration: {}, isSystem: false,
        visibility: 'org', teamId: null, ownerUserId: users.admin,
      });
      await insert(GatewayTool, { gatewayId: gateway.id, toolId: tool.id, isActive: true });
      // Another member's private agent using it is not the owner's to know about.
      const hidden = await agents.createAgent(
        { name: 'Member Secret Consumer', visibility: 'private', toolIds: [tool.id] }, orgId, users.member,
      );

      const err = await tools.updateTool(tool.id, { visibility: 'private' } as any, orgId, users.owner).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.message).toContain('agent "Org consumer"');
      expect(err.message).toContain('gateway "Shared MCP"');
      expect(err.message).not.toContain('Member Secret Consumer');
      expect(err.message).not.toMatch(/more you cannot see/);
      expect((await repo(Tool).findOneByOrFail({ id: tool.id })).visibility).toBe('org');

      // Once nothing shared uses it, it may go private (the member's
      // private agent is left to fail at run time, like a deleted tool).
      await agents.updateAgent(orgAgent.id, { toolIds: [] }, orgId, users.admin);
      await repo(GatewayTool).delete({ gatewayId: gateway.id, toolId: tool.id });
      const updated = await tools.updateTool(tool.id, { visibility: 'private' } as any, orgId, users.owner);
      expect(updated.visibility).toBe('private');
      expect(hidden.visibility).toBe('private');
    });

    it('is allowed when only the owner\'s own private agents use it', async () => {
      const tool = await tools.createTool(
        { name: 'solo_tool', description: 'x', type: ToolType.FUNCTION, parameters: {} } as any, orgId, users.owner,
      );
      await agents.createAgent({ name: 'Owner solo agent', visibility: 'private', toolIds: [tool.id] }, orgId, users.owner);
      const updated = await tools.updateTool(tool.id, { visibility: 'private' } as any, orgId, users.owner);
      expect(updated.visibility).toBe('private');
    });

    it('refuses making an agent private while a shared agent calls it as a sub-agent', async () => {
      const child = await agents.createAgent({ name: 'Child agent' }, orgId, users.owner);
      await agents.createAgent(
        {
          name: 'Parent org agent',
          pipeline: {
            nodes: [
              { id: 'in', type: 'input', position: { x: 0, y: 0 }, data: {} },
              { id: 'sub', type: 'sub_agent', position: { x: 0, y: 0 }, data: { agentId: child.id } },
              { id: 'out', type: 'output', position: { x: 0, y: 0 }, data: {} },
            ],
            edges: [
              { id: 'e1', source: 'in', target: 'sub' },
              { id: 'e2', source: 'sub', target: 'out' },
            ],
          } as any,
        },
        orgId,
        users.admin,
      );
      const err = await agents.updateAgent(child.id, { visibility: 'private' }, orgId, users.owner).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.message).toContain('agent "Parent org agent"');
      expect((await repo(Agent).findOneByOrFail({ id: child.id })).visibility).toBe('org');
    });

    it('refuses making an API private while its generated tools are used by shared agents', async () => {
      const api = await apis.create(
        { name: 'Shared API', type: ApiType.OPENAPI, baseUrl: 'https://shared.example.com', organizationId: orgId } as any,
        users.owner,
      );
      const generated = await insert(Tool, {
        name: 'shared_api_get', description: 'x', type: ToolType.API, parameters: {}, organizationId: orgId,
        apiId: api.id, createdBy: users.owner, visibility: 'org', status: 'active', version: '1.0.0',
      });
      await agents.createAgent({ name: 'API consumer', toolIds: [generated.id] }, orgId, users.admin);
      const err = await apis.update(api.id, { visibility: 'private' } as any, orgId, users.owner).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.message).toContain('agent "API consumer"');
      expect((await repo(Api).findOneByOrFail({ id: api.id })).visibility).toBe('org');
      expect((await repo(Tool).findOneByOrFail({ id: generated.id })).visibility).toBe('org');
    });
  });

  // ── Gap 7: name clashes do not tell on private rows ─────────────────

  describe('a name that is taken', () => {
    it('gets the same 409 whether the other tool is private or not, without saying whose', async () => {
      await tools.createTool({ name: 'visible_clash', description: 'x', type: ToolType.FUNCTION, parameters: {} } as any, orgId, users.admin);
      const onPrivate = await tools.createTool(
        { name: 'owner_private_tool', description: 'x', type: ToolType.FUNCTION, parameters: {} } as any, orgId, users.admin,
      ).catch((e) => e);
      const onVisible = await tools.createTool(
        { name: 'visible_clash', description: 'x', type: ToolType.FUNCTION, parameters: {} } as any, orgId, users.owner,
      ).catch((e) => e);
      expect(onPrivate).toBeInstanceOf(ConflictException);
      expect(onVisible).toBeInstanceOf(ConflictException);
      expect(onPrivate.message.replace('owner_private_tool', 'N')).toBe(onVisible.message.replace('visible_clash', 'N'));
      // Nothing beyond the name the caller typed: no owner, no tier.
      const rest = onPrivate.message.replace('owner_private_tool', 'N');
      expect(rest).not.toMatch(/private|owner|@gaps\.test/i);
    });

    it('renaming a tool onto a taken name is the same 409, not a 500', async () => {
      const tool = await tools.createTool({ name: 'renamable', description: 'x', type: ToolType.FUNCTION, parameters: {} } as any, orgId, users.admin);
      const err = await tools.updateTool(tool.id, { name: 'owner_private_tool' } as any, orgId, users.admin).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.message).toBe("The tool name 'owner_private_tool' is already in use in this organization. Choose another name.");
    });

    it('gets the same 409 for APIs, on create and on rename', async () => {
      const create = await apis.create(
        { name: 'Owner private API', type: ApiType.OPENAPI, baseUrl: 'https://x.example.com', organizationId: orgId } as any,
        users.member,
      ).catch((e) => e);
      expect(create).toBeInstanceOf(ConflictException);
      expect(create.message).toBe("The API name 'Owner private API' is already in use in this organization. Choose another name.");

      const mine = await apis.create(
        { name: 'Member API', type: ApiType.OPENAPI, baseUrl: 'https://m.example.com', organizationId: orgId } as any,
        users.member,
      );
      const rename = await apis.update(mine.id, { name: 'Owner private API' } as any, orgId, users.admin).catch((e) => e);
      expect(rename).toBeInstanceOf(ConflictException);
      expect(rename.message).toBe(create.message);
    });

    it('the private API itself is untouched by all that', async () => {
      expect((await repo(Api).findOneByOrFail({ id: privateApi.id })).name).toBe('Owner private API');
    });
  });
});
