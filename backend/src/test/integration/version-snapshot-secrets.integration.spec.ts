/**
 * Version snapshots never hold a secret (real Postgres).
 *
 * The version subscriber writes a serialized copy of every
 * @VersionedEntity on each save, and those rows outlive the entity's
 * current state. A credential's snapshots used to carry the secret it
 * held at the time, so rotating a leaked key left the old one in the
 * `version` table, readable through GET /versions. This saves a real
 * Credential through a DataSource with the real subscriber, rotates its
 * key, and reads the table back; then checks the migration that scrubs
 * rows written before the fix.
 *
 * Gated behind RUN_DB_INTEGRATION=1 with the standard DATABASE_* env vars;
 * builds its schema by running the migrations into an isolated schema.
 */
import { DataSource } from 'typeorm';
import { Version } from 'typeorm-versions';

import { Organization } from '../../entities/organization.entity';
import { Credential, CredentialType } from '../../entities/credential.entity';
import { CustomVersionSubscriber } from '../../common/custom-version-subscriber';
import { RedactVersionSnapshots1750810700000 } from '../../migrations/1750810700000-RedactVersionSnapshots';

const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'version_secrets_test';

jest.setTimeout(120_000);

const connection = {
  type: 'postgres' as const,
  host: process.env.DATABASE_HOST || '127.0.0.1',
  port: Number(process.env.DATABASE_PORT || 5432),
  username: process.env.DATABASE_USERNAME || 'postgres',
  password: process.env.DATABASE_PASSWORD || 'postgres',
  database: process.env.DATABASE_NAME || 'almyty_test',
};

describeIfDb('version snapshots keep no secrets (real Postgres)', () => {
  let ds: DataSource;

  beforeAll(async () => {
    const bootstrap = new DataSource(connection);
    await bootstrap.initialize();
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    // In public, as CI provisions them: created from inside the spec schema
    // they would be dropped with it and vanish for the next spec.
    await bootstrap.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await bootstrap.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await bootstrap.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await bootstrap.destroy();

    ds = new DataSource({
      ...connection,
      schema: SCHEMA,
      extra: { options: `-c search_path=${SCHEMA},public` },
      migrations: [__dirname + '/../../migrations/*{.ts,.js}'],
      migrationsRun: true,
      dropSchema: true,
      entities: [__dirname + '/../../entities/*.entity{.ts,.js}', Version],
      subscribers: [CustomVersionSubscriber],
      logging: false,
    });
    await ds.initialize();
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  async function organizationId(): Promise<string> {
    const repo = ds.getRepository(Organization);
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const saved = await repo.save(repo.create({ name: `version-secrets-${stamp}`, slug: `version-secrets-${stamp}` } as Partial<Organization>));
    return saved.id;
  }

  const snapshotsOf = async (itemId: string): Promise<string[]> =>
    (await ds.query(`SELECT "object" FROM "version" WHERE "itemType" = 'Credential' AND "itemId" = $1 ORDER BY "id"`, [itemId])).map(
      (row: { object: string }) => row.object,
    );

  it('writes neither the plaintext nor the ciphertext of a key, before or after rotation', async () => {
    const repo = ds.getRepository(Credential);
    const credential = repo.create({
      name: 'stripe',
      organizationId: await organizationId(),
      type: CredentialType.API_KEY,
      config: { apiKey: 'sk_live_first_secret', region: 'eu-west-1', headerName: 'X-Api-Key' },
    } as Partial<Credential>) as Credential;
    credential.encryptSensitiveData();
    const firstCiphertext = credential.config.apiKey;
    expect(firstCiphertext).toMatch(/^encrypted:/);
    await repo.save(credential);

    credential.config = { ...credential.config, apiKey: 'sk_live_rotated_secret' };
    credential.encryptSensitiveData();
    const secondCiphertext = credential.config.apiKey;
    await repo.save(credential);

    const snapshots = await snapshotsOf(credential.id);
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    for (const raw of snapshots) {
      expect(raw).not.toContain('sk_live_');
      expect(raw).not.toContain(firstCiphertext);
      expect(raw).not.toContain(secondCiphertext);
      expect(raw).not.toContain('encrypted:');
      // What is not a secret is still there to diff.
      const object = JSON.parse(raw);
      expect(object.name).toBe('stripe');
      expect(object.config.region).toBe('eu-west-1');
      expect(object.config).not.toHaveProperty('apiKey');
    }
  });

  it('scrubs snapshots written before the fix, and leaves clean ones alone', async () => {
    const dirty = {
      id: 'c-legacy',
      name: 'legacy',
      config: { apiKey: 'encrypted:gcm:aa:bb:cc', password: 'hunter2', bucket: 'models' },
      configuration: { maxTokens: 4096, bot_token: 'xoxb-legacy' },
    };
    const clean = { id: 'c-clean', name: 'clean', config: { region: 'us-east-1' } };
    const insert = async (itemId: string, object: unknown) =>
      (
        await ds.query(
          `INSERT INTO "version" ("itemType", "itemId", "event", "owner", "object", "timestamp") VALUES ('Credential', $1, 'UPDATE', 'system', $2, now()) RETURNING "id"`,
          [itemId, JSON.stringify(object)],
        )
      )[0].id;
    const dirtyId = await insert('c-legacy', dirty);
    const cleanId = await insert('c-clean', clean);
    const garbageId = await insert('c-garbage', 'x');
    await ds.query(`UPDATE "version" SET "object" = 'not json' WHERE "id" = $1`, [garbageId]);

    const runner = ds.createQueryRunner();
    try {
      await new RedactVersionSnapshots1750810700000().up(runner);
    } finally {
      await runner.release();
    }

    const read = async (id: number) => (await ds.query(`SELECT "object" FROM "version" WHERE "id" = $1`, [id]))[0].object;
    expect(JSON.parse(await read(dirtyId))).toEqual({
      id: 'c-legacy',
      name: 'legacy',
      config: { bucket: 'models' },
      configuration: { maxTokens: 4096 },
    });
    expect(await read(cleanId)).toBe(JSON.stringify(clean));
    expect(await read(garbageId)).toBe('not json');
  });
});
