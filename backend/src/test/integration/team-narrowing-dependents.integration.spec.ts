import { ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { versionsConfig } from 'typeorm-versions';

import { Agent } from '../../entities/agent.entity';
import { AgentExecution } from '../../entities/agent-execution.entity';
import { Api, ApiType } from '../../entities/api.entity';
import { ApiSchema } from '../../entities/api-schema.entity';
import { Gateway, GatewayKind, GatewayStatus, GatewayType } from '../../entities/gateway.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { Operation } from '../../entities/operation.entity';
import { Organization } from '../../entities/organization.entity';
import { Resource } from '../../entities/resource.entity';
import { Team } from '../../entities/team.entity';
import { Tool, ToolStatus, ToolType } from '../../entities/tool.entity';
import { ToolCategory } from '../../entities/tool-category.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import { ToolVersion } from '../../entities/tool-version.entity';
import { User } from '../../entities/user.entity';
import { OrganizationRole, UserOrganization } from '../../entities/user-organization.entity';
import { TeamRole, UserTeam } from '../../entities/user-team.entity';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { AgentValidationHelper } from '../../modules/agents/agent-validation.helper';
import { AgentsService } from '../../modules/agents/agents.service';
import { ApisService } from '../../modules/apis/apis.service';
import { ToolsService } from '../../modules/tools/tools.service';
import { ToolsStatsHelper } from '../../modules/tools/tools-stats.helper';

/**
 * Narrowing an API to a team takes its generated tools with it. Agents
 * and gateways outside that team that use those tools would then fail at
 * run time, so the narrowing is refused and names them -- the answer
 * making the API private already gets. It goes through when every user of
 * the tools is inside the new scope. A tool or an agent narrowed to a team
 * on its own gets the same check.
 *
 * Real Postgres (migrations, scope CHECK constraints). Gated on
 * RUN_DB_INTEGRATION=1, isolated in its own schema.
 */
const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'team_narrowing_dependents_test';

jest.setTimeout(120_000);

type Scope = { visibility: 'org' | 'team' | 'private'; teamId?: string | null };

describeIfDb('narrowing to a team refuses users outside it (real Postgres)', () => {
  let ds: DataSource;
  let policy: AccessPolicyService;
  let apis: ApisService;
  let tools: ToolsService;
  let agents: AgentsService;
  let orgId: string;
  let payments: string;
  let growth: string;
  let ops: string;
  const users: Record<'admin' | 'member', string> = {} as any;
  let seq = 0;

  const repo = <T extends object>(entity: new () => T) => ds.getRepository(entity);
  const insert = async <T extends object>(entity: new () => T, data: Record<string, unknown>): Promise<T> =>
    (await repo(entity).save(repo(entity).create(data as any) as unknown as T)) as T;

  /** The (visibility, teamId) a row has in the database now. */
  const scopeNow = async (entity: new () => any, id: string) => {
    const row = await repo(entity).findOneByOrFail({ id });
    return { visibility: row.visibility, teamId: row.teamId ?? null };
  };

  /** An API with two generated tools, both in the API's scope. */
  async function apiWithTools(scope: Scope) {
    seq += 1;
    const api = await insert(Api, {
      name: `petstore${seq}`, type: ApiType.OPENAPI, baseUrl: 'https://pets.example.test', organizationId: orgId,
      ownerUserId: users.admin, visibility: scope.visibility, teamId: scope.teamId ?? null,
    });
    const made: Tool[] = [];
    for (const i of [0, 1]) {
      const op = await insert(Operation, {
        name: `op${i}`, operationId: `op${i}`, apiId: api.id, method: 'GET', endpoint: `/pets/${i}`, isActive: true,
      });
      made.push(await insert(Tool, {
        name: `petstore${seq}_op${i}`, organizationId: orgId, type: ToolType.API, status: ToolStatus.ACTIVE, parameters: {},
        apiId: api.id, operationId: (op as any).id, generated: true, visibility: scope.visibility, teamId: scope.teamId ?? null,
      }));
    }
    return { api, tools: made };
  }

  const agent = (name: string, scope: Scope, extra: Record<string, unknown> = {}) =>
    insert(Agent, {
      name, organizationId: orgId, visibility: scope.visibility, teamId: scope.teamId ?? null, createdBy: users.admin,
      pipeline: { nodes: [], edges: [] }, toolIds: [], ...extra,
    });

  const toolCallPipeline = (toolId: string) => ({
    nodes: [
      { id: 'in', type: 'input', position: { x: 0, y: 0 }, data: {} },
      { id: 'call', type: 'tool_call', position: { x: 0, y: 0 }, data: { toolId } },
      { id: 'out', type: 'output', position: { x: 0, y: 0 }, data: {} },
    ],
    edges: [],
  });

  async function gatewayServing(name: string, scope: Scope, toolId: string) {
    seq += 1;
    const gw = await insert(Gateway, {
      name, type: GatewayType.MCP, kind: GatewayKind.TOOL, endpoint: `/narrow-${seq}`, organizationId: orgId,
      status: GatewayStatus.ACTIVE, configuration: {}, isSystem: false, visibility: scope.visibility, teamId: scope.teamId ?? null,
      ownerUserId: users.admin,
    });
    await insert(GatewayTool, { gatewayId: gw.id, toolId, isActive: true });
    return gw;
  }

  async function refusal(p: Promise<unknown>): Promise<ConflictException> {
    const err = await p.then(() => null, (e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    return err as ConflictException;
  }

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

    ds = new DataSource(versionsConfig({
      ...connection,
      schema: SCHEMA,
      entities: [__dirname + '/../../entities/*.entity{.ts,.js}'],
      extra: { options: `-c search_path=${SCHEMA},public` },
      migrations: [__dirname + '/../../migrations/*{.ts,.js}'],
      migrationsRun: true,
      dropSchema: true,
    }) as any);
    await ds.initialize();
    await ds.query(`SET search_path TO ${SCHEMA}, public`);

    orgId = (await insert(Organization, { name: 'Narrow Org', slug: 'narrow-org' }) as any).id;
    const roles: Array<[keyof typeof users, OrganizationRole]> = [
      ['admin', OrganizationRole.ADMIN],
      ['member', OrganizationRole.MEMBER],
    ];
    for (const [name, role] of roles) {
      const user = await insert(User, { email: `${name}@narrow.test`, passwordHash: 'x', firstName: name, lastName: 'N' });
      users[name] = (user as any).id;
      await insert(UserOrganization, { userId: users[name], organizationId: orgId, role, isActive: true, inviteAccepted: true });
    }
    payments = (await insert(Team, { name: 'Payments', organizationId: orgId }) as any).id;
    growth = (await insert(Team, { name: 'Growth', organizationId: orgId }) as any).id;
    ops = (await insert(Team, { name: 'Ops', organizationId: orgId }) as any).id;
    await insert(UserTeam, { userId: users.member, teamId: payments, role: TeamRole.LEAD, isActive: true });
    await insert(UserTeam, { userId: users.member, teamId: ops, role: TeamRole.MEMBER, isActive: true });

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
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  describe('an API narrowed to a team', () => {
    it('org -> team: refused, naming the org-wide agent and gateway that use its tools; nothing moves', async () => {
      const { api, tools: [a, b] } = await apiWithTools({ visibility: 'org' });
      await agent('Support agent', { visibility: 'org' }, { pipeline: toolCallPipeline(a.id) });
      await gatewayServing('Petstore tools', { visibility: 'org' }, b.id);

      const err = await refusal(apis.update(api.id, { visibility: 'team', teamId: payments } as any, orgId, users.admin));
      expect(err.message).toBe(
        'Narrowing this API to team "Payments" would take its tools away from agent "Support agent" (org-wide) ' +
          'and gateway "Petstore tools" (org-wide). Narrow them to that team first, or remove the tools from them.',
      );

      expect(await scopeNow(Api, api.id)).toEqual({ visibility: 'org', teamId: null });
      expect(await scopeNow(Tool, a.id)).toEqual({ visibility: 'org', teamId: null });
      expect(await scopeNow(Tool, b.id)).toEqual({ visibility: 'org', teamId: null });
    });

    it('counts the tools of an llm_call step and of an autonomous agent', async () => {
      const first = await apiWithTools({ visibility: 'org' });
      await agent('Router', { visibility: 'org' }, {
        pipeline: {
          nodes: [{ id: 'llm', type: 'llm_call', position: { x: 0, y: 0 }, data: { prompt: 'x', toolIds: [first.tools[1].id] } }],
          edges: [],
        },
      });
      const err = await refusal(apis.update(first.api.id, { visibility: 'team', teamId: payments } as any, orgId, users.admin));
      expect(err.message).toContain('agent "Router" (org-wide)');

      const second = await apiWithTools({ visibility: 'org' });
      await agent('Autonomous helper', { visibility: 'org' }, { mode: 'autonomous', toolIds: [second.tools[0].id] });
      const err2 = await refusal(apis.update(second.api.id, { visibility: 'team', teamId: payments } as any, orgId, users.admin));
      expect(err2.message).toContain('agent "Autonomous helper" (org-wide)');
    });

    it('team A -> team B: refused while team A uses the tools', async () => {
      const { api, tools: [a] } = await apiWithTools({ visibility: 'team', teamId: growth });
      await agent('Growth bot', { visibility: 'team', teamId: growth }, { toolIds: [a.id] });

      const err = await refusal(apis.update(api.id, { visibility: 'team', teamId: payments } as any, orgId, users.admin));
      expect(err.message).toContain('agent "Growth bot" (another team)');
      expect(await scopeNow(Tool, a.id)).toEqual({ visibility: 'team', teamId: growth });
    });

    it('a user the caller cannot see is counted, not named', async () => {
      // A lead of Payments (also on Ops) moves a Payments API to Ops;
      // Growth's agent that uses it is not theirs to see.
      const { api, tools: [a] } = await apiWithTools({ visibility: 'team', teamId: payments });
      await agent('Growth secret', { visibility: 'team', teamId: growth }, { toolIds: [a.id] });

      const err = await refusal(apis.update(api.id, { visibility: 'team', teamId: ops } as any, orgId, users.member));
      expect(err.message).toContain('1 more you cannot see');
      expect(err.message).not.toContain('Growth secret');
    });

    it('goes through when every user of the tools is in the new team, and the tools move with it', async () => {
      const { api, tools: [a, b] } = await apiWithTools({ visibility: 'org' });
      await agent('Payments bot', { visibility: 'team', teamId: payments }, { pipeline: toolCallPipeline(a.id) });
      await gatewayServing('Payments tools', { visibility: 'team', teamId: payments }, b.id);
      // Another member's private agent is not the caller's to count or name.
      await agent('Someone private', { visibility: 'private' }, { createdBy: users.member, toolIds: [a.id] });

      await apis.update(api.id, { visibility: 'team', teamId: payments } as any, orgId, users.admin);
      expect(await scopeNow(Api, api.id)).toEqual({ visibility: 'team', teamId: payments });
      expect(await scopeNow(Tool, a.id)).toEqual({ visibility: 'team', teamId: payments });
      expect(await scopeNow(Tool, b.id)).toEqual({ visibility: 'team', teamId: payments });
    });

    it('re-saving the same team is not a narrowing, whoever uses the tools', async () => {
      const { api, tools: [a] } = await apiWithTools({ visibility: 'team', teamId: payments });
      await agent('Stale org agent', { visibility: 'org' }, { toolIds: [a.id] });
      const saved = await apis.update(api.id, { name: `renamed${seq}`, visibility: 'team', teamId: payments } as any, orgId, users.admin);
      expect(saved.name).toBe(`renamed${seq}`);
    });

    it('widening is never refused', async () => {
      const { api, tools: [a] } = await apiWithTools({ visibility: 'team', teamId: payments });
      await agent('Org user', { visibility: 'org' }, { toolIds: [a.id] });
      await apis.update(api.id, { visibility: 'org' } as any, orgId, users.admin);
      expect(await scopeNow(Tool, a.id)).toEqual({ visibility: 'org', teamId: null });
    });
  });

  describe('a tool or an agent narrowed to a team on its own', () => {
    it('a tool: refused while an org-wide gateway serves it, allowed once only its team does', async () => {
      seq += 1;
      const tool = await insert(Tool, {
        name: `standalone${seq}`, organizationId: orgId, type: ToolType.FUNCTION, status: ToolStatus.ACTIVE, parameters: {},
        visibility: 'org', teamId: null, createdBy: users.admin, version: '1.0.0',
      });
      const gw = await gatewayServing('Everyone tools', { visibility: 'org' }, tool.id);
      const err = await refusal(tools.updateTool(tool.id, { visibility: 'team', teamId: payments } as any, orgId, users.admin));
      expect(err.message).toBe(
        'Narrowing this tool to team "Payments" would take it away from gateway "Everyone tools" (org-wide). ' +
          'Narrow it to that team first, or remove the tool from it.',
      );

      await repo(Gateway).update({ id: gw.id }, { visibility: 'team', teamId: payments } as any);
      await tools.updateTool(tool.id, { visibility: 'team', teamId: payments } as any, orgId, users.admin);
      expect(await scopeNow(Tool, tool.id)).toEqual({ visibility: 'team', teamId: payments });
    });

    it('an agent: refused while an org-wide agent calls it, allowed once the caller is in the team', async () => {
      const child = await agent('Child', { visibility: 'org' });
      const parent = await agent('Parent', { visibility: 'org' }, {
        pipeline: { nodes: [{ id: 's', type: 'sub_agent', position: { x: 0, y: 0 }, data: { agentId: child.id } }], edges: [] },
      });
      const err = await refusal(agents.updateAgent(child.id, { visibility: 'team', teamId: payments } as any, orgId, users.admin));
      expect(err.message).toContain('agent "Parent" (org-wide)');

      await repo(Agent).update({ id: parent.id }, { visibility: 'team', teamId: payments } as any);
      await agents.updateAgent(child.id, { visibility: 'team', teamId: payments } as any, orgId, users.admin);
      expect(await scopeNow(Agent, child.id)).toEqual({ visibility: 'team', teamId: payments });
    });
  });
});
