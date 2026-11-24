import { Logger } from '@nestjs/common';
import { DataSource, EntityTarget, ObjectLiteral } from 'typeorm';

import { Organization } from '../../entities/organization.entity';
import { User } from '../../entities/user.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { UserTeam } from '../../entities/user-team.entity';
import { Api, ApiType } from '../../entities/api.entity';
import { Credential, CredentialType } from '../../entities/credential.entity';
import { LlmProvider } from '../../entities/llm-provider.entity';
import { LlmProviderType } from '../../entities/llm-provider-type';
import { McpSource } from '../../entities/mcp-source.entity';
import { ApiKey } from '../../entities/api-key.entity';
import { Gateway, GatewayType } from '../../entities/gateway.entity';
import { Agent } from '../../entities/agent.entity';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { CredentialsService } from '../../modules/credentials/credentials.service';
import { makeEnvelopeCryptoMock } from '../envelope-crypto.mock';

/**
 * "Used by" on Credentials, against real Postgres: every reference query
 * credential-usage.ts runs (the column selections, the gateway's auth
 * configs) is valid SQL on the migrated schema, and a Gmail sign-in two
 * APIs use says so instead of "Nothing yet".
 *
 * Gated on RUN_DB_INTEGRATION=1, in its own schema.
 */
const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'credential_used_by_test';

jest.setTimeout(180_000);

describeIfDb('credential usedBy (real Postgres)', () => {
  let ds: DataSource;
  let service: CredentialsService;
  let orgId: string;
  let admin: string;
  const connection = {
    type: 'postgres' as const,
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || '',
    database: process.env.DATABASE_NAME || 'almyty_test',
  };
  const repo = <T extends ObjectLiteral>(entity: EntityTarget<T>) => ds.getRepository(entity);
  const save = async <T extends ObjectLiteral>(entity: EntityTarget<T>, data: Record<string, unknown>): Promise<T> =>
    (await repo(entity).save(repo(entity).create(data as any) as any)) as T;

  beforeAll(async () => {
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
      migrationsTransactionMode: 'each',
      dropSchema: true,
    });
    await ds.initialize();

    const policy = new AccessPolicyService(repo(UserOrganization), repo(UserTeam));
    service = new CredentialsService(
      repo(Credential), repo(ApiKey), repo(LlmProvider), repo(Api), repo(Gateway), repo(Agent),
      { log: jest.fn() } as any, policy, makeEnvelopeCryptoMock(),
    );

    orgId = (await save(Organization, { name: 'Used By Org', slug: 'used-by-org' }) as any).id;
    const user = await save(User, { email: 'admin@used-by.test', passwordHash: 'x', firstName: 'A', lastName: 'D' });
    admin = (user as any).id;
    await save(UserOrganization, { userId: admin, organizationId: orgId, role: OrganizationRole.ADMIN, isActive: true, inviteAccepted: true, joinedAt: new Date() });
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  it('lists the APIs, model connection, MCP server and gateway that point at a credential', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const gmail = await save(Credential, {
      organizationId: orgId, name: 'Gmail sign-in', type: CredentialType.OAUTH2, config: {}, connectorKey: 'google', visibility: 'org',
    }) as any;
    const unused = await save(Credential, { organizationId: orgId, name: 'Spare key', type: CredentialType.API_KEY, config: {}, visibility: 'org' }) as any;
    const bound = await save(Credential, { organizationId: orgId, name: 'Bound key', type: CredentialType.API_KEY, config: {}, visibility: 'org' }) as any;

    const gmailApi = await save(Api, { organizationId: orgId, name: 'Gmail', type: ApiType.OPENAPI, baseUrl: 'https://gmail.googleapis.com', authentication: { type: 'oauth2', config: { connectionId: gmail.id } } }) as any;
    await save(Api, { organizationId: orgId, name: 'Calendar', type: ApiType.OPENAPI, baseUrl: 'https://www.googleapis.com', authentication: { type: 'oauth2', config: { credentialId: gmail.id } } });
    const boundApi = await save(Api, { organizationId: orgId, name: 'Weather', type: ApiType.OPENAPI, baseUrl: 'https://weather.example.com' }) as any;
    await repo(Credential).update({ id: bound.id }, { apiId: boundApi.id });
    await save(LlmProvider, { organizationId: orgId, name: 'Google models', type: LlmProviderType.GOOGLE, configuration: {}, credentialId: gmail.id });
    await save(McpSource, { organizationId: orgId, name: 'Drive MCP', url: 'https://mcp.example.com', credentialId: gmail.id });
    await save(Gateway, { organizationId: orgId, name: 'Inbox channel', type: GatewayType.SLACK, endpoint: 'inbox-channel', configuration: { credentialId: gmail.id } });

    const rows = await service.findAll({ id: admin }, orgId);
    const byId = new Map(rows.map((r: any) => [r.id, r]));
    expect(byId.get(gmail.id).usedBy).toEqual(
      expect.arrayContaining([
        { type: 'api', id: gmailApi.id, name: 'Gmail' },
        expect.objectContaining({ type: 'api', name: 'Calendar' }),
        expect.objectContaining({ type: 'llm_provider', name: 'Google models' }),
        expect.objectContaining({ type: 'mcp_source', name: 'Drive MCP' }),
        expect.objectContaining({ type: 'gateway', name: 'Inbox channel' }),
      ]),
    );
    expect(byId.get(gmail.id).usedBy).toHaveLength(5);
    expect(byId.get(bound.id).usedBy).toEqual([{ type: 'api', id: boundApi.id, name: 'Weather' }]);
    expect(byId.get(unused.id).usedBy).toEqual([]);
    expect((await service.findById(gmail.id, orgId, { id: admin })).usedBy).toHaveLength(5);
    // Every reference table was read: none of the queries failed.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
