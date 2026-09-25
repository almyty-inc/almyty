import { BadRequestException, ExecutionContext, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { versionsConfig } from 'typeorm-versions';

import { Agent, AgentStatus } from '../../entities/agent.entity';
import { AgentExecution } from '../../entities/agent-execution.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { Api, ApiType } from '../../entities/api.entity';
import { AuditLog } from '../../entities/audit-log.entity';
import { Conversation } from '../../entities/conversation.entity';
import { Gateway, GatewayType } from '../../entities/gateway.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { Message } from '../../entities/message.entity';
import { Operation } from '../../entities/operation.entity';
import { Organization } from '../../entities/organization.entity';
import { RequestLog } from '../../entities/request-log.entity';
import { Resource } from '../../entities/resource.entity';
import { ApiSchema } from '../../entities/api-schema.entity';
import { Tool, ToolStatus, ToolType } from '../../entities/tool.entity';
import { ToolCategory } from '../../entities/tool-category.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import { ToolTemplate } from '../../entities/tool-template.entity';
import { ToolVersion } from '../../entities/tool-version.entity';
import { UsageMetric } from '../../entities/usage-metric.entity';
import { User } from '../../entities/user.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { UserTeam } from '../../entities/user-team.entity';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import {
  PrivateAgentGuard,
  PrivateApiGuard,
  PrivateToolGuard,
} from '../../common/authorization/private-resource.guard';
import { AgentsService } from '../../modules/agents/agents.service';
import { AgentValidationHelper } from '../../modules/agents/agent-validation.helper';
import { ApisService } from '../../modules/apis/apis.service';
import { ToolsService } from '../../modules/tools/tools.service';
import { ToolsStatsHelper } from '../../modules/tools/tools-stats.helper';
import { McpToolHandler } from '../../modules/mcp/services/mcp-tool.handler';
import { AnalyticsService } from '../../modules/monitoring/analytics.service';
import { AnalyticsSummariesHelper } from '../../modules/monitoring/analytics-summaries.helper';
import { VersionsService } from '../../modules/versions/versions.service';
import { ToolHubService } from '../../modules/tool-hub/tool-hub.service';
import { AgentBuiltInToolsHelper } from '../../modules/agents/agent-builtin-tools.helper';
import { ExecutionAccessService, userPrincipal } from '../../common/authorization/execution-access.service';
import * as crypto from 'crypto';

/**
 * The "Private (just me)" tier on agents, tools and APIs, against a real
 * Postgres with the real migrations (the CHECK that a private row has an
 * owner is in 1750808000000-PrivateVisibility).
 *
 * Cast: `owner` owns the private rows (an org admin, since creating tools
 * takes that role). `member` is a plain member of the SAME organization;
 * `admin` is another admin and `orgOwner` holds the org's owner role.
 * "Just me" has to hold against
 * all three -- the admin bypass does not reach private rows.
 *
 * Gated on RUN_DB_INTEGRATION=1. Own schema so parallel workers do not
 * race each other's DDL.
 */
const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'private_visibility_ata_test';

jest.setTimeout(120_000);

