import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Organization } from '../../entities/organization.entity';
import { User } from '../../entities/user.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { Team } from '../../entities/team.entity';
import { UserTeam, TeamRole } from '../../entities/user-team.entity';
import { LlmProvider, LlmProviderStatus, LlmProviderType } from '../../entities/llm-provider.entity';
import { Model } from '../../entities/model.entity';
import { ModelVersion } from '../../entities/model-version.entity';
import { ModelDeployment } from '../../entities/model-deployment.entity';
import { Conversation } from '../../entities/conversation.entity';
import { Message } from '../../entities/message.entity';
import { Gateway } from '../../entities/gateway.entity';
import { Tool } from '../../entities/tool.entity';
import { Credential, CredentialType } from '../../entities/credential.entity';
import { ConnectionGrant } from '../../entities/connection-grant.entity';
import { Agent } from '../../entities/agent.entity';
import { Workspace } from '../../entities/workspace.entity';
import { SpendBudget } from '../../entities/spend-budget.entity';

import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { ModelCatalogService } from '../../modules/model-catalog/model-catalog.service';
import { ModelRouterService } from '../../modules/model-catalog/routing/model-router.service';
import { LlmProvidersService } from '../../modules/llm-providers/llm-providers.service';
import { ConnectionsService } from '../../modules/connections/connections.service';
import { GrantsService } from '../../modules/connections/grants/grants.service';
import { ConnectionPrincipal } from '../../modules/connections/connections.permissions';
import { ProviderUsageService } from '../../modules/provider-usage/provider-usage.service';
import { ProviderUsageSnapshot } from '../../entities/provider-usage-snapshot.entity';
import { CredentialsService } from '../../modules/credentials/credentials.service';
import { ApiKey } from '../../entities/api-key.entity';
import { Api } from '../../entities/api.entity';

/**
 * "Team only is team only; the scope is inherited." A team-scoped LLM
 * provider, the model cards it serves and a team-scoped connection are
 * usable by members of that team (and, as everywhere AccessPolicyService
 * decides, org owners and admins) and by nobody else -- including a run,
 * which acts as its inherited principal. Everyone else gets the 404 a
 * missing row gets, never a 403 that confirms it exists.
 *
 * Real Postgres (migrations, CHECK constraints, the real team-membership
 * join). Gated on RUN_DB_INTEGRATION=1, isolated in its own schema.
 */
const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'team_scope_inherited_test';

jest.setTimeout(120_000);

