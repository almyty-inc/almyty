import { BadRequestException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Organization } from '../../entities/organization.entity';
import { User } from '../../entities/user.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { Team } from '../../entities/team.entity';
import { UserTeam, TeamRole } from '../../entities/user-team.entity';
import { Gateway, GatewayKind, GatewayStatus, GatewayType } from '../../entities/gateway.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { GatewayAuth } from '../../entities/gateway-auth.entity';
import { UsageMetric } from '../../entities/usage-metric.entity';
import { Tool, ToolExecutionMethod, ToolStatus, ToolType } from '../../entities/tool.entity';
import { ToolTemplate } from '../../entities/tool-template.entity';
import { Api } from '../../entities/api.entity';
import { Agent, AgentStatus } from '../../entities/agent.entity';
import { ApiKey } from '../../entities/api-key.entity';

import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { GatewaysService } from '../../modules/gateways/gateways.service';
import { GatewayInfoController } from '../../modules/gateways/gateway-info.controller';
import { PrivateGatewayGuard } from '../../modules/gateways/private-gateway.guard';
import { UnifiedEndpointController } from '../../modules/gateways/unified-endpoint.controller';
import { A2AAgentCardService } from '../../modules/a2a/a2a-agent-card.service';
import { ToolHubService } from '../../modules/tool-hub/tool-hub.service';

/**
 * Team scope is a read boundary, not only an execution one, against a real
 * Postgres (migrations, real CHECK constraints, the real membership join in
 * AccessPolicyService.getTeamMemberships):
 *
 * - a team gateway named by id (the dashboard route guard, getGateway,
 *   resolve by slug, the manage gate) is the same 404 as a missing one for
 *   a member outside the team, and readable by the team and by org
 *   owners/admins;
 * - publishing a tool to the hub takes the right to manage it, and only an
 *   org-visible tool publishes;
 * - the public root agent card only ever describes the configured
 *   gateway's own, active agent.
 *
 * Gated on RUN_DB_INTEGRATION=1 and isolated in its own schema.
 */
const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'team_read_boundary_test';

jest.setTimeout(120_000);

