import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

/**
 * The collapse-then-index migrations, against a real Postgres.
 *
 * Every migration in this repo that puts a unique index on a table which
 * may already violate it collapses the duplicates first -- because a
 * deployment that holds a collision is exactly the deployment the index
 * exists to protect, and creating it blind aborts a fail-closed deploy.
 * That much these two get right. What they get wrong is the tie-break.
 *
 * Both rank duplicates by `createdAt` alone, with a strict comparison. Every
 * `createdAt` in this schema defaults to `now()`, which in Postgres is
 * transaction-start time and therefore identical for every row written in
 * one transaction -- which is what a bulk sync or a seeder does. When two
 * duplicates tie, neither is older than the other, the DELETE removes
 * nothing, and the index creation fails anyway. The migrations that landed
 * either side of these two (SchemaImportIdempotency, CheckThenInsert-
 * Uniqueness, UniquenessParity) all order by the (createdAt, id) pair for
 * exactly this reason; these two were written without it.
 *
 * These run the migrations' ACTUAL statements, read out of the migration
 * files rather than retyped, so the tests cannot drift from what ships.
 */
function upStatements(file: string): string[] {
  const src = readFileSync(join(__dirname, '..', '..', 'migrations', file), 'utf8');
  const up = src.slice(src.indexOf('public async up'), src.indexOf('public async down'));
  const queries = [...up.matchAll(/await queryRunner\.query\(`\n([\s\S]*?)\n    `\)/g)].map((m) => m[1]);
  if (queries.length === 0) throw new Error(`no statements found in ${file} -- did up() change shape?`);
  return queries;
}

const describeOrSkip = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

const connect = async (schema: string) => {
  const db = new Client({
    host: process.env.DATABASE_HOST || 'localhost',
    port: Number(process.env.DATABASE_PORT || 5432),
    user: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || 'postgres',
    database: process.env.DATABASE_NAME || 'almyty_test',
  });
  await db.connect();
  await db.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await db.query(`SET search_path TO ${schema}`);
  return db;
};

describeOrSkip('catalog uniqueness migration (real Postgres)', () => {
  let db: Client;
  const statements = upStatements('1750793000000-CatalogUniqueness.ts');
  const run = async () => {
    for (const q of statements) await db.query(q);
  };

  beforeAll(async () => {
    db = await connect('catalogmig');
  }, 30_000);

  afterAll(async () => {
    await db.query('DROP SCHEMA IF EXISTS catalogmig CASCADE');
    await db.end();
  });

  beforeEach(async () => {
    await db.query('DROP TABLE IF EXISTS models');
    await db.query('DROP TABLE IF EXISTS model_versions');
    await db.query(`
      CREATE TABLE models (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "organizationId" uuid NOT NULL,
        "providerId" uuid,
        "vendorModelId" text NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )`);
    await db.query(`
      CREATE TABLE model_versions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "organizationId" uuid NOT NULL,
        "registryUri" text NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )`);
  });

  const ORG = '11111111-1111-1111-1111-111111111111';
  const PROVIDER = '22222222-2222-2222-2222-222222222222';

  const models = async () =>
    (await db.query(`SELECT id, "providerId", "vendorModelId" FROM models ORDER BY "createdAt", id`)).rows;

  it('collapses duplicate cards that a single sync wrote in one transaction', async () => {
    // The case that aborts the deploy. `syncFromProvider` inserts the cards
    // it did not find in its snapshot; two of them landing in one
    // transaction share `now()` to the microsecond, so ordering by age
    // alone cannot tell them apart.
    await db.query('BEGIN');
    await db.query(
      `INSERT INTO models ("organizationId","providerId","vendorModelId") VALUES ($1,$2,'gpt-4o'), ($1,$2,'gpt-4o')`,
      [ORG, PROVIDER],
    );
    await db.query('COMMIT');
    expect((await db.query(`SELECT count(DISTINCT "createdAt") AS n FROM models`)).rows[0].n).toBe('1');

    await expect(run()).resolves.not.toThrow();
    expect(await models()).toHaveLength(1);
  });

  it('collapses duplicate versions a double-click registered in one transaction', async () => {
    await db.query('BEGIN');
    await db.query(
      `INSERT INTO model_versions ("organizationId","registryUri") VALUES ($1,'s3://weights/a'), ($1,'s3://weights/a')`,
      [ORG],
    );
    await db.query('COMMIT');

    await expect(run()).resolves.not.toThrow();
    expect((await db.query(`SELECT id FROM model_versions`)).rows).toHaveLength(1);
  });

  it('keeps the oldest row when the timestamps do differ', async () => {
    const { rows } = await db.query(
      `INSERT INTO models ("organizationId","providerId","vendorModelId","createdAt") VALUES
         ($1,$2,'claude','2026-01-01'), ($1,$2,'claude','2026-06-01') RETURNING id, "createdAt"`,
      [ORG, PROVIDER],
    );
    const oldest = rows[0].id;
    await run();
    expect((await models()).map((r) => r.id)).toEqual([oldest]);
  });

  it('does not delete endpoint-only cards the index would have allowed', async () => {
    // Two cards with no provider are not a collision: the unique index is
    // on (organizationId, providerId, vendorModelId) and Postgres treats
    // NULLs as distinct, so both rows are legal. Folding them anyway
    // destroys a card nobody asked to lose. (1750802 later constrains
    // these on name, which is a different key.)
    await db.query(
      `INSERT INTO models ("organizationId","providerId","vendorModelId","createdAt") VALUES
         ($1,NULL,'llama-3','2026-01-01'), ($1,NULL,'llama-3','2026-06-01')`,
      [ORG],
    );
    await run();
    expect(await models()).toHaveLength(2);
  });

  it('leaves a catalogue with no duplicates completely alone', async () => {
    await db.query(
      `INSERT INTO models ("organizationId","providerId","vendorModelId") VALUES ($1,$2,'a'), ($1,$2,'b')`,
      [ORG, PROVIDER],
    );
    await run();
    expect(await models()).toHaveLength(2);
  });

  it('is idempotent: running it twice changes nothing the second time', async () => {
    await db.query('BEGIN');
    await db.query(
      `INSERT INTO models ("organizationId","providerId","vendorModelId") VALUES ($1,$2,'again'), ($1,$2,'again')`,
      [ORG, PROVIDER],
    );
    await db.query('COMMIT');
    await run();
    const first = await models();
    await expect(run()).resolves.not.toThrow();
    expect(await models()).toEqual(first);
  });
});

