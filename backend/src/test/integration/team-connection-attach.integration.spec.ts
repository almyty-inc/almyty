import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Organization } from '../../entities/organization.entity';
import { User } from '../../entities/user.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { Team } from '../../entities/team.entity';
import { UserTeam, TeamRole } from '../../entities/user-team.entity';
import { LlmProvider, LlmProviderType } from '../../entities/llm-provider.entity';
import { Conversation } from '../../entities/conversation.entity';
import { Message } from '../../entities/message.entity';
import { Gateway } from '../../entities/gateway.entity';
import { Tool } from '../../entities/tool.entity';
import { Credential, CredentialType } from '../../entities/credential.entity';
import { Api, ApiType } from '../../entities/api.entity';
import { ApiSchema } from '../../entities/api-schema.entity';
import { Operation } from '../../entities/operation.entity';
import { Resource } from '../../entities/resource.entity';
import { ApiKey } from '../../entities/api-key.entity';
import { Agent } from '../../entities/agent.entity';
import { McpSource } from '../../entities/mcp-source.entity';

import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { ExecutionAccessService } from '../../common/authorization/execution-access.service';
import { CredentialRefResolver } from '../../modules/credentials/credential-ref.resolver';
import { CredentialsService } from '../../modules/credentials/credentials.service';
import { LlmProvidersService } from '../../modules/llm-providers/llm-providers.service';
import { LlmProviderSecretsHelper } from '../../modules/llm-providers/llm-provider-secrets.helper';
import { ApisService } from '../../modules/apis/apis.service';
import { McpSourcesService } from '../../modules/mcp-sources/mcp-sources.service';
import { makeEnvelopeCryptoMock } from '../envelope-crypto.mock';

/**
 * A team connection or credential attached to something wider than its
 * team -- an org-wide LLM provider, an org-wide API, an MCP source (always
 * org-wide) -- is refused when it is saved, with a 400 that says who could
 * not use it. It used to be accepted and then fail, as "credential not
 * found", for every run outside the team (the resolve-time team rule).
 * Attaching it to a target narrowed to that team is fine; so is an org
 * connection anywhere. The credential side is held to the same rule: a
 * team credential bound to an org API, or an org credential narrowed to a
 * team while org-wide consumers use it.
 *
 * Real Postgres. Gated on RUN_DB_INTEGRATION=1, isolated in its own schema.
 */
const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'team_connection_attach_test';

jest.setTimeout(120_000);

