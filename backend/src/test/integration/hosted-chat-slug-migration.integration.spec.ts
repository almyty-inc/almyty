import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

/**
 * The hosted-chat slug migration, against a real Postgres.
 *
 * This migration aborted the staging deploy: it created the unique index
 * without resolving existing collisions, and a deployment that already holds
 * one is exactly the deployment the index exists to protect. The deploy is
 * fail-closed, so nothing rolled out.
 *
 * These run the migration's ACTUAL statements, read out of the migration
 * file rather than retyped, so the test cannot drift away from what ships.
 */
const MIGRATION = join(__dirname, '..', '..', 'migrations', '1750797000000-HostedChatSlugUniqueness.ts');

function statementsFromMigration(): { dedupe: string; index: string } {
  const src = readFileSync(MIGRATION, 'utf8');
  const queries = [...src.matchAll(/await queryRunner\.query\(`\n([\s\S]*?)\n    `\);/g)].map((m) => m[1]);
  const dedupe = queries.find((q) => q.includes('DO $$'));
  const index = queries.find((q) => q.includes('CREATE UNIQUE INDEX'));
  if (!dedupe || !index) throw new Error('migration statements not found — did up() change shape?');
  return { dedupe, index };
}

const describeOrSkip = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

describeOrSkip('hosted-chat slug uniqueness migration (real Postgres)', () => {
  let db: Client;
  const { dedupe, index } = statementsFromMigration();

  beforeAll(async () => {
    db = new Client({
      host: process.env.DATABASE_HOST || 'localhost',
      port: Number(process.env.DATABASE_PORT || 5432),
      user: process.env.DATABASE_USERNAME || 'postgres',
      password: process.env.DATABASE_PASSWORD || 'postgres',
      database: process.env.DATABASE_NAME || 'almyty_test',
    });
    await db.connect();
    await db.query('CREATE SCHEMA IF NOT EXISTS slugmig');
    await db.query('SET search_path TO slugmig');
  }, 30_000);

  afterAll(async () => {
    await db.query('DROP SCHEMA IF EXISTS slugmig CASCADE');
    await db.end();
  });

  beforeEach(async () => {
    await db.query('DROP TABLE IF EXISTS gateways');
    await db.query(`
      CREATE TABLE gateways (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "type" text NOT NULL,
        "status" text NOT NULL,
        "configuration" json NOT NULL,
        "createdAt" timestamptz NOT NULL
      )`);
  });

  const add = async (opts: { id?: string; status: string; slug: string | null; createdAt: string; type?: string }) => {
    const { rows } = await db.query(
      `INSERT INTO gateways (${opts.id ? 'id,' : ''} "type", "status", "configuration", "createdAt")
       VALUES (${opts.id ? '$5,' : ''} $4, $1, $2::json, $3) RETURNING id`,
      [
        opts.status,
        opts.slug === null ? '{"hostedChat":{}}' : JSON.stringify({ hostedChat: { slug: opts.slug } }),
        opts.createdAt,
        opts.type ?? 'hosted_chat',
        ...(opts.id ? [opts.id] : []),
      ],
    );
    return rows[0].id as string;
  };

  const runMigration = async () => {
    await db.query(dedupe);
    await db.query(index);
  };

  const slugs = async () => {
    const { rows } = await db.query(
      `SELECT id, "status", ("configuration" -> 'hostedChat' ->> 'slug') AS slug
         FROM gateways ORDER BY "createdAt", id`,
    );
    return rows as Array<{ id: string; status: string; slug: string | null }>;
  };

  it('leaves a deployment with no collisions completely alone', async () => {
    await add({ status: 'active', slug: 'alpha', createdAt: '2026-01-01' });
    await add({ status: 'active', slug: 'beta', createdAt: '2026-02-01' });
    await runMigration();
    expect((await slugs()).map((r) => r.slug)).toEqual(['alpha', 'beta']);
  });

  it('gives the address to the active claimant, not merely the oldest', async () => {
    // The case that matters: the first claimant was deactivated and a later
    // one is serving live traffic. Ordering by age alone would take the
    // public address off the running app and hand it to a dead row.
    const dead = await add({ status: 'inactive', slug: 'care', createdAt: '2026-01-01' });
    const live = await add({ status: 'active', slug: 'care', createdAt: '2026-06-01' });
    await runMigration();
    const byId = Object.fromEntries((await slugs()).map((r) => [r.id, r.slug]));
    expect(byId[live]).toBe('care');
    expect(byId[dead]).not.toBe('care');
  });

  it('among equals the earliest keeps it, and every loser keeps its row', async () => {
    await add({ status: 'active', slug: 'acme', createdAt: '2026-01-01' });
    await add({ status: 'active', slug: 'acme', createdAt: '2026-02-01' });
    await add({ status: 'active', slug: 'acme', createdAt: '2026-03-01' });
    await runMigration();
    const rows = await slugs();
    expect(rows).toHaveLength(3);
    expect(rows[0].slug).toBe('acme');
    expect(new Set(rows.map((r) => r.slug)).size).toBe(3);
  });

  it('does not hand a loser a suffix somebody already holds', async () => {
    // The naive `<slug>-<first 8 of id>` is not collision-proof: another
    // gateway can already be sitting on exactly that name, and the index
    // creation then fails anyway. This is the case Codex flagged.
    const id = '11111111-2222-3333-4444-555555555555';
    await add({ status: 'active', slug: 'shop', createdAt: '2026-01-01' });
    await add({ id, status: 'active', slug: 'shop', createdAt: '2026-02-01' });
    await add({ status: 'active', slug: `shop-${id.slice(0, 8)}`, createdAt: '2026-03-01' });

    await runMigration();

    const rows = await slugs();
    expect(rows).toHaveLength(3);
    // Everything unique, and the pre-existing claimant kept its name.
    expect(new Set(rows.map((r) => r.slug)).size).toBe(3);
    expect(rows.map((r) => r.slug)).toContain(`shop-${id.slice(0, 8)}`);
    expect(rows.find((r) => r.id === id)!.slug).not.toBe(`shop-${id.slice(0, 8)}`);
  });

  it('ignores rows that are not hosted chat, and rows with no slug', async () => {
    await add({ status: 'active', slug: 'dup', createdAt: '2026-01-01' });
    await add({ status: 'active', slug: 'dup', createdAt: '2026-02-01' });
    await add({ status: 'active', slug: null, createdAt: '2026-03-01' });
    await add({ status: 'active', slug: 'dup', createdAt: '2026-04-01', type: 'mcp' });
    await runMigration();
    const rows = await slugs();
    // The mcp row keeps 'dup' — the index is scoped to hosted_chat, so it is
    // not a collision and must not be renamed.
    expect(rows.filter((r) => r.slug === 'dup')).toHaveLength(2);
  });

  it('is idempotent: running it twice changes nothing the second time', async () => {
    await add({ status: 'active', slug: 'again', createdAt: '2026-01-01' });
    await add({ status: 'active', slug: 'again', createdAt: '2026-02-01' });
    await runMigration();
    const first = await slugs();
    await runMigration();
    expect(await slugs()).toEqual(first);
  });
});
