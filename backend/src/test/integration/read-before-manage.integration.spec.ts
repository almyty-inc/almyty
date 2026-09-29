import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { versionsConfig } from 'typeorm-versions';

import { Agent, AgentStatus } from '../../entities/agent.entity';
import { AgentExecution } from '../../entities/agent-execution.entity';
import { Api, ApiType } from '../../entities/api.entity';
import { ApiKey } from '../../entities/api-key.entity';
import { ApiSchema } from '../../entities/api-schema.entity';
import { Conversation } from '../../entities/conversation.entity';
import { Credential, CredentialType } from '../../entities/credential.entity';
import { Gateway, GatewayKind, GatewayStatus, GatewayType } from '../../entities/gateway.entity';
import { GatewayAuth } from '../../entities/gateway-auth.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { LlmProvider, LlmProviderStatus } from '../../entities/llm-provider.entity';
import { LlmProviderType } from '../../entities/llm-provider-type';
import { Message } from '../../entities/message.entity';
import { Model } from '../../entities/model.entity';
import { ModelVersion } from '../../entities/model-version.entity';
import { Operation } from '../../entities/operation.entity';
import { Organization } from '../../entities/organization.entity';
import { Resource } from '../../entities/resource.entity';
import { Team } from '../../entities/team.entity';
import { Tool, ToolStatus, ToolType } from '../../entities/tool.entity';
import { ToolCategory } from '../../entities/tool-category.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import { ToolVersion } from '../../entities/tool-version.entity';
import { UsageMetric } from '../../entities/usage-metric.entity';
import { User } from '../../entities/user.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { UserTeam, TeamRole } from '../../entities/user-team.entity';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { PrivateAgentGuard, PrivateApiGuard, PrivateToolGuard } from '../../common/authorization/private-resource.guard';
import { AgentsService } from '../../modules/agents/agents.service';
import { AgentValidationHelper } from '../../modules/agents/agent-validation.helper';
import { ApisService } from '../../modules/apis/apis.service';
import { CredentialsService } from '../../modules/credentials/credentials.service';
import { GatewaysService } from '../../modules/gateways/gateways.service';
import { LlmProvidersService } from '../../modules/llm-providers/llm-providers.service';
import { PrivateProviderGuard } from '../../modules/llm-providers/private-provider.guard';
import { ModelCatalogService } from '../../modules/model-catalog/model-catalog.service';
import { ToolsService } from '../../modules/tools/tools.service';
import { ToolsStatsHelper } from '../../modules/tools/tools-stats.helper';

/**
 * Read before manage, against a real Postgres (migrations, CHECK
 * constraints, the real membership join in getTeamMemberships).
 *
 * Every path that returns or changes one resource by id answers a caller
 * who cannot READ it with the same 404 a missing id gets, and only a
 * caller who can read it but not manage it with a 403. The manage paths
 * used to run the manage decision first, so a member outside a team got
 * "403 not a member of the resource's team" for a team tool, agent, API,
 * credential or provider -- confirming the id exists and saying how it is
 * scoped -- and the read paths (and the route guards in front of them)
 * applied only the private rule, so the same member could fetch the team
 * row outright.
 *
 * Cast: `lead` leads the team, `teammate` is a plain member of it,
 * `outsider` is an org member on no team, `admin` is an org admin (reads
 * every team row), `owner` holds a private provider.
 *
 * Gated on RUN_DB_INTEGRATION=1, isolated in its own schema.
 */
const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'read_before_manage_test';

jest.setTimeout(120_000);

