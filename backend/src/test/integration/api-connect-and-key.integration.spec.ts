import { readFileSync } from 'fs';
import { join } from 'path';
import { DataSource, EntityTarget, ObjectLiteral } from 'typeorm';

import { Organization } from '../../entities/organization.entity';
import { User } from '../../entities/user.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { UserTeam } from '../../entities/user-team.entity';
import { Api, ApiType } from '../../entities/api.entity';
import { ApiSchema } from '../../entities/api-schema.entity';
import { Operation } from '../../entities/operation.entity';
import { Resource } from '../../entities/resource.entity';
import { Credential, CredentialType } from '../../entities/credential.entity';
import { AuditLog } from '../../entities/audit-log.entity';

import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { AuditLogService } from '../../modules/audit-log/audit-log.service';
import { ApisService } from '../../modules/apis/apis.service';
import { ApisImportHelper } from '../../modules/apis/apis-import.helper';
import { ApiConnectService } from '../../modules/apis/api-connect.service';
import { ApiKeyService } from '../../modules/apis/api-key.service';
import { ApiQuotaExceededException } from '../../modules/apis/api-quota';
import { CredentialRefResolver } from '../../modules/credentials/credential-ref.resolver';
import { ToolAuthService } from '../../modules/tools/services/tool-auth.service';
import { encryptField } from '../../common/security/field-crypto';
import { makeEnvelopeCryptoMock } from '../envelope-crypto.mock';

/**
 * Connecting an API in one step and its one key, against a real Postgres
 * built by the migrations: the quota lock and name check run in a real
 * transaction, and the key's queries (the newest active credential the
 * executor sends, "every other one stops being used" as a Not() update)
 * are the SQL the unit fakes model.
 *
 * Gated on RUN_DB_INTEGRATION=1 and isolated in its own schema.
 */
const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'api_connect_and_key_test';

jest.setTimeout(120_000);

const fixture = (name: string) =>
  readFileSync(join(__dirname, '..', '..', 'modules', 'schema-parser', '__fixtures__', name), 'utf8');