describeIfDb('private visibility on agents, tools and APIs (real Postgres)', () => {
  let ds: DataSource;
  let policy: AccessPolicyService;
  let agents: AgentsService;
  let tools: ToolsService;
  let apis: ApisService;
  let mcp: McpToolHandler;
  let analytics: AnalyticsService;
  let versions: VersionsService;
  let hub: ToolHubService;

  let orgId: string;
  const users: Record<'owner' | 'member' | 'admin' | 'orgOwner', string> = {} as any;

  // Seeded rows
  let privateAgent: Agent;
  let orgAgent: Agent;
  let privateTool: Tool;
  let orgTool: Tool;
  let privateApi: Api;
  let orgApi: Api;

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

    const org = await ds.getRepository(Organization).save(
      ds.getRepository(Organization).create({ name: 'Private Org', slug: 'private-org' } as any),
    );
    orgId = (org as any).id;
    const roles: Record<keyof typeof users, OrganizationRole> = {
      owner: OrganizationRole.ADMIN,
      member: OrganizationRole.MEMBER,
      admin: OrganizationRole.ADMIN,
      orgOwner: OrganizationRole.OWNER,
    };
    for (const key of Object.keys(roles) as Array<keyof typeof users>) {
      const user = await ds.getRepository(User).save(
        ds.getRepository(User).create({ email: `${key}@private.test`, passwordHash: 'x', firstName: key, lastName: 'T' } as any),
      );
      users[key] = (user as any).id;
      await ds.getRepository(UserOrganization).save(
        ds.getRepository(UserOrganization).create({ userId: users[key], organizationId: orgId, role: roles[key], isActive: true } as any),
      );
    }

    policy = new AccessPolicyService(ds.getRepository(UserOrganization), ds.getRepository(UserTeam));
    const audit = { log: jest.fn(), logCreate: jest.fn(), logUpdate: jest.fn(), logDelete: jest.fn(), computeChanges: jest.fn() } as any;
    const statsHelper = new ToolsStatsHelper(ds.getRepository(Tool), ds.getRepository(ToolExecution));
    tools = new ToolsService(
      ds.getRepository(Tool),
      ds.getRepository(ToolVersion),
      ds.getRepository(ToolCategory),
      ds.getRepository(ToolExecution),
      ds.getRepository(Api),
      ds.getRepository(Operation),
      ds.getRepository(ApiSchema),
      ds.getRepository(User),
      ds.getRepository(Organization),
      audit,
      null as any,
      statsHelper,
      policy,
    );
    agents = new AgentsService(
      ds.getRepository(Agent),
      ds.getRepository(AgentExecution),
      ds.getRepository(Organization),
      ds.getRepository(User),
      { log: jest.fn() } as any,
      new AgentValidationHelper(),
      policy,
      { assertReady: jest.fn(), inspect: jest.fn() } as any,
    );
    apis = new ApisService(
      ds.getRepository(Api),
      ds.getRepository(ApiSchema),
      ds.getRepository(Operation),
      ds.getRepository(Resource),
      ds.getRepository(Organization),
      null as any,
      tools,
      audit,
      ds,
      null as any,
      null as any,
      policy,
      null as any,
    );
    const redis = { get: jest.fn().mockResolvedValue(null), setex: jest.fn().mockResolvedValue('OK') } as any;
    mcp = new McpToolHandler(
      ds.getRepository(Tool),
      ds.getRepository(GatewayTool),
      ds.getRepository(ToolCategory),
      tools,
      { executeTool: jest.fn().mockResolvedValue({ success: true, data: 'ran' }) } as any,
      redis,
    );
    analytics = new AnalyticsService(
      ds.getRepository(RequestLog),
      ds.getRepository(UsageMetric),
      ds.getRepository(ToolExecution),
      ds.getRepository(Conversation),
      ds.getRepository(Message),
      ds.getRepository(AuditLog),
      ds.getRepository(AgentRun),
      null as any,
      new AnalyticsSummariesHelper(ds.getRepository(AuditLog), ds.getRepository(AgentRun)),
    );
    versions = new VersionsService(ds);
    hub = new ToolHubService(ds.getRepository(ToolTemplate), ds.getRepository(Tool), ds.getRepository(Api), audit);

    // The owner's private resources, created through the services so the
    // owner stamping is what is under test, plus one org-wide of each.
    privateApi = await apis.create(
      { name: 'Owner private API', type: ApiType.OPENAPI, baseUrl: 'https://private.example.com', organizationId: orgId, visibility: 'private' } as any,
      users.owner,
    );
    orgApi = await apis.create(
      { name: 'Org API', type: ApiType.OPENAPI, baseUrl: 'https://org.example.com', organizationId: orgId } as any,
      users.owner,
    );
    privateTool = await tools.createTool(
      { name: 'owner_private_tool', description: 'secret thing', type: ToolType.FUNCTION, parameters: {}, visibility: 'private' } as any,
      orgId,
      users.owner,
    );
    orgTool = await tools.createTool(
      { name: 'org_tool', description: 'shared thing', type: ToolType.FUNCTION, parameters: {} } as any,
      orgId,
      users.owner,
    );
    // Gateways serve active tools only (a draft cannot be executed), so
    // publish both the way the owner would.
    privateTool = await tools.activateTool(privateTool.id, orgId, users.owner);
    orgTool = await tools.activateTool(orgTool.id, orgId, users.owner);
    privateAgent = await agents.createAgent(
      { name: 'Owner Private Agent', status: AgentStatus.ACTIVE, visibility: 'private', toolIds: [privateTool.id] },
      orgId,
      users.owner,
    );
    orgAgent = await agents.createAgent(
      { name: 'Org Agent', status: AgentStatus.ACTIVE, toolIds: [orgTool.id] },
      orgId,
      users.owner,
    );

    // Usage the numbers would otherwise leak.
    await ds.getRepository(ToolExecution).save([
      { toolId: privateTool.id, organizationId: orgId, userId: users.owner, parameters: {}, success: true, executionTime: 10 },
      { toolId: orgTool.id, organizationId: orgId, userId: users.owner, parameters: {}, success: true, executionTime: 10 },
    ] as any);
    await ds.getRepository(AgentRun).save([
      { agentId: privateAgent.id, organizationId: orgId, userId: users.owner, status: 'completed' },
      { agentId: orgAgent.id, organizationId: orgId, userId: users.owner, status: 'completed' },
    ] as any);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  const others = ['member', 'admin', 'orgOwner'] as const;
  const guardContext = (userId: string, params: Record<string, string>): ExecutionContext =>
    ({ switchToHttp: () => ({ getRequest: () => ({ user: { id: userId }, params }) }) }) as any;

  // ── The owner stamps ──────────────────────────────────────────────────

  it('stamps the creator as owner on every private row', () => {
    expect(privateAgent.visibility).toBe('private');
    expect(privateAgent.createdBy).toBe(users.owner);
    expect(privateTool.visibility).toBe('private');
    expect(privateTool.createdBy).toBe(users.owner);
    expect(privateApi.visibility).toBe('private');
    expect(privateApi.ownerUserId).toBe(users.owner);
    expect(privateApi.teamId).toBeNull();
  });

  // ── Agents ────────────────────────────────────────────────────────────

  describe('agents', () => {

    // create_agent builds a temporary agent on the parent's model config.
    // Left at the column default it was org-visible: while the parent run
    // lived, any member could fetch it by id or name and run it.
    it("keeps a private agent's temporary agent private to the same owner", async () => {
      const executionAccess = new ExecutionAccessService(policy);
      const helper = new AgentBuiltInToolsHelper(
        ds.getRepository(Agent),
        {} as any,
        {} as any,
        { executionAccess } as any,
        {} as any,
      );
      const parent = await ds.getRepository(Agent).findOneByOrFail({ id: privateAgent.id });
      parent.agentConfig = { ...(parent.agentConfig ?? {}), canCreateAgents: true } as any;
      const out = await helper.executeBuiltInTool(
        'create_agent',
        { name: `Owner Temp ${Date.now()}`, instructions: 'help' },
        { id: crypto.randomUUID(), organizationId: orgId, agentId: parent.id, userId: users.owner } as any,
        parent,
      );
      expect(out?.error).toBeUndefined();
      const temp = await ds.getRepository(Agent).findOneByOrFail({ id: out!.result.agentId });
      expect(temp.isTemporary).toBe(true);
      expect(temp.visibility).toBe('private');
      expect(temp.createdBy).toBe(users.owner);

      expect((await agents.getAgent(temp.id, orgId, { id: users.owner })).id).toBe(temp.id);
      expect((await executionAccess.canExecute(userPrincipal(users.owner), temp)).allowed).toBe(true);
      for (const who of others) {
        await expect(agents.getAgent(temp.id, orgId, { id: users[who] })).rejects.toBeInstanceOf(NotFoundException);
        expect(await agents.findByName(temp.name, orgId, users[who])).toBeNull();
        expect((await executionAccess.canExecute(userPrincipal(users[who]), temp)).allowed).toBe(false);
      }
      await ds.getRepository(Agent).delete({ id: temp.id });
    });
    it('lists, counts and searches the private agent for its owner only', async () => {
      const mine = await agents.getAgents({ organizationId: orgId, caller: { id: users.owner } });
      expect(mine.data.map((a) => a.id).sort()).toEqual([privateAgent.id, orgAgent.id].sort());
      expect(mine.total).toBe(2);
      for (const who of others) {
        const theirs = await agents.getAgents({ organizationId: orgId, caller: { id: users[who] } });
        expect(theirs.data.map((a) => a.id)).toEqual([orgAgent.id]);
        expect(theirs.total).toBe(1);
        const search = await agents.getAgents({ organizationId: orgId, caller: { id: users[who] }, search: 'Private' });
        expect(search.total).toBe(0);
      }
    });

    it('answers "not found" to anyone else fetching it by id, admins included', async () => {
      await expect(agents.getAgent(privateAgent.id, orgId, { id: users.owner })).resolves.toMatchObject({ id: privateAgent.id });
      for (const who of others) {
        await expect(agents.getAgent(privateAgent.id, orgId, { id: users[who] })).rejects.toBeInstanceOf(NotFoundException);
      }
    });

    it('route guard 404s every agents/:id route for anyone but the owner', async () => {
      const guard = new PrivateAgentGuard(ds);
      await expect(guard.canActivate(guardContext(users.owner, { id: privateAgent.id }))).resolves.toBe(true);
      for (const who of others) {
        await expect(guard.canActivate(guardContext(users[who], { id: privateAgent.id }))).rejects.toBeInstanceOf(NotFoundException);
        await expect(guard.canActivate(guardContext(users[who], { id: orgAgent.id }))).resolves.toBe(true);
      }
    });

    it('never resolves it by name or lists it on /v1/models for anyone else', async () => {
      expect((await agents.findByName('Owner Private Agent', orgId, users.owner))?.id).toBe(privateAgent.id);
      expect(await agents.findByName('owner-private-agent', orgId, users.member)).toBeNull();
      expect(await agents.findByName('Owner Private Agent', orgId, users.admin)).toBeNull();
      expect(await agents.findByName('Owner Private Agent', orgId, null)).toBeNull();
      expect((await agents.findAllActive(orgId, users.owner)).map((a) => a.id)).toContain(privateAgent.id);
      for (const who of others) {
        expect((await agents.findAllActive(orgId, users[who])).map((a) => a.id)).not.toContain(privateAgent.id);
      }
    });

    it('refuses to let anyone else update or delete it (404, not 403)', async () => {
      for (const who of others) {
        await expect(agents.updateAgent(privateAgent.id, { name: 'hijacked' }, orgId, users[who])).rejects.toBeInstanceOf(NotFoundException);
        await expect(agents.deleteAgent(privateAgent.id, orgId, users[who])).rejects.toBeInstanceOf(NotFoundException);
      }
    });

    it('keeps its runs out of other members\' analytics', async () => {
      const mine = await analytics.getAgentRunsSummary(orgId, users.owner);
      expect(mine.byAgent.map((r: any) => r.agentId)).toContain(privateAgent.id);
      expect(mine.totals.total).toBe(2);
      for (const who of others) {
        const theirs = await analytics.getAgentRunsSummary(orgId, users[who]);
        expect(theirs.byAgent.map((r: any) => r.agentId)).not.toContain(privateAgent.id);
        expect(theirs.totals.total).toBe(1);
      }
    });

    it('refuses an org-wide agent that references a private tool, even the owner\'s own', async () => {
      await expect(
        agents.createAgent({ name: 'Leaky Org Agent', toolIds: [privateTool.id] }, orgId, users.owner),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        agents.createAgent({
          name: 'Leaky Pipeline Agent',
          pipeline: {
            nodes: [
              { id: 'in', type: 'input', data: {} },
              { id: 't', type: 'tool_call', data: { toolId: privateTool.id } },
              { id: 'out', type: 'output', data: {} },
            ],
            edges: [{ id: 'e1', source: 'in', target: 't' }, { id: 'e2', source: 't', target: 'out' }],
          } as any,
        }, orgId, users.owner),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses another member\'s private agent that points at the owner\'s private tool or agent', async () => {
      await expect(
        agents.createAgent({ name: 'Borrower', visibility: 'private', toolIds: [privateTool.id] }, orgId, users.member),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        agents.createAgent({
          name: 'Borrower 2',
          visibility: 'private',
          collaboration: { strategy: 'sequential', participants: [{ kind: 'agent', agentId: privateAgent.id }] },
        }, orgId, users.member),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('lets the owner wire their private tool into their own private agent', async () => {
      const ok = await agents.createAgent(
        { name: 'Owner Second Private', visibility: 'private', toolIds: [privateTool.id] },
        orgId,
        users.owner,
      );
      expect(ok.visibility).toBe('private');
      await agents.deleteAgent(ok.id, orgId, users.owner);
    });

    it('does not let an admin take a member\'s org agent private; the owner can', async () => {
      await expect(
        agents.updateAgent(orgAgent.id, { visibility: 'private' }, orgId, users.admin),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const flipped = await agents.updateAgent(orgAgent.id, { visibility: 'private' }, orgId, users.owner);
      expect(flipped.visibility).toBe('private');
      expect(flipped.createdBy).toBe(users.owner);
      const back = await agents.updateAgent(orgAgent.id, { visibility: 'org' }, orgId, users.owner);
      expect(back.visibility).toBe('org');
    });

    it('hides its version history from anyone else', async () => {
      for (const who of others) {
        await expect(versions.getVersions('Agent', privateAgent.id, orgId, { callerId: users[who] })).rejects.toBeInstanceOf(NotFoundException);
      }
      await expect(versions.getVersions('Agent', privateAgent.id, orgId, { callerId: users.owner })).resolves.toBeDefined();
    });
  });

  // ── Tools ─────────────────────────────────────────────────────────────

  describe('tools', () => {
    it('lists, counts and searches the private tool for its owner only', async () => {
      const mine = await tools.getTools({ organizationId: orgId, caller: { id: users.owner } });
      expect(mine.tools.map((t) => t.id).sort()).toEqual([privateTool.id, orgTool.id].sort());
      for (const who of others) {
        const theirs = await tools.getTools({ organizationId: orgId, caller: { id: users[who] } });
        expect(theirs.tools.map((t) => t.id)).toEqual([orgTool.id]);
        expect(theirs.total).toBe(1);
        const search = await tools.getTools({ organizationId: orgId, caller: { id: users[who] }, search: 'secret' });
        expect(search.total).toBe(0);
      }
    });

    it('keeps it out of the gateway (bypass) listing for anyone but the owner', async () => {
      const anonymous = await tools.getTools({ organizationId: orgId, bypassTeamFilter: true });
      expect(anonymous.tools.map((t) => t.id)).not.toContain(privateTool.id);
      const asMember = await tools.getTools({ organizationId: orgId, bypassTeamFilter: true, caller: { id: users.member } });
      expect(asMember.tools.map((t) => t.id)).not.toContain(privateTool.id);
      const asOwner = await tools.getTools({ organizationId: orgId, bypassTeamFilter: true, caller: { id: users.owner } });
      expect(asOwner.tools.map((t) => t.id)).toContain(privateTool.id);
    });

    it('answers "not found" by id and on every tools/:toolId route', async () => {
      await expect(tools.getTool(privateTool.id, orgId, true, { id: users.owner })).resolves.toMatchObject({ id: privateTool.id });
      const guard = new PrivateToolGuard(ds);
      await expect(guard.canActivate(guardContext(users.owner, { organizationId: orgId, toolId: privateTool.id }))).resolves.toBe(true);
      for (const who of others) {
        await expect(tools.getTool(privateTool.id, orgId, true, { id: users[who] })).rejects.toBeInstanceOf(NotFoundException);
        await expect(guard.canActivate(guardContext(users[who], { organizationId: orgId, toolId: privateTool.id }))).rejects.toBeInstanceOf(NotFoundException);
        await expect(tools.updateTool(privateTool.id, { name: 'x' } as any, orgId, users[who])).rejects.toBeInstanceOf(NotFoundException);
        await expect(tools.deleteTool(privateTool.id, orgId, users[who])).rejects.toBeInstanceOf(NotFoundException);
      }
    });

    it('leaves it out of other members\' tool statistics and usage analytics', async () => {
      const mine = await tools.getOrganizationToolStats(orgId, users.owner);
      expect(mine.totalTools).toBe(2);
      expect(mine.totalExecutions).toBe(2);
      for (const who of others) {
        const theirs = await tools.getOrganizationToolStats(orgId, users[who]);
        expect(theirs.totalTools).toBe(1);
        expect(theirs.totalExecutions).toBe(1);
        expect(theirs.topUsedTools.map((t) => t.tool.id)).not.toContain(privateTool.id);
        const usage = await analytics.getToolUsage(orgId, '7d', users[who]);
        expect(usage.map((u: any) => u.toolId)).not.toContain(privateTool.id);
      }
      const ownerUsage = await analytics.getToolUsage(orgId, '7d', users.owner);
      expect(ownerUsage.map((u: any) => u.toolId)).toContain(privateTool.id);
    });

    it('is neither listed, fetched nor callable over MCP by anyone else', async () => {
      const call = { name: 'owner_private_tool', arguments: {} } as any;
      for (const who of others) {
        const listed = await mcp.handleToolsList({}, orgId, undefined, { id: users[who] });
        expect(listed.tools.map((t: any) => t.name)).not.toContain('owner_private_tool');
        await expect(mcp.handleToolGet({ name: 'owner_private_tool' }, orgId, users[who])).rejects.toMatchObject({ message: expect.stringContaining('not found') });
        await expect(mcp.handleToolCall(call, orgId, users[who])).rejects.toMatchObject({ message: expect.stringContaining('Tool not found') });
      }
      const mine = await mcp.handleToolsList({}, orgId, undefined, { id: users.owner });
      expect(mine.tools.map((t: any) => t.name)).toContain('owner_private_tool');
      await expect(mcp.handleToolCall(call, orgId, users.owner)).resolves.toMatchObject({ isError: false });
    });

    it('is served through a gateway only when the gateway is private to the tool\'s owner', async () => {
      const gateways = ds.getRepository(Gateway);
      const orgGateway = await gateways.save(gateways.create({
        name: 'org gw', type: GatewayType.MCP, endpoint: '/org-gw', organizationId: orgId, configuration: {},
      } as any)) as unknown as Gateway;
      const ownerGateway = await gateways.save(gateways.create({
        name: 'owner gw', type: GatewayType.MCP, endpoint: '/owner-gw', organizationId: orgId, configuration: {},
        visibility: 'private', ownerUserId: users.owner,
      } as any)) as unknown as Gateway;
      await ds.getRepository(GatewayTool).save([
        { gatewayId: orgGateway.id, toolId: privateTool.id, isActive: true },
        { gatewayId: orgGateway.id, toolId: orgTool.id, isActive: true },
        { gatewayId: ownerGateway.id, toolId: privateTool.id, isActive: true },
      ] as any);

      const viaOrg = await mcp.handleToolsList({}, orgId, orgGateway.id, { id: users.owner });
      expect(viaOrg.tools.map((t: any) => t.name)).toEqual(['org_tool']);
      await expect(
        mcp.handleToolCall({ name: 'owner_private_tool', arguments: {} } as any, orgId, users.owner, orgGateway.id),
      ).rejects.toMatchObject({ message: expect.stringContaining('Tool not found') });

      const viaOwner = await mcp.handleToolsList({}, orgId, ownerGateway.id, { id: users.owner });
      expect(viaOwner.tools.map((t: any) => t.name)).toEqual(['owner_private_tool']);
    });

    it('cannot be published to the hub by anyone else', async () => {
      for (const who of others) {
        await expect(hub.publishTool(orgId, users[who], { toolId: privateTool.id } as any)).rejects.toBeInstanceOf(NotFoundException);
      }
    });

    it('hides its version history from anyone else', async () => {
      for (const who of others) {
        await expect(versions.getVersions('Tool', privateTool.id, orgId, { callerId: users[who] })).rejects.toBeInstanceOf(NotFoundException);
      }
    });

    it('does not let an admin take a member\'s org tool private', async () => {
      await expect(
        tools.updateTool(orgTool.id, { visibility: 'private' } as any, orgId, users.admin),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ── APIs ──────────────────────────────────────────────────────────────

  describe('apis', () => {
    it('lists and counts the private API for its owner only', async () => {
      const mine = await apis.findAllByOrganization({ id: users.owner }, orgId);
      expect(mine.apis.map((a) => a.id).sort()).toEqual([privateApi.id, orgApi.id].sort());
      expect(mine.total).toBe(2);
      for (const who of others) {
        const theirs = await apis.findAllByOrganization({ id: users[who] }, orgId);
        expect(theirs.apis.map((a) => a.id)).toEqual([orgApi.id]);
        expect(theirs.total).toBe(1);
      }
    });

    it('answers "not found" by id and on every apis/:id route', async () => {
      await expect(apis.findOne(privateApi.id, orgId, { id: users.owner })).resolves.toMatchObject({ id: privateApi.id });
      const guard = new PrivateApiGuard(ds);
      for (const who of others) {
        await expect(apis.findOne(privateApi.id, orgId, { id: users[who] })).rejects.toBeInstanceOf(NotFoundException);
        await expect(guard.canActivate(guardContext(users[who], { id: privateApi.id }))).rejects.toBeInstanceOf(NotFoundException);
        await expect(apis.update(privateApi.id, { description: 'x' } as any, orgId, users[who])).rejects.toBeInstanceOf(NotFoundException);
        await expect(apis.remove(privateApi.id, orgId, users[who])).rejects.toBeInstanceOf(NotFoundException);
      }
      // Tool generation routes name the API as :apiId.
      const toolGuard = new PrivateToolGuard(ds);
      await expect(toolGuard.canActivate(guardContext(users.member, { organizationId: orgId, apiId: privateApi.id }))).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses a tool built on another member\'s private API', async () => {
      await expect(
        tools.createTool({ name: 'borrowed', description: 'x', type: ToolType.FUNCTION, parameters: {}, apiId: privateApi.id } as any, orgId, users.admin),
      ).rejects.toBeInstanceOf(BadRequestException);
      // ...and an org-wide tool on the owner's own private API.
      await expect(
        tools.createTool({ name: 'widened', description: 'x', type: ToolType.FUNCTION, parameters: {}, apiId: privateApi.id } as any, orgId, users.owner),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('does not let an admin take a member\'s org API private', async () => {
      await expect(apis.update(orgApi.id, { visibility: 'private' } as any, orgId, users.admin)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('takes the tools generated from it private with it when the owner makes it private', async () => {
      // Generated by another member's import: the importer is its creator,
      // the flag is what makes it one of the API's generated tools.
      const generated = await ds.getRepository(Tool).save(ds.getRepository(Tool).create({
        name: 'org_api_generated', type: ToolType.API, organizationId: orgId, apiId: orgApi.id,
        status: ToolStatus.ACTIVE, createdBy: users.admin, generated: true, version: '1.0.0',
      } as any)) as unknown as Tool;
      // Built on it by hand by another member: keeps its owner.
      const handmade = await ds.getRepository(Tool).save(ds.getRepository(Tool).create({
        name: 'org_api_handmade', type: ToolType.API, organizationId: orgId, apiId: orgApi.id,
        status: ToolStatus.ACTIVE, createdBy: users.admin, version: '1.0.0',
      } as any)) as unknown as Tool;
      const updated = await apis.update(orgApi.id, { visibility: 'private' } as any, orgId, users.owner);
      expect(updated.visibility).toBe('private');
      expect(updated.ownerUserId).toBe(users.owner);
      const reloaded = await ds.getRepository(Tool).findOneByOrFail({ id: generated.id });
      expect(reloaded.visibility).toBe('private');
      expect(reloaded.createdBy).toBe(users.owner);
      const kept = await ds.getRepository(Tool).findOneByOrFail({ id: handmade.id });
      expect(kept.visibility).not.toBe('private');
      expect(kept.createdBy).toBe(users.admin);
      const memberTools = await tools.getTools({ organizationId: orgId, caller: { id: users.member } });
      expect(memberTools.tools.map((t) => t.id)).not.toContain(generated.id);
    });
  });
});
