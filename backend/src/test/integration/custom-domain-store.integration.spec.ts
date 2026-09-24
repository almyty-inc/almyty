import { readFileSync } from 'fs';
import { join } from 'path';
import { DataSource } from 'typeorm';

import { PgCustomDomainStore } from '../../modules/gateways/channels/custom-domain.service';
import { newCustomDomain, type CustomDomainConfig } from '../../modules/gateways/channels/custom-domain';

/**
 * The custom-domain store's SQL against a real Postgres, with the unique
 * index created from the migration's own statement (read out of the file,
 * not retyped, so the two cannot drift).
 */
const MIGRATION = join(__dirname, '..', '..', 'migrations', '1750810000000-HostedChatCustomDomainUniqueness.ts');
const indexStatement = (): string => {
  const src = readFileSync(MIGRATION, 'utf8');
  const match = src.match(/await queryRunner\.query\(`\n([\s\S]*?CREATE UNIQUE INDEX[\s\S]*?)\n    `\);/);
  if (!match) throw new Error('index statement not found in the migration');
  return match[1];
};

const describeOrSkip = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;
const SCHEMA = 'customdomain_store';

describeOrSkip('PgCustomDomainStore (real Postgres)', () => {
  let ds: DataSource;
  let store: PgCustomDomainStore;
  const ORG_A = '00000000-0000-4000-8000-00000000000a';
  const ORG_B = '00000000-0000-4000-8000-00000000000b';
  const GW_A = '10000000-0000-4000-8000-00000000000a';
  const GW_B = '10000000-0000-4000-8000-00000000000b';

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      host: process.env.DATABASE_HOST || 'localhost',
      port: Number(process.env.DATABASE_PORT || 5432),
      username: process.env.DATABASE_USERNAME || 'postgres',
      password: process.env.DATABASE_PASSWORD || 'postgres',
      database: process.env.DATABASE_NAME || 'almyty_test',
      // Every pooled connection, not just the first, resolves unqualified
      // names into this spec's own schema.
      extra: { options: `-c search_path=${SCHEMA}` },
    });
    await ds.initialize();
    await ds.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await ds.query(`CREATE SCHEMA ${SCHEMA}`);
    await ds.query(`
      CREATE TABLE "gateways" (
        "id" uuid PRIMARY KEY,
        "organizationId" uuid NOT NULL,
        "type" text NOT NULL,
        "configuration" json NOT NULL
      )`);
    await ds.query(indexStatement());
    // The store only ever calls repository.query, which is DataSource.query.
    store = new PgCustomDomainStore({ query: (sql: string, params?: any[]) => ds.query(sql, params) } as any);
  }, 30_000);

  afterAll(async () => {
    await ds.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await ds.destroy();
  });

  beforeEach(async () => {
    await ds.query(`DELETE FROM "gateways"`);
    await ds.query(
      `INSERT INTO "gateways" VALUES ($1, $2, 'hosted_chat', '{"hostedChat":{"slug":"acme"},"allowedOrigins":[]}'),
                                     ($3, $4, 'hosted_chat', '{"hostedChat":{"slug":"bravo"}}')`,
      [GW_A, ORG_A, GW_B, ORG_B],
    );
  });

  const stored = async (id: string) =>
    (await ds.query(`SELECT "configuration" FROM "gateways" WHERE id = $1`, [id]))[0].configuration;

  it('writes only the customDomain key and leaves the rest of the configuration alone', async () => {
    const claim = newCustomDomain('chat.acme.com');
    await store.write(GW_A, ORG_A, claim);
    expect(await stored(GW_A)).toEqual({ hostedChat: { slug: 'acme' }, allowedOrigins: [], customDomain: claim });
    await store.write(GW_A, ORG_A, null);
    expect(await stored(GW_A)).toEqual({ hostedChat: { slug: 'acme' }, allowedOrigins: [] });
  });

  it("never writes another organization's gateway", async () => {
    await store.write(GW_A, ORG_B, newCustomDomain('chat.acme.com'));
    expect((await stored(GW_A)).customDomain).toBeUndefined();
  });

  it('replaceClaim is a compare-and-set on hostname and token', async () => {
    const claim = newCustomDomain('chat.acme.com');
    await store.write(GW_A, ORG_A, claim);
    const active: CustomDomainConfig = { ...claim, status: 'active', verifiedAt: new Date().toISOString() };

    await expect(store.replaceClaim(GW_A, ORG_A, { ...claim, verificationToken: 'other' }, active)).resolves.toBe('stale');
    await expect(store.replaceClaim(GW_A, ORG_B, claim, active)).resolves.toBe('stale');
    await expect(store.replaceClaim(GW_A, ORG_A, claim, active)).resolves.toBe('ok');
    expect((await stored(GW_A)).customDomain.status).toBe('active');
  });

  it('refuses a second ACTIVE owner of a hostname, from any organization', async () => {
    const a = newCustomDomain('chat.shared.com');
    const b = newCustomDomain('chat.shared.com');
    await store.write(GW_A, ORG_A, a);
    await store.write(GW_B, ORG_B, b); // two pending claims coexist
    await expect(store.replaceClaim(GW_A, ORG_A, a, { ...a, status: 'active' })).resolves.toBe('ok');
    await expect(store.replaceClaim(GW_B, ORG_B, b, { ...b, status: 'active' })).resolves.toBe('conflict');
    expect((await stored(GW_B)).customDomain.status).toBe('pending_verification');

    await expect(store.activeElsewhere('chat.shared.com', GW_B)).resolves.toBe(true);
    await expect(store.activeElsewhere('chat.shared.com', GW_A)).resolves.toBe(false);
  });

  it('of two surfaces activating one hostname at the same moment, exactly one wins', async () => {
    const a = newCustomDomain('race.shared.com');
    const b = newCustomDomain('race.shared.com');
    await store.write(GW_A, ORG_A, a);
    await store.write(GW_B, ORG_B, b);
    const results = await Promise.all([
      store.replaceClaim(GW_A, ORG_A, a, { ...a, status: 'active' }),
      store.replaceClaim(GW_B, ORG_B, b, { ...b, status: 'active' }),
    ]);
    expect(results.sort()).toEqual(['conflict', 'ok']);
  });
});