describeIfDb('Team scope is a read boundary (real Postgres)', () => {
  let ds: DataSource;
  let policy: AccessPolicyService;

  let organizationId: string;
  let orgSlug: string;
  let otherOrgId: string;
  let teamId: string;
  // lead: team lead, plain org member. teammate: team member. outsider: org
  // member on no team. admin / orgOwner: the org roles that read every team.
  // stranger: a member of another organization only.
  const users: Record<'lead' | 'teammate' | 'outsider' | 'admin' | 'orgOwner' | 'stranger', string> = {} as any;

  let teamGateway: Gateway;
  let orgGateway: Gateway;

  const repo = <T extends object>(entity: new () => T) => ds.getRepository(entity);
  const insert = async <T extends object>(entity: new () => T, data: Record<string, unknown>): Promise<T> =>
    (await repo(entity).save(repo(entity).create(data as any) as unknown as T)) as T;

  beforeAll(async () => {
    const connection = {
      type: 'postgres' as const,
      host: process.env.DATABASE_HOST || '127.0.0.1',
      port: Number(process.env.DATABASE_PORT || 5432),
      username: process.env.DATABASE_USERNAME || 'postgres',
      password: process.env.DATABASE_PASSWORD || '',
      database: process.env.DATABASE_NAME || 'almyty_test',
    };
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

    policy = new AccessPolicyService(repo(UserOrganization), repo(UserTeam));

    const org = await insert(Organization, { name: 'Team Org', slug: 'team-org' });
    organizationId = (org as any).id;
    orgSlug = (org as any).slug;
    const otherOrg = await insert(Organization, { name: 'Other Org', slug: 'other-org' });
    otherOrgId = (otherOrg as any).id;

    const roles: Array<[keyof typeof users, OrganizationRole, string]> = [
      ['lead', OrganizationRole.MEMBER, organizationId],
      ['teammate', OrganizationRole.MEMBER, organizationId],
      ['outsider', OrganizationRole.MEMBER, organizationId],
      ['admin', OrganizationRole.ADMIN, organizationId],
      ['orgOwner', OrganizationRole.OWNER, organizationId],
      ['stranger', OrganizationRole.OWNER, otherOrgId],
    ];
    for (const [name, role, orgId] of roles) {
      const user = await insert(User, { email: `${name}@team.test`, passwordHash: 'x', firstName: name, lastName: 'T' });
      users[name] = (user as any).id;
      await insert(UserOrganization, { userId: users[name], organizationId: orgId, role, isActive: true, inviteAccepted: true });
    }

    teamId = (await insert(Team, { name: 'Payments', organizationId })).id as string;
    await insert(UserTeam, { userId: users.lead, teamId, role: TeamRole.LEAD, isActive: true });
    await insert(UserTeam, { userId: users.teammate, teamId, role: TeamRole.MEMBER, isActive: true });

    teamGateway = await insert(Gateway, {
      name: 'Payments Skills', type: GatewayType.SKILLS, kind: GatewayKind.TOOL,
      endpoint: '/payments-skills', organizationId, status: GatewayStatus.ACTIVE,
      configuration: {}, visibility: 'team', teamId, ownerUserId: users.lead,
    });
    orgGateway = await insert(Gateway, {
      name: 'Shared Skills', type: GatewayType.SKILLS, kind: GatewayKind.TOOL,
      endpoint: '/shared-skills', organizationId, status: GatewayStatus.ACTIVE,
      configuration: {}, visibility: 'org', teamId: null, ownerUserId: users.outsider,
    });
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  const readers = ['lead', 'teammate', 'admin', 'orgOwner'] as const;
  const nonReaders = ['outsider', 'stranger'] as const;

  // ── 1. a team gateway named by id ──────────────────────────────────

  describe('a team gateway named by id', () => {
    let service: GatewaysService;
    let info: GatewayInfoController;

    beforeAll(() => {
      service = new GatewaysService(
        repo(Gateway), repo(GatewayTool), repo(GatewayAuth), repo(User), repo(Organization), repo(UsageMetric),
        { logCreate: jest.fn(), logUpdate: jest.fn(), logDelete: jest.fn(), log: jest.fn(), computeChanges: jest.fn() } as any,
        undefined as any,
        { ensureSystemGateway: jest.fn().mockResolvedValue(undefined), validateGatewayConfiguration: jest.fn() } as any,
        policy,
      );
      info = new GatewayInfoController(service, undefined as any);
    });

    const guardFor = (gatewayId: string, userId: string) => {
      const guard = new PrivateGatewayGuard(repo(Gateway), policy);
      return guard.canActivate({
        switchToHttp: () => ({ getRequest: () => ({ params: { gatewayId }, user: { id: userId } }) }),
      } as any);
    };
    // What GET /gateways/:gatewayId answers for an id that does not exist.
    const missingBody = { success: false, message: 'Gateway not found', error: 'GATEWAY_NOT_FOUND' };

    it.each(nonReaders)('the route guard answers %s exactly as for a missing gateway', async (who) => {
      const refusal = await guardFor(teamGateway.id, users[who]).catch((e) => e);
      expect(refusal).toBeInstanceOf(NotFoundException);
      expect((refusal as HttpException).getResponse()).toEqual(missingBody);
    });

    it.each(readers)('the route guard lets %s through', async (who) => {
      await expect(guardFor(teamGateway.id, users[who])).resolves.toBe(true);
    });

    it('the route guard lets any member through to an org gateway', async () => {
      await expect(guardFor(orgGateway.id, users.outsider)).resolves.toBe(true);
    });

    it('getGateway with a caller is a 404 for a member outside the team', async () => {
      await expect(service.getGateway(teamGateway.id, organizationId, true, { id: users.outsider }))
        .rejects.toThrow(new NotFoundException('Gateway not found'));
      for (const who of readers) {
        await expect(service.getGateway(teamGateway.id, organizationId, false, { id: users[who] }))
          .resolves.toMatchObject({ id: teamGateway.id });
      }
    });

    it('resolving it by endpoint or by name is a 404 for a member outside the team', async () => {
      // By endpoint.
      await expect(service.resolveGateway(orgSlug, 'payments-skills', organizationId, users.outsider))
        .rejects.toBeInstanceOf(NotFoundException);
      await expect(service.resolveGateway(orgSlug, 'payments-skills', organizationId, users.stranger))
        .rejects.toBeInstanceOf(NotFoundException);
      // Name fallback: the endpoint does not match, the slugified name does.
      await repo(Gateway).update({ id: teamGateway.id }, { endpoint: '/payments-renamed' });
      try {
        await expect(service.resolveGateway(orgSlug, 'payments-skills', organizationId, users.outsider))
          .rejects.toBeInstanceOf(NotFoundException);
        await expect(service.resolveGateway(orgSlug, 'payments-skills', organizationId, users.teammate))
          .resolves.toMatchObject({ id: teamGateway.id });
      } finally {
        await repo(Gateway).update({ id: teamGateway.id }, { endpoint: '/payments-skills' });
      }
    });

    it('GET /gateways/resolve answers the same five fields as before, and 404 outside the team', async () => {
      const req = (who: keyof typeof users) => ({ user: { id: users[who], currentOrganizationId: organizationId } });
      await expect(info.resolveGateway(orgSlug, 'payments-skills', req('teammate'))).resolves.toEqual({
        success: true,
        data: {
          id: teamGateway.id,
          name: 'Payments Skills',
          type: GatewayType.SKILLS,
          endpoint: '/payments-skills',
          organizationId,
        },
      });
      const refusal = await info.resolveGateway(orgSlug, 'payments-skills', req('outsider')).catch((e) => e);
      expect(refusal).toBeInstanceOf(HttpException);
      expect((refusal as HttpException).getStatus()).toBe(404);
      const missing = await info.resolveGateway(orgSlug, 'no-such-gateway', req('outsider')).catch((e) => e);
      expect((refusal as HttpException).getResponse()).toEqual({
        success: false,
        message: `Gateway not found: @${orgSlug}/payments-skills`,
      });
      expect((missing as HttpException).getStatus()).toBe(404);
    });

    it('the manage gate says 404, not 403, to a member outside the team', async () => {
      await expect(service.findManageable(teamGateway.id, organizationId, users.outsider))
        .rejects.toBeInstanceOf(NotFoundException);
      // A teammate may read it but not manage it: that one is a 403.
      await expect(service.findManageable(teamGateway.id, organizationId, users.teammate))
        .rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.findManageable(teamGateway.id, organizationId, users.lead))
        .resolves.toMatchObject({ id: teamGateway.id });
    });
  });

  // ── 2. publishing a tool to the hub ────────────────────────────────

  describe('publishing a tool to the hub', () => {
    let hub: ToolHubService;
    let seq = 0;

    beforeAll(() => {
      hub = new ToolHubService(
        repo(ToolTemplate), repo(Tool), repo(Api),
        { logCreate: jest.fn(), logUpdate: jest.fn(), logDelete: jest.fn(), log: jest.fn() } as any,
        policy,
      );
    });

    const httpTool = (data: Record<string, unknown>) => insert(Tool, {
      name: `http_tool_${++seq}`, type: ToolType.API, organizationId, status: ToolStatus.ACTIVE,
      executionMethod: ToolExecutionMethod.HTTP, version: '1.0.0', parameters: {},
      httpConfig: { method: 'GET', path: '/v1/charges' },
      ...data,
    });
    const publish = (who: keyof typeof users, tool: Tool) =>
      hub.publishTool(organizationId, users[who], { toolId: tool.id, category: 'finance', name: `tpl ${++seq}` } as any);

    it('a member outside the team cannot publish the team\'s tool (it does not exist for them)', async () => {
      const tool = await httpTool({ visibility: 'team', teamId, createdBy: users.lead });
      await expect(publish('outsider', tool)).rejects.toBeInstanceOf(NotFoundException);
      expect(await repo(ToolTemplate).count({ where: { organizationId } })).toBe(0);
    });

    it('a team tool does not publish at all, not even by its lead or an admin: it has to be made org-wide first', async () => {
      const tool = await httpTool({ visibility: 'team', teamId, createdBy: users.lead });
      for (const who of ['lead', 'admin', 'orgOwner'] as const) {
        await expect(publish(who, tool)).rejects.toThrow(/visible to its team only/);
      }
      // A teammate who cannot manage it is refused for that first.
      await expect(publish('teammate', tool)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('a private tool does not publish, not even by its owner', async () => {
      const tool = await httpTool({ visibility: 'private', teamId: null, createdBy: users.lead });
      await expect(publish('lead', tool)).rejects.toBeInstanceOf(BadRequestException);
      await expect(publish('admin', tool)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('an org tool publishes by its creator or an admin, not by another plain member', async () => {
      const tool = await httpTool({ visibility: 'org', teamId: null, createdBy: users.teammate });
      await expect(publish('outsider', tool)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(publish('teammate', tool)).resolves.toMatchObject({ organizationId });
      await expect(publish('admin', tool)).resolves.toMatchObject({ organizationId });
    });
  });

  // ── 3. the public root agent card ──────────────────────────────────

  describe('the public root agent card (PUBLIC_AGENT_CARD_GATEWAY_ID)', () => {
    let seq = 0;

    const agent = (orgId: string, data: Record<string, unknown> = {}) => insert(Agent, {
      name: `Card agent ${++seq}`, organizationId: orgId, status: AgentStatus.ACTIVE,
      pipeline: { nodes: [], edges: [] }, createdBy: users.admin, ...data,
    });
    const a2aGateway = (agentId: string) => insert(Gateway, {
      name: `A2A ${++seq}`, type: GatewayType.A2A, kind: GatewayKind.AGENT,
      endpoint: `/a2a-${seq}`, organizationId, status: GatewayStatus.ACTIVE,
      configuration: {}, visibility: 'org', teamId: null, agentId,
    });

    async function rootCard(gatewayId: string): Promise<{ status: number; body: any }> {
      const controller = new UnifiedEndpointController(
        repo(Organization), repo(Gateway), repo(Agent), repo(ApiKey),
        undefined as any, undefined as any, new A2AAgentCardService(),
        { get: (key: string) => (key === 'PUBLIC_AGENT_CARD_GATEWAY_ID' ? gatewayId : key === 'BASE_URL' ? 'https://almyty.test' : undefined) } as any,
        undefined as any, undefined as any,
      );
      const sent: { body?: any } = {};
      const res = { setHeader: jest.fn(), json: (body: any) => { sent.body = body; return res; } } as any;
      const req = { headers: {}, query: {}, protocol: 'https', get: () => 'almyty.test' } as any;
      try {
        await controller.handleRootAgentCard(req, res);
        return { status: 200, body: sent.body };
      } catch (e) {
        return { status: (e as HttpException).getStatus(), body: (e as HttpException).getResponse() };
      }
    }

    it('serves the gateway\'s own active agent', async () => {
      const own = await agent(organizationId, { name: 'Front desk' });
      const gw = await a2aGateway(own.id);
      const card = await rootCard(gw.id);
      expect(card.status).toBe(200);
      expect(card.body.name).toBe('Front desk');
    });

    it('never describes another organization\'s agent the gateway points at', async () => {
      const foreign = await agent(otherOrgId, { name: 'Other tenant secret agent' });
      const gw = await a2aGateway(foreign.id);
      const card = await rootCard(gw.id);
      expect(card.status).toBe(404);
      expect(JSON.stringify(card.body)).not.toContain('Other tenant secret agent');
    });

    it.each([AgentStatus.DRAFT, AgentStatus.INACTIVE, AgentStatus.ERROR])('is a 404 while the agent is %s', async (status) => {
      const idle = await agent(organizationId, { status });
      const gw = await a2aGateway(idle.id);
      expect((await rootCard(gw.id)).status).toBe(404);
    });
  });
});
