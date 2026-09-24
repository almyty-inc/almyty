import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { versionsConfig } from 'typeorm-versions';

import { Organization } from '../../entities/organization.entity';
import { User } from '../../entities/user.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { Gateway, GatewayKind, GatewayStatus, GatewayType } from '../../entities/gateway.entity';
import { LlmProvider, LlmProviderStatus } from '../../entities/llm-provider.entity';
import { LlmProviderType } from '../../entities/llm-provider-type';
import { Tool, ToolType } from '../../entities/tool.entity';
import { Agent, AgentStatus } from '../../entities/agent.entity';
import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { RequestLog } from '../../entities/request-log.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import { Conversation } from '../../entities/conversation.entity';
import { PromotedSkill } from '../../entities/promoted-skill.entity';
import { AnalyticsService } from '../../modules/monitoring/analytics.service';
import { AnalyticsExportHelper } from '../../modules/monitoring/analytics-export.helper';
import { PromotedSkillsService } from '../../modules/promoted-skills/promoted-skills.service';
import { PromotedSkillRenderer } from '../../modules/promoted-skills/promoted-skill-renderer';

/**
 * Outputs that carry rows of a private resource: the request log (org-wide
 * and per tool), the analytics export (requests, tool executions, LLM
 * sessions) and promoted skills. Member A ('owner') owns one private tool,
 * gateway, provider and agent; member B ('peer') and org admin C ('admin')
 * must not get a single row tied to any of them, and A must get all of
 * them. A call with no known viewer gets none.
 *
 * Real Postgres (the SQL fragments in monitoring/private-rows.ts are the
 * thing under test), built by running the migrations. Gated on
 * RUN_DB_INTEGRATION=1 and isolated in its own schema.
 */
const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'private_output_leaks_test';

jest.setTimeout(120_000);

