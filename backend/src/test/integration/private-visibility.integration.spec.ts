import * as crypto from 'crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';

import { Organization } from '../../entities/organization.entity';
import { User } from '../../entities/user.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { UserTeam } from '../../entities/user-team.entity';
import { Gateway, GatewayKind, GatewayStatus, GatewayType } from '../../entities/gateway.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { GatewayAuth, GatewayAuthType } from '../../entities/gateway-auth.entity';
import { ApiKey } from '../../entities/api-key.entity';
import { OAuthAccessToken } from '../../entities/oauth-access-token.entity';
import { UsageMetric, MetricType, MetricStatus } from '../../entities/usage-metric.entity';
import { LlmProvider, LlmProviderStatus } from '../../entities/llm-provider.entity';
import { LlmProviderType } from '../../entities/llm-provider-type';
import { Credential, CredentialType } from '../../entities/credential.entity';
import { RequestLog } from '../../entities/request-log.entity';
import { Conversation } from '../../entities/conversation.entity';
import { Message } from '../../entities/message.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import { AuditLog } from '../../entities/audit-log.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { Api } from '../../entities/api.entity';
import { Agent } from '../../entities/agent.entity';
import { Model } from '../../entities/model.entity';
import { ModelDeployment } from '../../entities/model-deployment.entity';

import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { GatewaysService } from '../../modules/gateways/gateways.service';
import { GatewaysStatsHelper } from '../../modules/gateways/gateways-stats.helper';
import { GatewayAuthService } from '../../modules/gateways/gateway-auth.service';
import { GatewayAuthValidators } from '../../modules/gateways/gateway-auth-validators.helper';
import { PrivateGatewayGuard } from '../../modules/gateways/private-gateway.guard';
import { UnifiedEndpointController } from '../../modules/gateways/unified-endpoint.controller';
import { GatewayResolverService } from '../../modules/mcp/services/gateway-resolver.service';
import { McpOAuthResolveHelper } from '../../modules/mcp/controllers/mcp-oauth-resolve.helper';
import { McpOAuthDiscoveryController } from '../../modules/mcp/controllers/mcp-oauth-discovery.controller';
import { McpContentHandler } from '../../modules/mcp/services/mcp-content.handler';
import { LlmProvidersService } from '../../modules/llm-providers/llm-providers.service';
import { PrivateProviderGuard } from '../../modules/llm-providers/private-provider.guard';
import { ModelRouterService } from '../../modules/model-catalog/routing/model-router.service';
import { CredentialsService } from '../../modules/credentials/credentials.service';
import { CredentialRefResolver } from '../../modules/credentials/credential-ref.resolver';
import { LlmProviderSecretsHelper } from '../../modules/llm-providers/llm-provider-secrets.helper';
import { AnalyticsService } from '../../modules/monitoring/analytics.service';
import { AnalyticsExportHelper } from '../../modules/monitoring/analytics-export.helper';

/**
 * The "Private (just me)" tier on gateways, LLM providers and credentials,
 * against a real Postgres: every list, fetch, count, analytics breakdown
 * and serving surface must hand the owner's private row to the owner and
 * to nobody else -- not another member, and not an org admin or owner.
 *
 * Built by running the migrations (not synchronize), so the CHECK
 * constraints from 1750808000000-PrivateVisibility are the real ones.
 * Gated on RUN_DB_INTEGRATION=1 and isolated in its own schema.
 */
const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'private_visibility_gpc_test';

jest.setTimeout(120_000);

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