describeOrSkip('tool template publishing migration (real Postgres)', () => {
  let db: Client;
  const statements = upStatements('1750807000000-ToolTemplatePublishing.ts');
  const run = async () => {
    for (const q of statements) await db.query(q);
  };

  beforeAll(async () => {
    db = await connect('tmplmig');
  }, 30_000);

  afterAll(async () => {
    await db.query('DROP SCHEMA IF EXISTS tmplmig CASCADE');
    await db.end();
  });

  beforeEach(async () => {
    await db.query('DROP TABLE IF EXISTS tool_templates');
    await db.query(`
      CREATE TABLE tool_templates (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "organizationId" uuid,
        "name" text NOT NULL,
        "visibility" character varying(20) NOT NULL DEFAULT 'public',
        "createdAt" timestamp NOT NULL DEFAULT now()
      )`);
  });

  const ORG = '33333333-3333-3333-3333-333333333333';
  const names = async () =>
    (await db.query(`SELECT id, "organizationId", "name" FROM tool_templates ORDER BY "createdAt", id`)).rows;

  it('collapses public templates two booting replicas seeded at the same instant', async () => {
    // seedPublicToolTemplates is a check-then-insert loop that every replica
    // runs at boot, so two pods coming up together both find no row and both
    // insert. Written in one transaction the two rows share `now()` exactly.
    await db.query('BEGIN');
    await db.query(`INSERT INTO tool_templates ("organizationId","name") VALUES (NULL,'weather'), (NULL,'weather')`);
    await db.query('COMMIT');

    await expect(run()).resolves.not.toThrow();
    expect(await names()).toHaveLength(1);
  });

  it('collapses an organization\'s duplicate templates written in one transaction', async () => {
    await db.query('BEGIN');
    await db.query(`INSERT INTO tool_templates ("organizationId","name") VALUES ($1,'invoice'), ($1,'invoice')`, [ORG]);
    await db.query('COMMIT');

    await expect(run()).resolves.not.toThrow();
    expect(await names()).toHaveLength(1);
  });

  it('keeps the oldest row when the timestamps do differ', async () => {
    const { rows } = await db.query(
      `INSERT INTO tool_templates ("organizationId","name","createdAt") VALUES
         (NULL,'search','2026-01-01'), (NULL,'search','2026-06-01') RETURNING id`,
    );
    await run();
    expect((await names()).map((r) => r.id)).toEqual([rows[0].id]);
  });

  it('does not treat one organization\'s name as a collision with another\'s', async () => {
    const other = '44444444-4444-4444-4444-444444444444';
    await db.query(`INSERT INTO tool_templates ("organizationId","name") VALUES ($1,'shared'), ($2,'shared')`, [
      ORG,
      other,
    ]);
    await db.query(`INSERT INTO tool_templates ("organizationId","name") VALUES (NULL,'shared')`);
    await run();
    expect(await names()).toHaveLength(3);
  });

  it('is idempotent: running it twice changes nothing the second time', async () => {
    await db.query('BEGIN');
    await db.query(`INSERT INTO tool_templates ("organizationId","name") VALUES (NULL,'again'), (NULL,'again')`);
    await db.query('COMMIT');
    await run();
    const first = await names();
    await expect(run()).resolves.not.toThrow();
    expect(await names()).toEqual(first);
  });
});