describeIfDb('Private visibility: logs, export and promoted skills (real Postgres)', () => {
  let ds: DataSource;
  let organizationId: string;
  const users: Record<'owner' | 'peer' | 'admin', string> = {} as any;
  const others = ['peer', 'admin'] as const;

  // One private (owner's) and one org-wide row of each kind.
  const ids = {} as Record<
    | 'privateTool' | 'orgTool' | 'privateGateway' | 'orgGateway' | 'privateProvider' | 'orgProvider'
    | 'privateAgent' | 'orgAgent' | 'privateRun' | 'orgRun',
    string
  >;
  // The rows each output would carry, labelled by what makes them private.
  const logIds = {} as Record<'clean' | 'viaPrivateTool' | 'viaPrivateGateway', string>;
  const execIds = {} as Record<'clean' | 'privateTool' | 'viaPrivateGateway' | 'byPrivateAgentRun', string>;
  const sessionIds = {} as Record<'clean' | 'privateProvider' | 'privateAgent' | 'viaPrivateGateway', string>;
  const skillIds = {} as Record<'fromOrgAgent' | 'fromPrivateAgent' | 'noAgent', string>;

  let analytics: AnalyticsService;
  let skills: PromotedSkillsService;

  const repo = <T extends object>(entity: new () => T) => ds.getRepository(entity);
  const insert = async (entity: new () => any, data: Record<string, unknown>): Promise<string> =>
    ((await repo(entity).save(repo(entity).create(data as any))) as any).id;

  const connection = () => ({
    type: 'postgres' as const,
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || '',
    database: process.env.DATABASE_NAME || 'almyty_test',
  });

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

    organizationId = await insert(Organization, { name: 'Leak Org', slug: 'leak-org' });
    const roles: Array<[keyof typeof users, OrganizationRole]> = [
      ['owner', OrganizationRole.MEMBER],
      ['peer', OrganizationRole.MEMBER],
      ['admin', OrganizationRole.ADMIN],
    ];
    for (const [name, role] of roles) {
      users[name] = await insert(User, { email: `${name}@leak.test`, passwordHash: 'x', firstName: name, lastName: 'T' });
      await insert(UserOrganization, { userId: users[name], organizationId, role, isActive: true, inviteAccepted: true });
    }

    ids.privateTool = await insert(Tool, {
      name: 'owner_private_tool', type: ToolType.FUNCTION, parameters: {}, organizationId,
      visibility: 'private', createdBy: users.owner,
    });
    ids.orgTool = await insert(Tool, {
      name: 'org_tool', type: ToolType.FUNCTION, parameters: {}, organizationId,
      visibility: 'org', createdBy: users.owner,
    });
    ids.privateGateway = await insert(Gateway, {
      name: 'Owner private MCP', type: GatewayType.MCP, kind: GatewayKind.TOOL, endpoint: '/owner-private',
      organizationId, status: GatewayStatus.ACTIVE, configuration: {}, visibility: 'private', ownerUserId: users.owner,
    });
    ids.orgGateway = await insert(Gateway, {
      name: 'Shared MCP', type: GatewayType.MCP, kind: GatewayKind.TOOL, endpoint: '/shared',
      organizationId, status: GatewayStatus.ACTIVE, configuration: {}, visibility: 'org', ownerUserId: users.peer,
    });
    ids.privateProvider = await insert(LlmProvider, {
      name: 'Owner private OpenAI', type: LlmProviderType.OPENAI, organizationId, configuration: { model: 'x' },
      status: LlmProviderStatus.ACTIVE, visibility: 'private', ownerUserId: users.owner,
    });
    ids.orgProvider = await insert(LlmProvider, {
      name: 'Shared OpenAI', type: LlmProviderType.OPENAI, organizationId, configuration: { model: 'x' },
      status: LlmProviderStatus.ACTIVE, visibility: 'org', ownerUserId: users.peer,
    });
    ids.privateAgent = await insert(Agent, {
      name: 'Owner Private Agent', status: AgentStatus.ACTIVE, organizationId, pipeline: { nodes: [], edges: [] },
      visibility: 'private', createdBy: users.owner,
    });
    ids.orgAgent = await insert(Agent, {
      name: 'Org Agent', status: AgentStatus.ACTIVE, organizationId, pipeline: { nodes: [], edges: [] },
      visibility: 'org', createdBy: users.owner,
    });
    ids.privateRun = await insert(AgentRun, {
      agentId: ids.privateAgent, organizationId, userId: users.owner, status: AgentRunStatus.COMPLETED,
    });
    ids.orgRun = await insert(AgentRun, {
      agentId: ids.orgAgent, organizationId, userId: users.owner, status: AgentRunStatus.COMPLETED,
    });

    const now = new Date();
    const log = (extra: Record<string, unknown>) => insert(RequestLog, {
      method: 'POST', path: '/x', statusCode: 200, responseTime: 1, organizationId, timestamp: now, ...extra,
    });
    // Every export row joins a gateway, so the "clean" and "private tool"
    // logs ride the org gateway.
    logIds.clean = await log({ gatewayId: ids.orgGateway, toolId: ids.orgTool });
    logIds.viaPrivateTool = await log({ gatewayId: ids.orgGateway, toolId: ids.privateTool });
    logIds.viaPrivateGateway = await log({ gatewayId: ids.privateGateway, toolId: ids.orgTool });

    const exec = (extra: Record<string, unknown>) => insert(ToolExecution, {
      organizationId, userId: users.owner, parameters: {}, success: true, executionTime: 1, ...extra,
    });
    execIds.clean = await exec({ toolId: ids.orgTool, gatewayId: ids.orgGateway, runId: ids.orgRun });
    execIds.privateTool = await exec({ toolId: ids.privateTool });
    execIds.viaPrivateGateway = await exec({ toolId: ids.orgTool, gatewayId: ids.privateGateway });
    execIds.byPrivateAgentRun = await exec({ toolId: ids.orgTool, runId: ids.privateRun });

    const session = (extra: Record<string, unknown>) => insert(Conversation, {
      organizationId, userId: users.owner, context: {}, ...extra,
    });
    sessionIds.clean = await session({ providerId: ids.orgProvider, agentId: ids.orgAgent, gatewayId: ids.orgGateway });
    sessionIds.privateProvider = await session({ providerId: ids.privateProvider });
    sessionIds.privateAgent = await session({ providerId: ids.orgProvider, agentId: ids.privateAgent });
    sessionIds.viaPrivateGateway = await session({ providerId: ids.orgProvider, gatewayId: ids.privateGateway });

    const skill = (slug: string, agentId: string | null) => insert(PromotedSkill, {
      organizationId, agentId, name: slug, slug, content: `# ${slug}`, version: 1, createdBy: users.owner,
    });
    skillIds.fromOrgAgent = await skill('from-org-agent', ids.orgAgent);
    skillIds.fromPrivateAgent = await skill('from-private-agent', ids.privateAgent);
    skillIds.noAgent = await skill('no-agent', null);

    const exportHelper = new AnalyticsExportHelper(repo(RequestLog), repo(ToolExecution), repo(Conversation));
    analytics = new AnalyticsService(
      repo(RequestLog), null as any, repo(ToolExecution), repo(Conversation), null as any, null as any, repo(AgentRun),
      exportHelper, null as any,
    );
    skills = new PromotedSkillsService(repo(PromotedSkill), repo(AgentRun), new PromotedSkillRenderer(), null as any);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  const sorted = (xs: string[]) => [...xs].sort();

  // ── Request log (Analytics > Requests, and a tool's own log via ?toolId=)

  describe('request log', () => {
    const logsFor = async (callerId: string | null, extra: { toolId?: string } = {}) =>
      (await analytics.getRequestLogs({ organizationId, page: 1, limit: 100, callerId: callerId as any, ...extra }))
        .data.map((l) => l.id);

    it("drops another member's private tool and private gateway traffic, for admins too", async () => {
      for (const who of others) {
        expect(await logsFor(users[who])).toEqual([logIds.clean]);
      }
    });

    it('keeps them for their owner', async () => {
      expect(sorted(await logsFor(users.owner))).toEqual(sorted(Object.values(logIds)));
    });

    it("a private tool's own log is empty for anyone else, full for its owner", async () => {
      for (const who of others) {
        expect(await logsFor(users[who], { toolId: ids.privateTool })).toEqual([]);
      }
      expect(await logsFor(users.owner, { toolId: ids.privateTool })).toEqual([logIds.viaPrivateTool]);
    });

    it('with no known viewer returns no private row', async () => {
      expect(await logsFor(null)).toEqual([logIds.clean]);
    });
  });

  // ── Analytics export

  describe('analytics export', () => {
    const exported = async (type: 'requests' | 'tool-executions' | 'llm-sessions', callerId: string | null) =>
      ((await analytics.exportData({ organizationId, type, format: 'json', callerId: callerId as any })) as any[])
        .map((r) => r.id);

    it("requests: another member's private tool and gateway rows are left out", async () => {
      for (const who of others) expect(await exported('requests', users[who])).toEqual([logIds.clean]);
      expect(sorted(await exported('requests', users.owner))).toEqual(sorted(Object.values(logIds)));
      expect(await exported('requests', null)).toEqual([logIds.clean]);
    });

    it("tool executions: private tool, private gateway and private agent's runs are left out", async () => {
      for (const who of others) expect(await exported('tool-executions', users[who])).toEqual([execIds.clean]);
      expect(sorted(await exported('tool-executions', users.owner))).toEqual(sorted(Object.values(execIds)));
      expect(await exported('tool-executions', null)).toEqual([execIds.clean]);
    });

    it("LLM sessions: private provider, private agent and private gateway sessions are left out", async () => {
      for (const who of others) expect(await exported('llm-sessions', users[who])).toEqual([sessionIds.clean]);
      expect(sorted(await exported('llm-sessions', users.owner))).toEqual(sorted(Object.values(sessionIds)));
      expect(await exported('llm-sessions', null)).toEqual([sessionIds.clean]);
    });

    it('CSV carries the same rows as JSON', async () => {
      const csv = (await analytics.exportData({
        organizationId, type: 'tool-executions', format: 'csv', callerId: users.admin,
      })) as string;
      expect(csv).toContain(execIds.clean);
      for (const id of [execIds.privateTool, execIds.viaPrivateGateway, execIds.byPrivateAgentRun]) {
        expect(csv).not.toContain(id);
      }
    });
  });

  // ── Promoted skills (REST list/get and MCP skills/list, skills/get)

  describe('promoted skills', () => {
    it("a skill promoted from another member's private agent is not listed, served or readable", async () => {
      for (const who of others) {
        expect(sorted((await skills.list(organizationId, users[who])).map((s) => s.id)))
          .toEqual(sorted([skillIds.fromOrgAgent, skillIds.noAgent]));
        expect(sorted((await skills.listForServing(organizationId, users[who])).map((s) => s.name)))
          .toEqual(['from-org-agent', 'no-agent']);
        await expect(skills.get(skillIds.fromPrivateAgent, organizationId, users[who])).rejects.toBeInstanceOf(NotFoundException);
        await expect(skills.remove(skillIds.fromPrivateAgent, organizationId, users[who])).rejects.toBeInstanceOf(NotFoundException);
      }
      expect(await repo(PromotedSkill).findOneBy({ id: skillIds.fromPrivateAgent })).not.toBeNull();
    });

    it('its owner sees it everywhere', async () => {
      expect(sorted((await skills.list(organizationId, users.owner)).map((s) => s.id))).toEqual(sorted(Object.values(skillIds)));
      expect((await skills.get(skillIds.fromPrivateAgent, organizationId, users.owner)).content).toBe('# from-private-agent');
    });

    it('with no known viewer no private-derived skill is served', async () => {
      expect(sorted((await skills.listForServing(organizationId, null)).map((s) => s.name))).toEqual(['from-org-agent', 'no-agent']);
      await expect(skills.get(skillIds.fromPrivateAgent, organizationId, null)).rejects.toBeInstanceOf(NotFoundException);
    });

    it("promoting another member's private agent's run is refused as not found", async () => {
      await expect(skills.promoteFromRun(ids.privateRun, organizationId, users.admin, {}))
        .rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