describeIfDb('team scope is inherited (real Postgres)', () => {
  let ds: DataSource;
  let policy: AccessPolicyService;
  let organizationId: string;
  let teamId: string;
  // teammate: on the team. outsider: org member on no team. admin: org admin.
  const users: Record<'teammate' | 'outsider' | 'admin', string> = {} as any;

  let teamProvider: LlmProvider;
  let orgProvider: LlmProvider;
  let teamCard: Model;
  let orgCard: Model;

  const repo = <T extends object>(entity: new () => T) => ds.getRepository(entity);
  const insert = async <T extends object>(entity: new () => T, data: Record<string, unknown>): Promise<T> =>
    (await repo(entity).save(repo(entity).create(data as any) as unknown as T)) as T;
  const none = undefined as any;

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

    organizationId = (await insert(Organization, { name: 'Scope Org', slug: 'scope-org' }) as any).id;
    const roles: Array<[keyof typeof users, OrganizationRole]> = [
      ['teammate', OrganizationRole.MEMBER],
      ['outsider', OrganizationRole.MEMBER],
      ['admin', OrganizationRole.ADMIN],
    ];
    for (const [name, role] of roles) {
      const user = await insert(User, { email: `${name}@scope.test`, passwordHash: 'x', firstName: name, lastName: 'S' });
      users[name] = (user as any).id;
      await insert(UserOrganization, { userId: users[name], organizationId, role, isActive: true, inviteAccepted: true });
    }
    teamId = (await insert(Team, { name: 'Payments', organizationId }) as any).id;
    await insert(UserTeam, { userId: users.teammate, teamId, role: TeamRole.MEMBER, isActive: true });

    const providerBase = {
      type: LlmProviderType.OPENAI, organizationId, configuration: { model: 'gpt-x' },
      status: LlmProviderStatus.ACTIVE, isHealthy: true,
    };
    teamProvider = await insert(LlmProvider, { ...providerBase, name: 'Payments OpenAI', visibility: 'team', teamId, ownerUserId: users.teammate });
    orgProvider = await insert(LlmProvider, { ...providerBase, name: 'Shared OpenAI', visibility: 'org', teamId: null });
    const cardBase = { organizationId, providerType: 'openai', status: 'active', validationStatus: 'passed' };
    teamCard = await insert(Model, { ...cardBase, name: 'Payments model', providerId: teamProvider.id, vendorModelId: 'gpt-team' });
    orgCard = await insert(Model, { ...cardBase, name: 'Shared model', providerId: orgProvider.id, vendorModelId: 'gpt-org' });
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  // ── 1. the model catalog and the router ────────────────────────────

  describe('model cards served by a team provider', () => {
    let router: ModelRouterService;
    let catalog: ModelCatalogService;

    beforeAll(() => {
      router = new ModelRouterService(repo(Model), repo(LlmProvider), repo(ModelDeployment), none, none, policy);
      catalog = new ModelCatalogService(repo(Model), repo(ModelVersion), repo(LlmProvider), router, none, none, none, none, none, policy);
    });

    it('are listed to the team and org admins, not to a member outside the team or to nobody', async () => {
      const ids = async (viewer: string | null) => (await catalog.list(organizationId, {}, viewer)).map((c) => c.id);
      for (const who of ['teammate', 'admin'] as const) {
        expect(await ids(users[who])).toEqual(expect.arrayContaining([teamCard.id, orgCard.id]));
      }
      expect(await ids(users.outsider)).toEqual([orgCard.id]);
      expect(await ids(null)).toEqual([orgCard.id]);
    });

    it('are the 404 a missing card gets when fetched, validated, updated or removed from outside the team', async () => {
      const missing = new NotFoundException('Model not found');
      await expect(catalog.get(organizationId, teamCard.id, users.outsider)).rejects.toThrow(missing);
      await expect(catalog.validate(organizationId, teamCard.id, users.outsider)).rejects.toThrow(missing);
      await expect(catalog.update(organizationId, teamCard.id, { region: 'eu' }, users.outsider)).rejects.toThrow(missing);
      await expect(catalog.remove(organizationId, teamCard.id, users.outsider)).rejects.toThrow(missing);
      await expect(catalog.get(organizationId, teamCard.id, users.teammate)).resolves.toMatchObject({ id: teamCard.id });
      expect(await repo(Model).count({ where: { id: teamCard.id } })).toBe(1);
    });

    it('cannot be registered on or synced from a team provider by a member outside the team', async () => {
      await expect(catalog.register(organizationId, { name: 'x', vendorModelId: 'gpt-new', providerId: teamProvider.id }, users.outsider))
        .rejects.toThrow(new NotFoundException('Provider not found'));
      await expect(catalog.syncFromProvider(organizationId, teamProvider.id, users.outsider))
        .rejects.toThrow(new NotFoundException('Provider not found'));
    });

    it('are never routed for a principal outside the team, or for nobody', async () => {
      const planned = async (principal?: { id: string }) =>
        (await router.plan(organizationId, {}, principal)).candidates.map((c) => c.modelId);
      expect(await planned({ id: users.outsider })).toEqual([orgCard.id]);
      expect(await planned(undefined)).toEqual([orgCard.id]);
      expect(await planned({ id: users.teammate })).toEqual(expect.arrayContaining([teamCard.id, orgCard.id]));
      expect(await router.providerFor(teamCard, { id: users.outsider })).toBeNull();
      await expect(router.providerForModelId(organizationId, teamCard.id, { id: users.outsider }))
        .rejects.toThrow(/has no callable provider/);
      expect(await router.providerFor(teamCard, { id: users.teammate })).toMatchObject({ id: teamProvider.id });
      expect(await router.providerFor(teamCard, { id: users.admin })).toMatchObject({ id: teamProvider.id });
    });
  });

  // ── 4. a provider named by id on the chat and execution paths ─────

  describe('a team provider named by id (getProvider with a caller)', () => {
    let providers: LlmProvidersService;

    beforeAll(() => {
      providers = new LlmProvidersService(
        repo(LlmProvider), repo(Conversation), repo(Message), repo(User), repo(Organization), repo(Gateway), repo(Tool),
        none, { log: jest.fn(), logUpdate: jest.fn(), logDelete: jest.fn(), logCreate: jest.fn() } as any,
        none, none, none, none, none, policy, { warmOrg: jest.fn() } as any, none,
      );
    });

    it('is refused to a run principal outside the team with a 404 that names who the call acts as', async () => {
      const refusal = await providers.getProvider(teamProvider.id, organizationId, true, { id: users.outsider }).catch((e) => e);
      expect(refusal).toBeInstanceOf(NotFoundException);
      expect(refusal.getResponse()).toMatchObject({ code: 'PROVIDER_NOT_USABLE' });
      expect(refusal.message).toContain(`user ${users.outsider}`);
      // A missing provider asked for on the same behalf is the same answer.
      const missing = await providers.getProvider('00000000-0000-4000-8000-000000000000', organizationId, true, { id: users.outsider }).catch((e) => e);
      expect(missing.getResponse()).toEqual({ ...refusal.getResponse(), message: refusal.getResponse().message });
    });

    it('is refused to a call attributed to nobody', async () => {
      await expect(providers.getProvider(teamProvider.id, organizationId, true, null)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('is usable by the team and by org admins; an org provider stays usable by everyone', async () => {
      for (const who of ['teammate', 'admin'] as const) {
        await expect(providers.getProvider(teamProvider.id, organizationId, true, { id: users[who] }))
          .resolves.toMatchObject({ id: teamProvider.id });
      }
      for (const caller of [{ id: users.outsider }, { id: users.teammate }, null]) {
        await expect(providers.getProvider(orgProvider.id, organizationId, true, caller)).resolves.toMatchObject({ id: orgProvider.id });
      }
    });
  });

  // ── 2 + 3. connections and their grants ────────────────────────────

  describe('a team connection', () => {
    let grants: GrantsService;
    let connections: ConnectionsService;
    let teamConnection: Credential;
    let personalConnection: Credential;
    let orgConnection: Credential;

    const principal = (who: keyof typeof users): ConnectionPrincipal => ({
      id: users[who],
      organizationMemberships: [{
        organizationId,
        role: who === 'admin' ? OrganizationRole.ADMIN : OrganizationRole.MEMBER,
        permissions: [],
      }],
    });
    const notFound = { response: { code: 'CONNECTION_NOT_FOUND' } };

    beforeAll(async () => {
      const audit = { log: jest.fn().mockResolvedValue(undefined) } as any;
      grants = new GrantsService(
        repo(ConnectionGrant), repo(Credential), repo(UserOrganization), repo(UserTeam), repo(Team),
        repo(Agent), repo(Workspace), repo(SpendBudget), audit,
      );
      const catalog = { find: jest.fn().mockResolvedValue(undefined), list: jest.fn().mockResolvedValue([]) } as any;
      connections = new ConnectionsService(
        repo(Credential), repo(Organization), catalog, none, none, audit, none,
        { create: () => ({}) } as any, {} as any, grants,
      );
      const base = { type: CredentialType.API_KEY, organizationId, connectorKey: 'openai', config: { apiKey: 'sk' }, isActive: true };
      teamConnection = await insert(Credential, { ...base, name: 'Payments key', visibility: 'team', teamId, ownerUserId: null });
      personalConnection = await insert(Credential, { ...base, name: 'Teammate key', visibility: 'org', teamId: null, ownerUserId: users.teammate });
      orgConnection = await insert(Credential, { ...base, name: 'Shared key', visibility: 'org', teamId: null, ownerUserId: null });
    });

    it('is not listed, and not found, for a member outside the team', async () => {
      const listed = (await connections.list(principal('outsider'), organizationId)).map((c) => c.id);
      expect(listed).toContain(orgConnection.id);
      expect(listed).not.toContain(teamConnection.id);
      await expect(connections.get(principal('outsider'), organizationId, teamConnection.id)).rejects.toMatchObject(notFound);
      await expect(connections.validate(principal('outsider'), organizationId, teamConnection.id)).rejects.toMatchObject(notFound);
    });

    it('is listed and found for the team and for org admins', async () => {
      for (const who of ['teammate', 'admin'] as const) {
        expect((await connections.list(principal(who), organizationId)).map((c) => c.id)).toContain(teamConnection.id);
        await expect(connections.get(principal(who), organizationId, teamConnection.id)).resolves.toMatchObject({ id: teamConnection.id });
      }
    });

    it('grant, list and revoke on it answer 404, not 403, for a member outside the team', async () => {
      await expect(grants.grant(teamConnection.id, { principalType: 'role', principalId: 'member' }, principal('outsider'), organizationId))
        .rejects.toMatchObject(notFound);
      await expect(grants.list(teamConnection.id, principal('outsider'), organizationId)).rejects.toMatchObject(notFound);
      const granted = await grants.grant(teamConnection.id, { principalType: 'user', principalId: users.teammate }, principal('admin'), organizationId);
      await expect(grants.revoke(granted.id, principal('outsider'), organizationId)).rejects.toMatchObject(notFound);
      expect(await repo(ConnectionGrant).count({ where: { id: granted.id } })).toBe(1);
    });

    it('a user-scoped connection the caller cannot see is 404 on grant and list, too', async () => {
      await expect(grants.grant(personalConnection.id, { principalType: 'role', principalId: 'member' }, principal('outsider'), organizationId))
        .rejects.toMatchObject(notFound);
      await expect(grants.list(personalConnection.id, principal('outsider'), organizationId)).rejects.toMatchObject(notFound);
    });

    it('one the caller can see but not manage is still the 403', async () => {
      const refusal = await grants.grant(orgConnection.id, { principalType: 'role', principalId: 'member' }, principal('outsider'), organizationId).catch((e) => e);
      expect(refusal).toBeInstanceOf(ForbiddenException);
      expect(refusal.getResponse()).toMatchObject({ code: 'CONNECTION_GRANT_FORBIDDEN' });
    });

    it('resolving it for use is a 404 for a principal outside the team, even with a grant naming them', async () => {
      await grants.grant(teamConnection.id, { principalType: 'user', principalId: users.outsider }, principal('admin'), organizationId);
      grants.invalidate(teamConnection.id);
      await expect(grants.assertCanUse(principal('outsider'), teamConnection)).rejects.toMatchObject(notFound);
      await expect(grants.assertCanUse(principal('teammate'), teamConnection)).resolves.toMatchObject({ allowed: true });
    });
  });

  // ── sweep: other places that checked the private tier only ─────────

  describe('surfaces that name providers', () => {
    it('provider usage reconciliation leaves out a team provider for a member outside the team', async () => {
      const usage = new ProviderUsageService(repo(ProviderUsageSnapshot), repo(LlmProvider), repo(Conversation), none, policy);
      const ids = async (viewer: string | null) =>
        (await usage.getReconciliation(organizationId, { from: new Date(0) }, viewer)).map((r) => r.llmProviderId);
      expect(await ids(users.outsider)).toEqual([orgProvider.id]);
      expect(await ids(null)).toEqual([orgProvider.id]);
      expect(await ids(users.teammate)).toEqual(expect.arrayContaining([teamProvider.id, orgProvider.id]));
    });

    it("a credential's usage does not name a team provider to a member outside the team", async () => {
      const credential = await insert(Credential, {
        name: 'Shared upstream key', type: CredentialType.API_KEY, organizationId, config: { apiKey: 'sk' },
        visibility: 'org', teamId: null, isActive: true,
      });
      await repo(LlmProvider).update({ id: teamProvider.id }, { credentialId: credential.id } as any);
      await repo(LlmProvider).update({ id: orgProvider.id }, { credentialId: credential.id } as any);
      try {
        const credentials = new CredentialsService(
          repo(Credential), repo(ApiKey), repo(LlmProvider), repo(Api), repo(Gateway), repo(Agent),
          { log: jest.fn() } as any, policy, none,
        );
        const named = async (who: keyof typeof users) =>
          (await credentials.getUsage(credential.id, organizationId, { id: users[who] })).llmProviders.map((p: any) => p.id);
        expect(await named('outsider')).toEqual([orgProvider.id]);
        expect(await named('teammate')).toEqual(expect.arrayContaining([teamProvider.id, orgProvider.id]));
      } finally {
        await repo(LlmProvider).update({ id: teamProvider.id }, { credentialId: null } as any);
        await repo(LlmProvider).update({ id: orgProvider.id }, { credentialId: null } as any);
      }
    });
  });
});