describeIfDb('Connecting an API and its key (real Postgres)', () => {
  let ds: DataSource;
  let connect: ApiConnectService;
  let keys: ApiKeyService;
  let toolAuth: ToolAuthService;
  let orgId: string;
  let otherOrgId: string;
  let admin: string;
  let seq = 0;

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
      dropSchema: true,
    });
    await ds.initialize();

    const envelope = makeEnvelopeCryptoMock();
    const policy = new AccessPolicyService(repo(UserOrganization), repo(UserTeam));
    const audit = new AuditLogService(repo(AuditLog), repo(User));
    const resolver = new CredentialRefResolver(repo(Credential), envelope);
    const importHelper = new ApisImportHelper(null as any, null as any, null as any, null as any, null as any, null as any, null as any);
    const apis = new ApisService(
      repo(Api), repo(ApiSchema), repo(Operation), repo(Resource), repo(Organization),
      {} as any, {} as any, audit, ds, importHelper, {} as any, policy, resolver,
    );
    connect = new ApiConnectService(repo(Api), apis, importHelper);
    keys = new ApiKeyService(repo(Credential), apis, resolver);
    toolAuth = new ToolAuthService(repo(Credential), { get: () => undefined } as any, envelope, resolver);

    orgId = (await save(Organization, { name: 'Connect Org', slug: 'connect-org', settings: { maxApis: 3 } }) as any).id;
    otherOrgId = (await save(Organization, { name: 'Other Org', slug: 'connect-other' }) as any).id;
    const user = await save(User, { email: `admin-${++seq}@connect.test`, passwordHash: 'x', firstName: 'A', lastName: 'D' });
    admin = (user as any).id;
    await save(UserOrganization, { userId: admin, organizationId: orgId, role: OrganizationRole.ADMIN, isActive: true, inviteAccepted: true, joinedAt: new Date() });
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  const sent = async (apiId: string) => {
    const api = await repo(Api).findOneByOrFail({ id: apiId });
    const config: any = { headers: {} };
    await toolAuth.applyApiAuth(config, api, { organizationId: orgId, userId: admin } as any);
    return config.headers;
  };

  it('creates the API with what the description says, numbers a clashing name, and holds the API limit', async () => {
    const first = await connect.connect({ organizationId: orgId, userId: admin, content: fixture('openapi3-petstore.json') });
    const second = await connect.connect({ organizationId: orgId, userId: admin, content: fixture('openapi3-petstore.json') });
    // Another organization's API of the same name is no clash.
    await save(Api, { organizationId: otherOrgId, name: 'Weather', type: ApiType.OPENAPI, baseUrl: 'https://x.example.com' });
    const third = await connect.connect({ organizationId: orgId, userId: admin, content: fixture('openapi3-weather.yaml') });

    const rows = await repo(Api).find({ where: { organizationId: orgId }, order: { name: 'ASC' } });
    expect(rows.map((r) => r.name)).toEqual(['Petstore', 'Petstore 2', 'Weather']);
    expect(first.api).toMatchObject({ baseUrl: 'https://petstore.example.com/v2', version: '2.1.0', ownerUserId: admin });
    expect(second.needs).toEqual({ key: true, address: false });
    expect(third.api.authentication).toEqual({ type: 'bearer', config: {} });

    // maxApis is 3: the fourth is refused and nothing is written.
    await expect(connect.connect({ organizationId: orgId, userId: admin, content: fixture('greeter.proto') })).rejects.toBeInstanceOf(
      ApiQuotaExceededException,
    );
    expect(await repo(Api).count({ where: { organizationId: orgId } })).toBe(3);
  });

  it('stores a pasted key as the one credential the executor sends, retiring older ones', async () => {
    const api = await repo(Api).findOneByOrFail({ organizationId: orgId, name: 'Petstore' });
    await save(Credential, {
      organizationId: orgId, apiId: api.id, name: 'Old upstream', type: CredentialType.BEARER_TOKEN,
      config: { token: encryptField('old-token') }, isActive: true,
    });
    expect(await sent(api.id)).toEqual({ Authorization: 'Bearer old-token' });

    await keys.set(api.id, orgId, admin, { key: 'pk-1' });
    await keys.set(api.id, orgId, admin, { key: 'pk-2', headerName: 'X-Pets-Token' });

    const active = await repo(Credential).find({ where: { apiId: api.id, isActive: true } });
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ type: CredentialType.API_KEY, keyName: 'X-Pets-Token', organizationId: orgId });
    expect(await repo(Credential).count({ where: { apiId: api.id, isActive: false } })).toBe(1);
    const row = await repo(Api).findOneByOrFail({ id: api.id });
    expect(JSON.stringify(row.authentication)).not.toContain('pk-2');
    expect(await sent(api.id)).toEqual({ 'X-Pets-Token': 'pk-2' });

    const view = await keys.get(api.id, orgId, { id: admin });
    expect(view).toMatchObject({ source: 'key', headerName: 'X-Pets-Token', credential: { id: active[0].id } });
  });

  it('points the API at a connection and sends its key; removing stops sending any', async () => {
    const api = await repo(Api).findOneByOrFail({ organizationId: orgId, name: 'Petstore 2' });
    const conn = await save(Credential, {
      organizationId: orgId, name: 'Pets account', type: CredentialType.API_KEY, connectorKey: 'toolsource-openapi',
      config: { apiKey: encryptField('pk-conn') }, isActive: true, visibility: 'org',
    });

    await keys.set(api.id, orgId, admin, { connectionId: (conn as any).id });
    expect(await sent(api.id)).toEqual({ 'X-Pets-Key': 'pk-conn' });

    await keys.remove(api.id, orgId, admin);
    expect(await sent(api.id)).toEqual({});
    expect((await keys.get(api.id, orgId, { id: admin })).source).toBeNull();
  });
});