describeIfDb('read before manage (real Postgres)', () => {
  let ds: DataSource;
  let policy: AccessPolicyService;
  let organizationId: string;
  let teamId: string;
  const users: Record<'lead' | 'teammate' | 'outsider' | 'admin' | 'owner', string> = {} as any;

  let tools: ToolsService;
  let agents: AgentsService;
  let apis: ApisService;
  let credentials: CredentialsService;
  let providers: LlmProvidersService;
  let gateways: GatewaysService;
  let catalog: ModelCatalogService;

  let tool: Tool;
  let agent: Agent;
  let api: Api;
  let credential: Credential;
  let provider: LlmProvider;
  let gateway: Gateway;
  let privateCard: Model;

  const repo = <T extends object>(entity: new () => T) => ds.getRepository(entity);
  const insert = async <T extends object>(entity: new () => T, data: Record<string, unknown>): Promise<T> =>
    (await repo(entity).save(repo(entity).create(data as any) as unknown as T)) as T;
  const audit = { log: jest.fn(), logCreate: jest.fn(), logUpdate: jest.fn(), logDelete: jest.fn(), computeChanges: jest.fn() } as any;

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

    policy = new AccessPolicyService(repo(UserOrganization), repo(UserTeam));

    const org = await insert(Organization, { name: 'Read Org', slug: 'read-org' });
    organizationId = (org as any).id;
    const roles: Array<[keyof typeof users, OrganizationRole]> = [
      ['lead', OrganizationRole.MEMBER],
      ['teammate', OrganizationRole.MEMBER],
      ['outsider', OrganizationRole.MEMBER],
      ['admin', OrganizationRole.ADMIN],
      ['owner', OrganizationRole.MEMBER],
    ];
    for (const [name, role] of roles) {
      const user = await insert(User, { email: `${name}@read.test`, passwordHash: 'x', firstName: name, lastName: 'T' });
      users[name] = (user as any).id;
      await insert(UserOrganization, { userId: users[name], organizationId, role, isActive: true, inviteAccepted: true });
    }
    teamId = (await insert(Team, { name: 'Payments', organizationId })).id as string;
    await insert(UserTeam, { userId: users.lead, teamId, role: TeamRole.LEAD, isActive: true });
    await insert(UserTeam, { userId: users.teammate, teamId, role: TeamRole.MEMBER, isActive: true });

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
      repo(Api), repo(ApiSchema), repo(Operation), repo(Resource), repo(Organization), null as any, tools, audit,
      ds, null as any, null as any, policy, null as any,
    );
    credentials = new CredentialsService(
      repo(Credential), repo(ApiKey), repo(LlmProvider), repo(Api), repo(Gateway), repo(Agent),
      audit, policy, { encryptForOrg: jest.fn(), warmOrg: jest.fn() } as any,
    );
    const none = undefined as any;
    providers = new LlmProvidersService(
      repo(LlmProvider), repo(Conversation), repo(Message), repo(User), repo(Organization), repo(Gateway), repo(Tool),
      none, audit, none, none, none, none, none, policy, { warmOrg: jest.fn() } as any, none,
    );
    gateways = new GatewaysService(
      repo(Gateway), repo(GatewayTool), repo(GatewayAuth), repo(User), repo(Organization), repo(UsageMetric),
      audit, undefined as any,
      { ensureSystemGateway: jest.fn().mockResolvedValue(undefined), validateGatewayConfiguration: jest.fn() } as any,
      policy,
    );
    catalog = new ModelCatalogService(repo(Model), repo(ModelVersion), repo(LlmProvider), none, none, none, none, none, audit);

    // One team row of each kind, made by the admin, so that neither the
    // lead nor the teammate is its creator.
    const team = { visibility: 'team', teamId };
    tool = await insert(Tool, {
      name: 'payments_refund', description: 'refund', type: ToolType.FUNCTION, parameters: {},
      organizationId, status: ToolStatus.ACTIVE, createdBy: users.admin, ...team,
    });
    agent = await insert(Agent, {
      name: 'Payments Agent', organizationId, status: AgentStatus.ACTIVE, createdBy: users.admin,
      pipeline: { nodes: [], edges: [] }, toolIds: [], ...team,
    });
    api = await insert(Api, {
      name: 'Payments API', type: ApiType.OPENAPI, baseUrl: 'https://payments.example.com', organizationId, ...team,
    });
    credential = await insert(Credential, {
      name: 'Payments key', type: CredentialType.API_KEY, organizationId, config: { apiKey: 'sk-team' }, isActive: true, ...team,
    });
    provider = await insert(LlmProvider, {
      name: 'Payments OpenAI', type: LlmProviderType.OPENAI, organizationId, configuration: { model: 'gpt-x' },
      status: LlmProviderStatus.ACTIVE, ...team,
    });
    gateway = await insert(Gateway, {
      name: 'Payments Skills', type: GatewayType.SKILLS, kind: GatewayKind.TOOL, endpoint: '/payments-skills',
      organizationId, status: GatewayStatus.ACTIVE, configuration: {}, ...team,
    });
    const ownersProvider = await insert(LlmProvider, {
      name: 'Owner private OpenAI', type: LlmProviderType.OPENAI, organizationId, configuration: { model: 'gpt-x' },
      status: LlmProviderStatus.ACTIVE, visibility: 'private', teamId: null, ownerUserId: users.owner,
    });
    privateCard = await insert(Model, {
      organizationId, name: 'Owner model', providerId: ownersProvider.id, providerType: 'openai', vendorModelId: 'gpt-x',
    });
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  const refusalOf = (p: unknown) => Promise.resolve(p).then(() => 'allowed', (e) => e);
  const expectNotFound = async (p: unknown) => expect(await refusalOf(p)).toBeInstanceOf(NotFoundException);
  const expectForbidden = async (p: unknown) => expect(await refusalOf(p)).toBeInstanceOf(ForbiddenException);

  // Each manage path, as a function of who is asking. Every call below is
  // refused before it writes, so the rows stay as seeded.
  const managePaths: Array<[string, (userId: string) => Promise<unknown>]> = [
    ['tools.updateTool', (u) => tools.updateTool(tool.id, { description: 'x' } as any, organizationId, u)],
    ['tools.activateTool', (u) => tools.activateTool(tool.id, organizationId, u)],
    ['tools.deactivateTool', (u) => tools.deactivateTool(tool.id, organizationId, u)],
    ['tools.deleteTool', (u) => tools.deleteTool(tool.id, organizationId, u)],
    ['agents.updateAgent', (u) => agents.updateAgent(agent.id, { description: 'x' } as any, organizationId, u)],
    ['agents.activateAgent', (u) => agents.activateAgent(agent.id, organizationId, u)],
    ['agents.deactivateAgent', (u) => agents.deactivateAgent(agent.id, organizationId, u)],
    ['agents.saveVersion', (u) => agents.saveVersion(agent.id, organizationId, 'x', u)],
    ['agents.rollbackToVersion', (u) => agents.rollbackToVersion(agent.id, organizationId, 0, u)],
    ['agents.deleteAgent', (u) => agents.deleteAgent(agent.id, organizationId, u)],
    ['apis.update', (u) => apis.update(api.id, { description: 'x' } as any, organizationId, u)],
    ['apis.remove', (u) => apis.remove(api.id, organizationId, u)],
    ['credentials.update', (u) => credentials.update(credential.id, { description: 'x' }, organizationId, u)],
    ['credentials.delete', (u) => credentials.delete(credential.id, organizationId, u)],
    ['providers.updateProvider', (u) => providers.updateProvider(provider.id, { description: 'x' } as any, organizationId, u)],
    ['providers.deleteProvider', (u) => providers.deleteProvider(provider.id, organizationId, u)],
    ['gateways.updateGateway', (u) => gateways.updateGateway(gateway.id, { description: 'x' } as any, organizationId, u)],
    ['gateways.activateGateway', (u) => gateways.activateGateway(gateway.id, organizationId, u)],
    ['gateways.deactivateGateway', (u) => gateways.deactivateGateway(gateway.id, organizationId, u)],
    ['gateways.deleteGateway', (u) => gateways.deleteGateway(gateway.id, organizationId, u)],
  ];

  const guardContext = (userId: string, params: Record<string, string>) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ user: { id: userId }, params }) }) }) as any;
  const providerGuard = () => new PrivateProviderGuard(repo(LlmProvider), repo(Conversation), policy);

  describe('a member outside the team', () => {
    it.each(managePaths)('%s is the 404 a missing id gets', async (_name, run) => {
      await expectNotFound(run(users.outsider));
    });

    it('cannot fetch any of the team rows by id', async () => {
      await expectNotFound(tools.getTool(tool.id, organizationId, false, { id: users.outsider }));
      await expectNotFound(agents.getAgent(agent.id, organizationId, { id: users.outsider }));
      await expectNotFound(agents.getReadiness(agent.id, organizationId, users.outsider));
      await expectNotFound(apis.findOne(api.id, organizationId, { id: users.outsider }));
      await expectNotFound(credentials.findById(credential.id, organizationId, { id: users.outsider }));
      await expectNotFound(credentials.getUsage(credential.id, organizationId, { id: users.outsider }));
    });

    it('is refused by every route guard that names a team row', async () => {
      await expectNotFound(new PrivateToolGuard(ds).canActivate(guardContext(users.outsider, { toolId: tool.id })));
      await expectNotFound(new PrivateToolGuard(ds).canActivate(guardContext(users.outsider, { apiId: api.id })));
      await expectNotFound(new PrivateAgentGuard(ds).canActivate(guardContext(users.outsider, { id: agent.id })));
      await expectNotFound(new PrivateApiGuard(ds).canActivate(guardContext(users.outsider, { id: api.id })));
      await expectNotFound(providerGuard().canActivate(guardContext(users.outsider, { providerId: provider.id })));
    });
  });

  describe('a plain member of the team', () => {
    it.each(managePaths)('%s is a 403: they can read it, not manage it', async (_name, run) => {
      await expectForbidden(run(users.teammate));
    });

    it('can fetch every team row by id', async () => {
      await expect(tools.getTool(tool.id, organizationId, false, { id: users.teammate })).resolves.toMatchObject({ id: tool.id });
      await expect(agents.getAgent(agent.id, organizationId, { id: users.teammate })).resolves.toMatchObject({ id: agent.id });
      await expect(apis.findOne(api.id, organizationId, { id: users.teammate })).resolves.toMatchObject({ id: api.id });
      await expect(credentials.findById(credential.id, organizationId, { id: users.teammate })).resolves.toMatchObject({ id: credential.id });
    });
  });

  it('the route guards let the team and an org admin through', async () => {
    for (const who of ['lead', 'teammate', 'admin'] as const) {
      await expect(new PrivateToolGuard(ds).canActivate(guardContext(users[who], { toolId: tool.id }))).resolves.toBe(true);
      await expect(new PrivateAgentGuard(ds).canActivate(guardContext(users[who], { id: agent.id }))).resolves.toBe(true);
      await expect(new PrivateApiGuard(ds).canActivate(guardContext(users[who], { id: api.id }))).resolves.toBe(true);
      await expect(providerGuard().canActivate(guardContext(users[who], { providerId: provider.id }))).resolves.toBe(true);
    }
  });

  it('the team lead manages the team rows', async () => {
    await expect(tools.updateTool(tool.id, { description: 'lead edit' } as any, organizationId, users.lead))
      .resolves.toMatchObject({ description: 'lead edit' });
    await expect(agents.updateAgent(agent.id, { description: 'lead edit' } as any, organizationId, users.lead))
      .resolves.toMatchObject({ description: 'lead edit' });
    await expect(credentials.update(credential.id, { description: 'lead edit' }, organizationId, users.lead))
      .resolves.toMatchObject({ description: 'lead edit' });
  });

  describe('a model card served by another member\'s private provider', () => {
    it('is the 404 a missing card gets to an org admin updating, removing or validating it', async () => {
      await expectNotFound(catalog.update(organizationId, privateCard.id, { name: 'hijack' } as any, users.admin));
      await expectNotFound(catalog.remove(organizationId, privateCard.id, users.admin));
      await expectNotFound(catalog.validate(organizationId, privateCard.id, users.admin));
      await expect(repo(Model).findOneByOrFail({ id: privateCard.id })).resolves.toMatchObject({ name: 'Owner model' });
    });

    it('cannot be registered on that provider by an org admin', async () => {
      const refusal = await refusalOf(
        catalog.register(organizationId, { name: 'x', providerId: privateCard.providerId!, vendorModelId: 'gpt-y' } as any, users.admin),
      );
      expect(refusal).toBeInstanceOf(NotFoundException);
      expect((refusal as NotFoundException).message).toBe('Provider not found');
    });
  });
});
