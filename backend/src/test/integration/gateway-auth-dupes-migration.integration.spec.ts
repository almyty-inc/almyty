import { readdirSync } from 'fs';
import { join } from 'path';
import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';

import { GatewayEndpointAccess1791000000000 } from '../../migrations/1791000000000-GatewayEndpointAccess';
import { GatewayAuthService } from '../../modules/gateways/gateway-auth.service';
import { GatewayAuthValidators } from '../../modules/gateways/gateway-auth-validators.helper';
import { Gateway } from '../../entities/gateway.entity';
import { GatewayAuth } from '../../entities/gateway-auth.entity';
import { User } from '../../entities/user.entity';
import { ApiKey } from '../../entities/api-key.entity';
import { OAuthAccessToken } from '../../entities/oauth-access-token.entity';
import { provisionExtensionsInPublic } from './test-db-extensions';

/**
 * GatewayEndpointAccess puts a unique index on the active gateway_auth rows
 * per (gatewayId, type). A database where a gateway already held two active
 * rows of one type aborted the deploy on it (staging: two gateways with two
 * active api_key rows each). The migration now folds each group into its
 * newest row first; these run the real migration chain up to it, seed rows
 * the way the app stores them, run it, and then authenticate through the
 * real GatewayAuthService.
 */
const describeOrSkip = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

const TARGET = '1791000000000';
type MigrationClass = new () => unknown;

function migrationsBefore(timestamp: string): MigrationClass[] {
  const dir = join(__dirname, '..', '..', 'migrations');
  return readdirSync(dir)
    .filter((f) => /^\d+-.*\.ts$/.test(f) && !f.endsWith('.spec.ts') && f.split('-')[0] < timestamp)
    .sort()
    .flatMap((f) => Object.values(require(join(dir, f))).filter((v): v is MigrationClass => typeof v === 'function'));
}

const gwKey = () => `gw_${crypto.randomBytes(32).toString('base64url')}`;
const sha256 = (key: string) => crypto.createHash('sha256').update(key).digest('hex');
const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

async function migratedUpTo(schema: string): Promise<DataSource> {
  const connection = {
    type: 'postgres' as const,
    host: process.env.DATABASE_HOST || 'localhost',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || 'postgres',
    database: process.env.DATABASE_NAME || 'almyty_test',
  };
  const bootstrap = new DataSource(connection);
  await bootstrap.initialize();
  await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await bootstrap.query(`CREATE SCHEMA "${schema}"`);
  await provisionExtensionsInPublic((sql, params) => bootstrap.query(sql, params as any[]));
  await bootstrap.destroy();

  const ds = new DataSource({
    ...connection,
    schema,
    extra: { options: `-c search_path=${schema},public` },
    entities: [join(__dirname, '..', '..', 'entities', '*.entity{.ts,.js}')],
    migrations: migrationsBefore(TARGET),
    migrationsTransactionMode: 'all',
    logging: false,
  });
  await ds.initialize();
  await ds.runMigrations();
  return ds;
}

async function runTarget(ds: DataSource, direction: 'up' | 'down' = 'up'): Promise<void> {
  const runner = ds.createQueryRunner();
  await runner.startTransaction();
  try {
    await new GatewayEndpointAccess1791000000000()[direction](runner);
    await runner.commitTransaction();
  } catch (error) {
    await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
  }
}

function authService(ds: DataSource): GatewayAuthService {
  const validators = new GatewayAuthValidators(
    ds.getRepository(Gateway),
    ds.getRepository(User),
    ds.getRepository(ApiKey),
    ds.getRepository(OAuthAccessToken),
    new JwtService({}),
  );
  return new GatewayAuthService(ds.getRepository(GatewayAuth), ds.getRepository(Gateway), ds.getRepository(ApiKey), validators);
}