describeIfDb('a team connection is attached only where its team is the audience (real Postgres)', () => {
  let ds: DataSource;
  let policy: AccessPolicyService;
  let resolver: CredentialRefResolver;
  let organizationId: string;
  let teamId: string;
  const users: Record<'teammate' | 'outsider' | 'admin', string> = {} as any;
  let teamConnection: Credential;
  let teamCredential: Credential;
  let orgConnection: Credential;
  let seq = 0;

  const repo = <T extends object>(entity: new () => T) => ds.getRepository(entity);
  const insert = async <T extends object>(entity: new () => T, data: Record<string, unknown>): Promise<T> =>
    (await repo(entity).save(repo(entity).create(data as any) as unknown as T)) as T;
  const audit = { log: jest.fn(), logUpdate: jest.fn(), logDelete: jest.fn(), logCreate: jest.fn() } as any;
  const refusal = (p: Promise<unknown>) => p.then(() => null, (e) => e);
  /** The 400 names the team and who is left out. */
  const expectTeamRefusal = (err: any, noun: string) => {
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toContain("the team 'Payments'");
    expect(err.message).toContain(`anyone outside that team who uses this ${noun}`);
  };

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
    resolver = new CredentialRefResolver(repo(Credential), makeEnvelopeCryptoMock(), undefined, undefined, new ExecutionAccessService(policy));

    organizationId = (await insert(Organization, { name: 'Attach Org', slug: 'attach-org' }) as any).id;
    const roles: Array<[keyof typeof users, OrganizationRole]> = [
      ['teammate', OrganizationRole.MEMBER],
      ['outsider', OrganizationRole.MEMBER],
      ['admin', OrganizationRole.ADMIN],
    ];
    for (const [name, role] of roles) {
      const user = await insert(User, {
        email: `${name}@attach.test`, passwordHash: 'x', firstName: name, lastName: 'A',
      });
      users[name] = (user as any).id;
      await insert(UserOrganization, {
        userId: users[name], organizationId, role, isActive: true, inviteAccepted: true,
        permissions: ['manage_llm_providers'],
      });
    }
    teamId = (await insert(Team, { name: 'Payments', organizationId }) as any).id;
    await insert(UserTeam, { userId: users.teammate, teamId, role: TeamRole.LEAD, isActive: true });

    const base = { organizationId, isActive: true };
    teamConnection = await insert(Credential, {
      ...base, name: 'Payments OpenAI', type: CredentialType.API_KEY, connectorKey: 'openai',
      config: { apiKey: 'sk-team' }, visibility: 'team', teamId,
    });
    teamCredential = await insert(Credential, {
      ...base, name: 'Payments ledger token', type: CredentialType.BEARER_TOKEN, config: { token: 't' }, visibility: 'team', teamId,
    });
    orgConnection = await insert(Credential, {
      ...base, name: 'Shared OpenAI', type: CredentialType.API_KEY, connectorKey: 'openai',
      config: { apiKey: 'sk-org' }, visibility: 'org', teamId: null,
    });
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  describe('LLM provider save path', () => {
    let providers: LlmProvidersService;

    beforeAll(() => {
      const none = undefined as any;
      providers = new LlmProvidersService(
        repo(LlmProvider), repo(Conversation), repo(Message), repo(User), repo(Organization), repo(Gateway), repo(Tool),
        none, audit, { getDefaultCapabilities: () => ({}) } as any, none, none,
        { validateProviderConfiguration: jest.fn() } as any, none, policy, makeEnvelopeCryptoMock(),
        new LlmProviderSecretsHelper(resolver),
      );
    });

    const create = (userId: string, scope: Record<string, unknown>, credentialId: string) => {
      seq += 1;
      return providers.createProvider(
        { name: `provider-${seq}`, type: LlmProviderType.OPENAI, configuration: {}, credentialId, ...scope } as any,
        organizationId, userId, { checkInRequest: true },
      );
    };

    // Providers are managed by org owners and admins; an admin may use the
    // team's connection, so what decides is the provider's scope alone.
    it('refuses a team connection on an org-wide provider, saying who could not use it', async () => {
      expectTeamRefusal(await refusal(create(users.admin, { visibility: 'org' }, teamConnection.id)), 'LLM provider');
      expect(await repo(LlmProvider).count({ where: { credentialId: teamConnection.id } })).toBe(0);
    });

    it("accepts it on a provider of the connection's team, and on one private to someone who may use it", async () => {
      await expect(create(users.admin, { visibility: 'team', teamId }, teamConnection.id)).resolves.toMatchObject({ credentialId: teamConnection.id });
      await expect(create(users.admin, { visibility: 'private' }, teamConnection.id)).resolves.toMatchObject({ credentialId: teamConnection.id });
    });

    it('an org connection backs an org provider as before', async () => {
      await expect(create(users.admin, { visibility: 'org' }, orgConnection.id)).resolves.toMatchObject({ credentialId: orgConnection.id });
    });

    it('widening a team provider that uses a team connection to the org is refused', async () => {
      const provider = await create(users.admin, { visibility: 'team', teamId }, teamConnection.id);
      expectTeamRefusal(await refusal(providers.updateProvider(provider.id, { visibility: 'org' } as any, organizationId, users.admin)), 'LLM provider');
      expect((await repo(LlmProvider).findOneByOrFail({ id: provider.id })).visibility).toBe('team');
      // Pointing an org provider at it later is refused too.
      const org = await create(users.admin, { visibility: 'org' }, orgConnection.id);
      expectTeamRefusal(await refusal(providers.updateProvider(org.id, { credentialId: teamConnection.id } as any, organizationId, users.admin)), 'LLM provider');
      expect((await repo(LlmProvider).findOneByOrFail({ id: org.id })).credentialId).toBe(orgConnection.id);
    });
  });

  describe('API save path', () => {
    let apis: ApisService;

    beforeAll(() => {
      apis = new ApisService(
        repo(Api), repo(ApiSchema), repo(Operation), repo(Resource), repo(Organization), null as any, null as any,
        audit, ds, null as any, null as any, policy, resolver,
      );
    });

    const create = (userId: string, scope: Record<string, unknown>, config: Record<string, unknown>) => {
      seq += 1;
      return apis.create({
        name: `ledger-${seq}`, type: ApiType.OPENAPI, baseUrl: 'https://ledger.example.test', organizationId,
        authentication: { type: 'bearer', config }, ...scope,
      } as any, userId);
    };

    it('refuses an org-wide API that names a team connection or credential', async () => {
      expectTeamRefusal(await refusal(create(users.teammate, { visibility: 'org' }, { connectionId: teamConnection.id })), 'API');
      expectTeamRefusal(await refusal(create(users.teammate, { visibility: 'org' }, { credentialId: teamCredential.id })), 'API');
    });

    it("accepts them on an API of the team, and refuses widening that API later", async () => {
      const api = await create(users.teammate, { visibility: 'team', teamId }, { connectionId: teamConnection.id });
      expect(api.visibility).toBe('team');
      expectTeamRefusal(await refusal(apis.update(api.id, { visibility: 'org' } as any, organizationId, users.admin)), 'API');
      expect((await repo(Api).findOneByOrFail({ id: api.id })).visibility).toBe('team');
    });

    it('refuses pointing an org API at a team connection on update', async () => {
      const api = await create(users.admin, { visibility: 'org' }, { connectionId: orgConnection.id });
      expectTeamRefusal(
        await refusal(apis.update(api.id, { authentication: { type: 'bearer', config: { connectionId: teamConnection.id } } } as any, organizationId, users.admin)),
        'API',
      );
    });

    describe('from the credential side (CredentialsService)', () => {
      let credentials: CredentialsService;

      beforeAll(() => {
        credentials = new CredentialsService(
          repo(Credential), repo(ApiKey), repo(LlmProvider), repo(Api), repo(Gateway), repo(Agent),
          audit, policy, makeEnvelopeCryptoMock(), resolver,
        );
      });

      it('refuses a team credential bound to an org API, accepts it on a team API', async () => {
        const orgApi = await create(users.admin, { visibility: 'org' }, {});
        const teamApi = await create(users.teammate, { visibility: 'team', teamId }, {});
        const base = { name: 'bound', type: 'bearer_token', config: { token: 'x' }, visibility: 'team' as const, teamId };
        expectTeamRefusal(await refusal(credentials.create({ ...base, apiId: orgApi.id }, organizationId, users.teammate)), 'API');
        await expect(credentials.create({ ...base, apiId: teamApi.id }, organizationId, users.teammate)).resolves.toBeDefined();
      });

      it('refuses narrowing an org credential to a team while an org provider or API uses it', async () => {
        const shared = await credentials.create(
          { name: `shared-${seq}`, type: 'api_key', config: { apiKey: 'sk' } },
          organizationId, users.admin,
        );
        await insert(LlmProvider, {
          name: `uses-shared-${seq}`, type: LlmProviderType.OPENAI, organizationId, configuration: {},
          visibility: 'org', teamId: null, credentialId: shared.id,
        });
        expectTeamRefusal(
          await refusal(credentials.update(shared.id, { visibility: 'team', teamId }, organizationId, users.admin)),
          'LLM provider',
        );
        expect((await repo(Credential).findOneByOrFail({ id: shared.id })).visibility).toBe('org');
      });
    });
  });

  describe('MCP source save path', () => {
    let mcp: McpSourcesService;

    beforeAll(() => {
      const client = {
        assertUrlAllowed: jest.fn(),
        listTools: jest.fn().mockRejectedValue(new Error('offline')),
      };
      mcp = new McpSourcesService(repo(McpSource), repo(Tool), client as any, makeEnvelopeCryptoMock(), resolver);
    });

    it('refuses a team connection (an MCP source is org-wide) and writes nothing', async () => {
      const err = await refusal(mcp.create({ name: 'payments-mcp', url: 'https://mcp.example.test', credentialId: teamCredential.id } as any, organizationId, users.teammate));
      expectTeamRefusal(err, 'MCP source');
      expect(await repo(McpSource).count({ where: { organizationId } })).toBe(0);
    });

    it('someone who may not use the connection gets not found, as on resolve', async () => {
      const err = await refusal(mcp.create({ name: 'outsider-mcp', url: 'https://mcp.example.test', credentialId: teamCredential.id } as any, organizationId, users.outsider));
      expect(err).toBeInstanceOf(NotFoundException);
    });

    it('accepts an org connection', async () => {
      const out = await mcp.create({ name: 'shared-mcp', url: 'https://mcp.example.test', credentialId: orgConnection.id } as any, organizationId, users.outsider);
      expect(out.source).toMatchObject({ name: 'shared-mcp' });
    });
  });
});