describeIfDb('Private visibility: gateways, LLM providers, credentials (real Postgres)', () => {
  let ds: DataSource;
  let policy: AccessPolicyService;

  let organizationId: string;
  let orgSlug: string;
  // owner: a plain member who owns the private rows. peer: another member.
  // admin / orgOwner: the roles that bypass everything else.
  const users: Record<'owner' | 'peer' | 'admin' | 'orgOwner', string> = {} as any;
  const keys: Record<'owner' | 'peer' | 'admin', string> = {} as any;

  let privateGateway: Gateway;
  let orgGateway: Gateway;
  let privateProvider: LlmProvider;
  let orgProvider: LlmProvider;
  let privateCredential: Credential;
  let orgCredential: Credential;

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

    const org = await repo(Organization).save(repo(Organization).create({ name: 'Private Org', slug: 'private-org' } as any));
    organizationId = (org as any).id;
    orgSlug = (org as any).slug;

    const roles: Array<[keyof typeof users, OrganizationRole]> = [
      ['owner', OrganizationRole.MEMBER],
      ['peer', OrganizationRole.MEMBER],
      ['admin', OrganizationRole.ADMIN],
      ['orgOwner', OrganizationRole.OWNER],
    ];
    for (const [name, role] of roles) {
      const user = await repo(User).save(repo(User).create({
        email: `${name}@private.test`, passwordHash: 'x', firstName: name, lastName: 'T',
      } as any));
      users[name] = (user as any).id;
      await repo(UserOrganization).save(repo(UserOrganization).create({
        userId: users[name], organizationId, role, isActive: true, inviteAccepted: true,
      } as any));
    }

    // Org-wide API keys (no gatewayId) for three of them: the credential a
    // gateway's API_KEY auth accepts.
    for (const name of ['owner', 'peer', 'admin'] as const) {
      const raw = `almyty_sk_${name}_${crypto.randomBytes(12).toString('hex')}`;
      keys[name] = raw;
      await repo(ApiKey).save(repo(ApiKey).create({
        name: `${name} key`, keyHash: sha256(raw), keyPrefix: raw.slice(0, 18),
        userId: users[name], organizationId, gatewayId: null, isActive: true, scopes: [],
      } as any));
    }

    privateGateway = await insert(Gateway, {
      name: 'Owner private MCP', type: GatewayType.MCP, kind: GatewayKind.TOOL,
      endpoint: '/owner-private', organizationId, status: GatewayStatus.ACTIVE,
      configuration: {}, visibility: 'private', teamId: null, ownerUserId: users.owner,
    });
    orgGateway = await insert(Gateway, {
      name: 'Shared MCP', type: GatewayType.MCP, kind: GatewayKind.TOOL,
      endpoint: '/shared', organizationId, status: GatewayStatus.ACTIVE,
      configuration: {}, visibility: 'org', teamId: null, ownerUserId: users.peer,
    });
    for (const gw of [privateGateway, orgGateway]) {
      await repo(GatewayAuth).save(repo(GatewayAuth).create({
        gatewayId: gw.id, type: GatewayAuthType.API_KEY, isRequired: true, isActive: true,
        configuration: { keyHeader: 'x-api-key' },
      } as any));
    }

    privateProvider = await insert(LlmProvider, {
      name: 'Owner private OpenAI', type: LlmProviderType.OPENAI, organizationId,
      configuration: { model: 'gpt-x' }, status: LlmProviderStatus.ACTIVE,
      visibility: 'private', teamId: null, ownerUserId: users.owner,
    });
    orgProvider = await insert(LlmProvider, {
      name: 'Shared OpenAI', type: LlmProviderType.OPENAI, organizationId,
      configuration: { model: 'gpt-x' }, status: LlmProviderStatus.ACTIVE,
      visibility: 'org', teamId: null, ownerUserId: users.peer,
    });

    privateCredential = await insert(Credential, {
      name: 'Owner private key', type: CredentialType.API_KEY, organizationId,
      config: { apiKey: 'sk-private' }, visibility: 'private', teamId: null,
      ownerUserId: users.owner, isActive: true,
    });
    orgCredential = await insert(Credential, {
      name: 'Shared key', type: CredentialType.API_KEY, organizationId,
      config: { apiKey: 'sk-shared' }, visibility: 'org', teamId: null, isActive: true,
    });
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  const others = ['peer', 'admin', 'orgOwner'] as const;

  // ── Schema ─────────────────────────────────────────────────────────

  it('the CHECK constraint refuses a private gateway, provider or credential with no owner', async () => {
    await expect(ds.query(
      `INSERT INTO gateways (name, type, kind, endpoint, "organizationId", status, configuration, visibility)
       VALUES ('x', 'mcp', 'tool', '/no-owner', $1, 'active', '{}', 'private')`,
      [organizationId],
    )).rejects.toThrow(/gateways_visibility_team_chk/);
    await expect(ds.query(
      `INSERT INTO llm_providers (name, type, "organizationId", configuration, visibility)
       VALUES ('x', 'openai', $1, '{}', 'private')`,
      [organizationId],
    )).rejects.toThrow(/llm_providers_visibility_team_chk/);
    await expect(ds.query(
      `INSERT INTO credentials (name, type, "organizationId", config, visibility)
       VALUES ('x', 'api_key', $1, '{}', 'private')`,
      [organizationId],
    )).rejects.toThrow(/credentials_visibility_team_chk/);
  });

  // ── Gateways: dashboard reads ──────────────────────────────────────

  describe('gateways', () => {
    let service: GatewaysService;
    let stats: GatewaysStatsHelper;

    beforeAll(() => {
      service = new GatewaysService(
        repo(Gateway), repo(GatewayTool), repo(GatewayAuth), repo(User), repo(Organization), repo(UsageMetric),
        { logCreate: jest.fn(), logUpdate: jest.fn(), logDelete: jest.fn(), log: jest.fn(), computeChanges: jest.fn() } as any,
        undefined as any,
        { ensureSystemGateway: jest.fn().mockResolvedValue(undefined), validateGatewayConfiguration: jest.fn() } as any,
        policy,
      );
      stats = new GatewaysStatsHelper(repo(Gateway), repo(Organization), repo(UsageMetric), service, policy);
      (service as any).statsHelper = stats;
    });

    const listIds = async (who: keyof typeof users) =>
      (await service.getGateways({ organizationId, caller: { id: users[who] }, limit: 100 })).gateways.map((g) => g.id);

    it('lists the private gateway to its owner, and counts it', async () => {
      const result = await service.getGateways({ organizationId, caller: { id: users.owner }, limit: 100 });
      expect(result.gateways.map((g) => g.id)).toEqual(expect.arrayContaining([privateGateway.id, orgGateway.id]));
      expect(result.total).toBe(2);
    });

    it.each(others)('does not list or count it for %s', async (who) => {
      const result = await service.getGateways({ organizationId, caller: { id: users[who] }, limit: 100 });
      expect(result.gateways.map((g) => g.id)).toEqual([orgGateway.id]);
      expect(result.total).toBe(1);
      expect(await listIds(who)).not.toContain(privateGateway.id);
    });

    it.each(others)('fetch by id is a 404 for %s, the owner gets it', async (who) => {
      await expect(service.getGateway(privateGateway.id, organizationId, false, { id: users[who] }))
        .rejects.toBeInstanceOf(NotFoundException);
      await expect(service.getGateway(privateGateway.id, organizationId, false, { id: users.owner }))
        .resolves.toMatchObject({ id: privateGateway.id });
    });

    it.each(others)('resolving the slug is a 404 for %s', async (who) => {
      await expect(service.resolveGateway(orgSlug, 'owner-private', organizationId, users[who]))
        .rejects.toBeInstanceOf(NotFoundException);
      await expect(service.resolveGateway(orgSlug, 'owner-private', organizationId, users.owner))
        .resolves.toMatchObject({ id: privateGateway.id });
    });

    it.each(others)('the dashboard route guard answers 404 for %s', async (who) => {
      const guard = new PrivateGatewayGuard(repo(Gateway), policy);
      const ctx = (userId: string) => ({
        switchToHttp: () => ({ getRequest: () => ({ params: { gatewayId: privateGateway.id }, user: { id: userId } }) }),
      }) as any;
      await expect(guard.canActivate(ctx(users[who]))).rejects.toBeInstanceOf(NotFoundException);
      await expect(guard.canActivate(ctx(users.owner))).resolves.toBe(true);
    });

    it.each(others)('%s cannot update, deactivate or delete it (404, not 403)', async (who) => {
      await expect(service.updateGateway(privateGateway.id, { name: 'hijack' }, organizationId, users[who]))
        .rejects.toBeInstanceOf(NotFoundException);
      await expect(service.deactivateGateway(privateGateway.id, organizationId, users[who]))
        .rejects.toBeInstanceOf(NotFoundException);
      await expect(service.deleteGateway(privateGateway.id, organizationId, users[who]))
        .rejects.toBeInstanceOf(NotFoundException);
    });

    it('overview stats and all-skills count only what the caller may see', async () => {
      const mine = await stats.getOrganizationGatewayStats(organizationId, users.owner);
      expect(mine.totalGateways).toBe(2);
      for (const who of others) {
        const theirs = await stats.getOrganizationGatewayStats(organizationId, users[who]);
        expect(theirs.totalGateways).toBe(1);
        expect(theirs.topGateways.map((t) => t.gateway.id)).not.toContain(privateGateway.id);
        expect((await stats.getAllUserGateways(organizationId, users[who])).map((g) => g.id)).not.toContain(privateGateway.id);
      }
      expect((await stats.getAllUserGateways(organizationId, users.owner)).map((g) => g.id)).toContain(privateGateway.id);
    });

    it('refuses a private chat channel gateway at write time', async () => {
      await repo(Organization).update({ id: organizationId }, { maxGateways: 100 } as any).catch(() => undefined);
      const create = service.createGateway(
        { name: 'Slack', type: GatewayType.SLACK, endpoint: '/slack-private', configuration: {}, visibility: 'private', agentId: 'x' } as any,
        organizationId,
        users.orgOwner,
      );
      await expect(create).rejects.toThrow(/can be private/);
    });
  });

  // ── Gateways: serving (MCP / A2A / UTCP / Skills share this path) ───

  describe('gateway serving', () => {
    let resolver: GatewayResolverService;
    let unified: UnifiedEndpointController;
    let delegation: { handleGatewayRequest: jest.Mock };

    beforeAll(() => {
      const validators = new GatewayAuthValidators(repo(Gateway), repo(User), repo(ApiKey), repo(OAuthAccessToken), new JwtService({}));
      const auth = new GatewayAuthService(repo(GatewayAuth), repo(Gateway), repo(ApiKey), validators);
      resolver = new GatewayResolverService(repo(Gateway), repo(Organization), auth);
      delegation = { handleGatewayRequest: jest.fn().mockResolvedValue('served') };
      unified = new UnifiedEndpointController(
        repo(Organization), repo(Gateway), repo(Agent), repo(ApiKey), resolver,
        {} as any, {} as any, { get: () => undefined } as any, { handleAgentRequest: jest.fn() } as any, delegation as any,
      );
    });

    const req = (apiKey?: string, path = `/${'private-org'}/owner-private`) => ({
      headers: apiKey ? { 'x-api-key': apiKey } : {},
      query: {},
      body: {},
      path,
      method: 'POST',
      ip: '127.0.0.1',
    });

    it('serves the private gateway to its owner', async () => {
      const resolved = await resolver.resolveAndAuthenticate(orgSlug, '/owner-private', req(keys.owner));
      expect(resolved.gateway.id).toBe(privateGateway.id);
      expect(resolved.auth.userId).toBe(users.owner);
    });

    it.each([
      ['anonymous', undefined],
      ['another member', 'peer'],
      ['an org admin', 'admin'],
    ] as const)('answers %s exactly like a gateway that does not exist', async (_label, who) => {
      const key = who ? keys[who] : undefined;
      const missing = await resolver.resolveAndAuthenticate(orgSlug, '/no-such-gateway', req(key)).catch((e) => e);
      const hidden = await resolver.resolveAndAuthenticate(orgSlug, '/owner-private', req(key)).catch((e) => e);
      expect(hidden.getStatus()).toBe(404);
      expect(hidden.getStatus()).toBe(missing.getStatus());
      // No WWW-Authenticate challenge that would confirm the gateway exists.
      expect((hidden as any).wwwAuthenticate).toBeUndefined();
    });

    it('a non-private gateway still authenticates everyone with a valid key', async () => {
      await expect(resolver.resolveAndAuthenticate(orgSlug, '/shared', req(keys.peer))).resolves.toMatchObject({
        gateway: { id: orgGateway.id },
      });
    });

    it('the unified endpoint (/:org/:gateway) hands the private gateway to its owner only', async () => {
      const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      delegation.handleGatewayRequest.mockClear();
      await unified.handleRequest('private-org', 'owner-private', req(keys.owner) as any, res, {});
      expect(delegation.handleGatewayRequest).toHaveBeenCalledTimes(1);

      for (const key of [undefined, keys.peer, keys.admin]) {
        delegation.handleGatewayRequest.mockClear();
        const hidden = await unified.handleRequest('private-org', 'owner-private', req(key) as any, res, {}).catch((e) => e);
        const missing = await unified.handleRequest('private-org', 'nothing-here', req(key) as any, res, {}).catch((e) => e);
        expect(delegation.handleGatewayRequest).not.toHaveBeenCalled();
        expect(hidden.getStatus()).toBe(404);
        expect(hidden.getResponse()).toEqual(
          (missing.getResponse() as string).replace('nothing-here', 'owner-private'),
        );
      }
    });

    it('MCP OAuth discovery, registration and consent treat it as absent; the owner can authorize', async () => {
      const helper = new McpOAuthResolveHelper(repo(Gateway), repo(Organization), { get: () => undefined } as any);
      for (const viewer of [null, users.peer, users.admin, users.orgOwner]) {
        await expect(helper.resolveOrgAndGateway(orgSlug, 'owner-private', viewer)).rejects.toMatchObject({ status: 404 });
      }
      await expect(helper.resolveOrgAndGateway(orgSlug, 'owner-private', users.owner)).resolves.toMatchObject({
        gateway: { id: privateGateway.id },
      });
      const discovery = new McpOAuthDiscoveryController(repo(Gateway), repo(Organization), { get: () => 'http://api' } as any);
      await expect(discovery.protectedResourceMetadata(orgSlug, 'owner-private')).rejects.toMatchObject({ status: 404 });
      await expect(discovery.protectedResourceMetadata(orgSlug, 'shared')).resolves.toBeDefined();
    });

    it('MCP skills/get naming the private gateway is not found for anyone else', async () => {
      const skills = { generateGatewaySkills: jest.fn().mockResolvedValue({ name: 'x', content: 'y' }) };
      const handler = new McpContentHandler(repo(require('../../entities/tool.entity').Tool), repo(require('../../entities/resource.entity').Resource), repo(GatewayTool), skills as any, {} as any, {} as any, policy);
      for (const who of others) {
        await expect(handler.handleSkillGet({ gatewayId: privateGateway.id }, organizationId, { id: users[who] }))
          .rejects.toMatchObject({ message: expect.stringMatching(/Gateway not found/) });
      }
      await expect(handler.handleSkillGet({ gatewayId: privateGateway.id }, organizationId, undefined, orgGateway.id))
        .rejects.toMatchObject({ message: expect.stringMatching(/Gateway not found/) });
      expect(skills.generateGatewaySkills).not.toHaveBeenCalled();
      await handler.handleSkillGet({ gatewayId: privateGateway.id }, organizationId, { id: users.owner });
      expect(skills.generateGatewaySkills).toHaveBeenCalledWith(privateGateway.id, organizationId);
    });
  });

  // ── LLM providers ──────────────────────────────────────────────────

  describe('LLM providers', () => {
    let service: LlmProvidersService;

    beforeAll(() => {
      const none = {} as any;
      service = new LlmProvidersService(
        repo(LlmProvider), repo(Conversation), repo(Message), repo(User), repo(Organization), repo(Gateway),
        repo(require('../../entities/tool.entity').Tool),
        none, { logUpdate: jest.fn(), logDelete: jest.fn(), logCreate: jest.fn() } as any,
        none, none, none, none, none, policy, { warmOrg: jest.fn() } as any, none,
      );
    });

    it('lists the private provider to its owner only', async () => {
      const mine = await service.getProviders({ organizationId, caller: { id: users.owner }, limit: 100 });
      expect(mine.providers.map((p) => p.id)).toEqual(expect.arrayContaining([privateProvider.id, orgProvider.id]));
      expect(mine.total).toBe(2);
      for (const who of others) {
        const theirs = await service.getProviders({ organizationId, caller: { id: users[who] }, limit: 100 });
        expect(theirs.providers.map((p) => p.id)).toEqual([orgProvider.id]);
        expect(theirs.total).toBe(1);
      }
      const system = await service.getProviders({ organizationId, bypassTeamFilter: true, limit: 100 });
      expect(system.providers.map((p) => p.id)).not.toContain(privateProvider.id);
    });

    it.each(others)('fetch, use and delete are 404 for %s', async (who) => {
      await expect(service.getProvider(privateProvider.id, organizationId, true, { id: users[who] }))
        .rejects.toBeInstanceOf(NotFoundException);
      await expect(service.deleteProvider(privateProvider.id, organizationId, users[who]))
        .rejects.toBeInstanceOf(NotFoundException);
      await expect(service.updateProvider(privateProvider.id, { name: 'hijack' }, organizationId, users[who]))
        .rejects.toBeInstanceOf(NotFoundException);
    });

    it('a run with no known user cannot use a private provider (fail closed)', async () => {
      await expect(service.getProvider(privateProvider.id, organizationId, true, null))
        .rejects.toBeInstanceOf(NotFoundException);
      await expect(service.getProvider(privateProvider.id, organizationId, true, { id: users.owner }))
        .resolves.toMatchObject({ id: privateProvider.id });
    });

    it.each(others)('the dashboard route guard (usage, models, chat, sessions) answers 404 for %s', async (who) => {
      const guard = new PrivateProviderGuard(repo(LlmProvider), repo(Conversation), policy);
      const ctx = (userId: string) => ({
        switchToHttp: () => ({ getRequest: () => ({ params: { providerId: privateProvider.id }, user: { id: userId } }) }),
      }) as any;
      await expect(guard.canActivate(ctx(users[who]))).rejects.toBeInstanceOf(NotFoundException);
      await expect(guard.canActivate(ctx(users.owner))).resolves.toBe(true);
    });

    it('routing never offers another user\'s private provider', async () => {
      const router = new ModelRouterService(repo(Model), repo(LlmProvider), repo(ModelDeployment));
      const card = { providerId: privateProvider.id, organizationId } as Model;
      for (const who of others) expect(await router.providerFor(card, { id: users[who] })).toBeNull();
      expect(await router.providerFor(card, undefined)).toBeNull();
      expect(await router.providerFor(card, { id: users.owner })).toMatchObject({ id: privateProvider.id });
    });
  });

  // ── Credentials ────────────────────────────────────────────────────

  describe('credentials', () => {
    let service: CredentialsService;

    beforeAll(() => {
      service = new CredentialsService(
        repo(Credential), repo(ApiKey), repo(LlmProvider), repo(Api), repo(Gateway), repo(Agent),
        { log: jest.fn() } as any, policy, { encryptForOrg: jest.fn(), warmOrg: jest.fn() } as any,
      );
    });

    it('lists the private credential to its owner only', async () => {
      const mine = (await service.findAll({ id: users.owner }, organizationId)).map((c) => c.id);
      expect(mine).toEqual(expect.arrayContaining([privateCredential.id, orgCredential.id]));
      for (const who of others) {
        const theirs = (await service.findAll({ id: users[who] }, organizationId)).map((c) => c.id);
        expect(theirs).toContain(orgCredential.id);
        expect(theirs).not.toContain(privateCredential.id);
      }
    });

    it.each(others)('fetch, usage, update and delete are 404 for %s', async (who) => {
      await expect(service.findById(privateCredential.id, organizationId, { id: users[who] })).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.getUsage(privateCredential.id, organizationId, { id: users[who] })).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.update(privateCredential.id, { name: 'hijack' }, organizationId, users[who])).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.delete(privateCredential.id, organizationId, users[who])).rejects.toBeInstanceOf(NotFoundException);
    });

    it('creating a private credential stamps the creator as owner', async () => {
      const created = await service.create(
        { name: 'mine', type: 'api_key', config: { apiKey: 'sk-new' }, visibility: 'private', teamId: 'ignored' },
        organizationId,
        users.peer,
      );
      const row = await repo(Credential).findOneByOrFail({ id: created.id });
      expect(row).toMatchObject({ visibility: 'private', ownerUserId: users.peer, teamId: null });
      expect((await service.findAll({ id: users.owner }, organizationId)).map((c) => c.id)).not.toContain(created.id);
      await repo(Credential).delete({ id: created.id });
    });

    it('resolving the secret at run time refuses everyone but the owner, and a run with no user', async () => {
      const resolver = new CredentialRefResolver(repo(Credential), { warmOrg: jest.fn(), encryptForOrg: jest.fn() } as any);
      for (const who of others) {
        await expect(resolver.resolve(organizationId, privateCredential.id, { principal: { id: users[who] } }))
          .rejects.toMatchObject({ response: { code: 'CREDENTIAL_NOT_FOUND' } });
      }
      await expect(resolver.resolve(organizationId, privateCredential.id, {}))
        .rejects.toMatchObject({ response: { code: 'CREDENTIAL_NOT_FOUND' } });
      await expect(resolver.resolve(organizationId, privateCredential.id, { principal: { id: users.owner } }))
        .resolves.toMatchObject({ credential: { id: privateCredential.id } });
    });

    it('a private connection backs only a provider private to its owner; a private provider\'s pasted key is private too', async () => {
      const envelope = { warmOrg: jest.fn(), encryptForOrg: jest.fn(async (_org: string, value: string) => `enc:${value}`) } as any;
      const refs = new CredentialRefResolver(repo(Credential), envelope);
      const secrets = new LlmProviderSecretsHelper(refs);
      const probe = (visibility: 'org' | 'private', ownerUserId: string) => ({
        organizationId, visibility, ownerUserId, credentialId: privateCredential.id, usageCredentialId: null,
      });

      // Another member naming the owner's private connection: it does not exist.
      await expect(secrets.assertKeysServable(probe('private', users.peer), users.peer))
        .rejects.toMatchObject({ response: { code: 'CREDENTIAL_NOT_FOUND' } });
      // The owner putting their private key behind an org-wide provider: refused.
      await expect(secrets.assertKeysServable(probe('org', users.owner), users.owner))
        .rejects.toBeInstanceOf(BadRequestException);
      // Behind their own private provider: fine.
      await expect(secrets.assertKeysServable(probe('private', users.owner), users.owner)).resolves.toBeUndefined();

      const managed = await refs.createManaged(organizationId, {
        name: 'Owner private OpenAI API key', type: CredentialType.API_KEY, config: { apiKey: 'sk-pasted' },
        managedBy: { kind: 'llm_provider', id: privateProvider.id },
      });
      expect(managed.visibility).toBe('org');
      await secrets.syncManagedScope({ ...privateProvider, credentialId: managed.id, usageCredentialId: null } as LlmProvider);
      const row = await repo(Credential).findOneByOrFail({ id: managed.id });
      expect(row).toMatchObject({ visibility: 'private', ownerUserId: users.owner, teamId: null });
      for (const who of others) {
        expect((await service.findAll({ id: users[who] }, organizationId)).map((c) => c.id)).not.toContain(managed.id);
        // Only its own provider reaches it without naming the owner.
        await expect(refs.resolve(organizationId, managed.id, { principal: { id: users[who] } }))
          .rejects.toMatchObject({ response: { code: 'CREDENTIAL_NOT_FOUND' } });
      }
      await expect(refs.resolve(organizationId, managed.id, {
        context: { purpose: 'health_check', resourceType: 'llm_provider', resourceId: privateProvider.id },
      })).resolves.toMatchObject({ credential: { id: managed.id } });
      await repo(Credential).delete({ id: managed.id });
    });
  });

  // ── Analytics: per-gateway and per-provider breakdowns ─────────────

  describe('analytics', () => {
    let analytics: AnalyticsService;

    beforeAll(async () => {
      analytics = new AnalyticsService(
        repo(RequestLog), repo(UsageMetric), repo(ToolExecution), repo(Conversation), repo(Message), repo(AuditLog), repo(AgentRun),
        new AnalyticsExportHelper(repo(RequestLog), repo(ToolExecution), repo(Conversation)),
        {} as any,
      );
      const now = new Date();
      for (const gw of [privateGateway, orgGateway]) {
        await repo(RequestLog).save(repo(RequestLog).create({
          method: 'POST', path: `/private-org${gw.endpoint}`, statusCode: 200, responseTime: 5,
          gatewayId: gw.id, organizationId, timestamp: now,
        } as any));
        await repo(UsageMetric).save(repo(UsageMetric).create({
          type: MetricType.REQUEST_COUNT, value: 1, status: MetricStatus.SUCCESS,
          gatewayId: gw.id, organizationId, timestamp: now,
        } as any));
      }
      for (const provider of [privateProvider, orgProvider]) {
        await repo(Conversation).save(repo(Conversation).create({
          providerId: provider.id, organizationId, userId: users.owner, context: {},
        } as any));
      }
    });

    it('request logs, gateway usage and model usage drop the owner\'s private rows for everyone else', async () => {
      const logsFor = async (who: keyof typeof users) =>
        (await analytics.getRequestLogs({ organizationId, page: 1, limit: 50, callerId: users[who] })).data.map((l) => l.gatewayId);
      expect(await logsFor('owner')).toEqual(expect.arrayContaining([privateGateway.id, orgGateway.id]));

      for (const who of others) {
        expect(await logsFor(who)).toEqual([orgGateway.id]);
        expect((await analytics.getGatewayUsage(organizationId, '7d', users[who])).map((r) => r.gatewayId)).toEqual([orgGateway.id]);
        expect((await analytics.getLlmUsage(organizationId, '7d', users[who])).map((r) => r.providerId)).toEqual([orgProvider.id]);
        const exported = await analytics.exportData({ organizationId, type: 'requests', format: 'json', callerId: users[who] });
        expect(exported.map((l: any) => l.gatewayId)).toEqual([orgGateway.id]);
      }
      expect((await analytics.getGatewayUsage(organizationId, '7d', users.owner)).map((r) => r.gatewayId).sort())
        .toEqual([privateGateway.id, orgGateway.id].sort());
      expect((await analytics.getLlmUsage(organizationId, '7d', users.owner)).map((r) => r.providerId).sort())
        .toEqual([privateProvider.id, orgProvider.id].sort());
    });
  });
});