/** An org, an owner who is a member of it, and an MCP gateway in it. */
async function seedGateway(ds: DataSource, endpoint: string) {
  const org = crypto.randomUUID();
  const user = crypto.randomUUID();
  const gateway = crypto.randomUUID();
  await ds.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $2)`, [org, `org-${endpoint}`]);
  await ds.query(
    `INSERT INTO users (id, email, "passwordHash", "firstName", "lastName", "isActive") VALUES ($1, $2, 'x', 'Ada', 'Owner', true)`,
    [user, `${endpoint}@example.com`],
  );
  await ds.query(
    `INSERT INTO user_organizations ("userId", "organizationId", role, "isActive", "inviteAccepted") VALUES ($1, $2, 'owner', true, true)`,
    [user, org],
  );
  await ds.query(
    `INSERT INTO gateways (id, name, type, endpoint, "organizationId", status, configuration) VALUES ($1, $2, 'mcp', $3, $4, 'active', '{}')`,
    [gateway, `gw-${endpoint}`, `/${endpoint}`, org],
  );
  return { org, user, gateway };
}

/** A gateway key as generateApiKey stores it: only its SHA-256 and prefix. */
async function mintKey(ds: DataSource, seed: { org: string; user: string; gateway: string }, name: string): Promise<string> {
  const key = gwKey();
  await ds.query(
    `INSERT INTO api_keys (name, "keyHash", "keyPrefix", "organizationId", "userId", "gatewayId", scopes, "isActive") VALUES ($1, $2, $3, $4, $5, $6, '[]', true)`,
    [name, sha256(key), key.substring(0, 8), seed.org, seed.user, seed.gateway],
  );
  return key;
}

async function addAuth(
  ds: DataSource,
  gatewayId: string,
  type: string,
  createdAt: string,
  configuration: Record<string, any>,
  validationRules: Record<string, any> | null = null,
  isRequired = true,
): Promise<string> {
  const [row] = await ds.query(
    `INSERT INTO gateway_auth ("gatewayId", type, "isRequired", "isActive", configuration, "validationRules", "createdAt")
     VALUES ($1, $2, $3, true, $4, $5, $6) RETURNING id`,
    [gatewayId, type, isRequired, JSON.stringify(configuration), validationRules && JSON.stringify(validationRules), createdAt],
  );
  return row.id;
}

const activeRows = async (ds: DataSource, gatewayId: string) =>
  ds.query(`SELECT id, type, "isRequired", configuration, "validationRules" FROM gateway_auth WHERE "gatewayId" = $1 AND "isActive" ORDER BY type`, [gatewayId]);

// The rules createDefaultAuth gives every new gateway.
const DEFAULT_RULES = { minKeyLength: 32, maxKeyLength: 128, keyFormat: '^[a-zA-Z0-9_-]+$' };

describeOrSkip('GatewayEndpointAccess with duplicate active auth rows (real Postgres)', () => {
  let ds: DataSource;
  let seed: { org: string; user: string; gateway: string };
  let jwtSeed: { org: string; user: string; gateway: string };
  let keyA: string;
  let keyB: string;
  let newerApiKeyRow: string;
  let newerJwtRow: string;

  beforeAll(async () => {
    ds = await migratedUpTo('gwauth_dupes');
    seed = await seedGateway(ds, 'dupes');
    keyA = await mintKey(ds, seed, 'first');
    keyB = await mintKey(ds, seed, 'second');
    // The auto-provisioned row, and a second one added later that reads the
    // key from its own header and query parameter with looser rules.
    await addAuth(ds, seed.gateway, 'api_key', '2026-01-01T00:00:00Z', { keyHeader: 'x-api-key', keyQuery: 'api_key', defaultScopes: ['gateway:use'] }, DEFAULT_RULES);
    newerApiKeyRow = await addAuth(ds, seed.gateway, 'api_key', '2026-02-01T00:00:00Z', { keyHeader: 'X-Gateway-Key', keyQuery: 'key' }, { minKeyLength: 16, maxKeyLength: 64 }, false);
    // Two managed-username rows. carol is on both, with a different password on each.
    const user = async (username: string, password: string) => ({ id: crypto.randomUUID(), username, passwordHash: await bcrypt.hash(password, 4), isActive: true });
    await addAuth(ds, seed.gateway, 'basic_auth', '2026-01-01T00:00:00Z', { users: [await user('alice', 'alice-password'), await user('carol', 'carol-old-password')] });
    await addAuth(ds, seed.gateway, 'basic_auth', '2026-03-01T00:00:00Z', { users: [await user('bob', 'bob-password'), await user('carol', 'carol-new-password')] });

    jwtSeed = await seedGateway(ds, 'jwtdupes');
    await addAuth(ds, jwtSeed.gateway, 'jwt', '2026-01-01T00:00:00Z', { secret: 'old-secret-old-secret-old-secret' });
    newerJwtRow = await addAuth(ds, jwtSeed.gateway, 'jwt', '2026-04-01T00:00:00Z', { secret: 'new-secret-new-secret-new-secret' });
  }, 180_000);

  afterAll(async () => {
    await ds?.query('DROP SCHEMA IF EXISTS gwauth_dupes CASCADE');
    await ds?.destroy();
  });

  it('runs, and leaves exactly one active row per gateway and type', async () => {
    await expect(runTarget(ds)).resolves.toBeUndefined();

    const rows = await activeRows(ds, seed.gateway);
    expect(rows.map((r: any) => r.type)).toEqual(['api_key', 'basic_auth']);
    const apiKeyRow = rows.find((r: any) => r.type === 'api_key');
    expect(apiKeyRow.id).toBe(newerApiKeyRow);
    // Required because the older row was; reads both rows' header and query.
    expect(apiKeyRow.isRequired).toBe(true);
    expect(apiKeyRow.configuration).toMatchObject({ keyHeader: 'X-Gateway-Key', keyQuery: 'key', additionalKeyHeaders: ['x-api-key'], additionalKeyQueries: ['api_key'] });
    // Only the restrictions both rows shared: the smaller minimum, the larger maximum, no keyFormat.
    expect(apiKeyRow.validationRules).toEqual({ minKeyLength: 16, maxKeyLength: 128 });

    const jwtRows = await activeRows(ds, jwtSeed.gateway);
    expect(jwtRows.map((r: any) => r.id)).toEqual([newerJwtRow]);
    expect(jwtRows[0].configuration.secret).toBe('new-secret-new-secret-new-secret');

    const parked = await ds.query(`SELECT metadata FROM gateway_auth WHERE "gatewayId" IN ($1, $2) AND NOT "isActive"`, [seed.gateway, jwtSeed.gateway]);
    expect(parked).toHaveLength(3);
    for (const row of parked) expect(row.metadata.deduplicatedBy).toBe('GatewayEndpointAccess1791000000000');
  });

  it('still lets both keys in, each the way its client sent it', async () => {
    const auth = authService(ds);
    const first = await auth.authenticateRequest(seed.gateway, { 'x-api-key': keyA }, {});
    expect(first).toMatchObject({ isValid: true, userId: seed.user, metadata: { keyName: 'first' } });
    const firstByQuery = await auth.authenticateRequest(seed.gateway, {}, { api_key: keyA });
    expect(firstByQuery).toMatchObject({ isValid: true, metadata: { keyName: 'first' } });
    const second = await auth.authenticateRequest(seed.gateway, { 'x-gateway-key': keyB }, {});
    expect(second).toMatchObject({ isValid: true, userId: seed.user, metadata: { keyName: 'second' } });
    const secondByQuery = await auth.authenticateRequest(seed.gateway, {}, { key: keyB });
    expect(secondByQuery).toMatchObject({ isValid: true, metadata: { keyName: 'second' } });

    // A key nobody minted is still refused.
    expect((await auth.authenticateRequest(seed.gateway, { 'x-api-key': gwKey() }, {})).isValid).toBe(false);
  });

  it('still lets every managed username in, with every password it had', async () => {
    const auth = authService(ds);
    const signIn = async (username: string, password: string) =>
      (await auth.authenticateRequest(seed.gateway, { authorization: basic(username, password) }, {})).isValid;
    expect(await signIn('alice', 'alice-password')).toBe(true);
    expect(await signIn('bob', 'bob-password')).toBe(true);
    expect(await signIn('carol', 'carol-old-password')).toBe(true);
    expect(await signIn('carol', 'carol-new-password')).toBe(true);
    expect(await signIn('bob', 'alice-password')).toBe(false);
  });

  it('brings the folded rows back on down, and up runs again', async () => {
    await runTarget(ds, 'down');
    const back = await ds.query(`SELECT type, count(*)::int AS n FROM gateway_auth WHERE "gatewayId" = $1 AND "isActive" GROUP BY type ORDER BY type`, [seed.gateway]);
    expect(back).toEqual([{ type: 'api_key', n: 2 }, { type: 'basic_auth', n: 2 }]);
    const markers = await ds.query(`SELECT count(*)::int AS n FROM gateway_auth WHERE metadata::jsonb ? 'deduplicatedBy'`);
    expect(markers[0].n).toBe(0);

    await expect(runTarget(ds)).resolves.toBeUndefined();
    expect((await activeRows(ds, seed.gateway)).map((r: any) => r.type)).toEqual(['api_key', 'basic_auth']);
    const auth = authService(ds);
    expect((await auth.authenticateRequest(seed.gateway, { 'x-api-key': keyA }, {})).isValid).toBe(true);
    expect((await auth.authenticateRequest(seed.gateway, { 'x-gateway-key': keyB }, {})).isValid).toBe(true);
  });
});

describeOrSkip('GatewayEndpointAccess with no duplicate auth rows (real Postgres)', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = await migratedUpTo('gwauth_nodupes');
  }, 180_000);

  afterAll(async () => {
    await ds?.query('DROP SCHEMA IF EXISTS gwauth_nodupes CASCADE');
    await ds?.destroy();
  });

  it('leaves every auth row exactly as it was', async () => {
    const seed = await seedGateway(ds, 'single');
    const key = await mintKey(ds, seed, 'only');
    await addAuth(ds, seed.gateway, 'api_key', '2026-01-01T00:00:00Z', { keyHeader: 'x-api-key', keyQuery: 'api_key', defaultScopes: ['gateway:use'] }, DEFAULT_RULES);
    await addAuth(ds, seed.gateway, 'oauth2', '2026-01-02T00:00:00Z', {}, {});
    // An inactive leftover of the same type is not a duplicate.
    const inactive = await addAuth(ds, seed.gateway, 'api_key', '2026-03-01T00:00:00Z', { keyHeader: 'x-other' });
    await ds.query(`UPDATE gateway_auth SET "isActive" = false WHERE id = $1`, [inactive]);
    const before = await ds.query(`SELECT * FROM gateway_auth ORDER BY id`);

    await expect(runTarget(ds)).resolves.toBeUndefined();

    const after = await ds.query(`SELECT * FROM gateway_auth ORDER BY id`);
    expect(after).toEqual(before);
    expect((await authService(ds).authenticateRequest(seed.gateway, { 'x-api-key': key }, {})).isValid).toBe(true);
  });
});
