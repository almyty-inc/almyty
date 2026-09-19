import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

/**
 * The request-log tenancy migration, against a real Postgres.
 *
 * The migration backfills `request_logs.organizationId` from two sources and
 * then adds a foreign key to `organizations`. The gateway-sourced half is
 * safe -- a gateway cannot name an organization that does not exist. The
 * metadata-sourced half is not: it copies whatever uuid the interceptor
 * stashed in `metadata.organizationId`, and the rows it exists to serve are
 * exactly the rows whose gateway is already gone. The commonest reason a
 * gateway is gone is that its organization was deleted, which cascaded the
 * gateway away and left this row behind with `gatewayId` set to null and a
 * dead organization id still in its metadata. Backfilling that id and then
 * adding the foreign key is a 23503 on the deployment the key is meant to
 * protect -- and the deploy is fail-closed, so nothing rolls out.
 *
 * These run the migration's ACTUAL statements, read out of the migration
 * file rather than retyped, so the test cannot drift from what ships.
 */
const MIGRATION = join(__dirname, '..', '..', 'migrations', '1750796000000-RequestLogOrganization.ts');

function statementsFromMigration(): string[] {
  const src = readFileSync(MIGRATION, 'utf8');
  const up = src.slice(src.indexOf('public async up'), src.indexOf('public async down'));
  const queries = [...up.matchAll(/await queryRunner\.query\(`\n([\s\S]*?)\n    `\)/g)].map((m) => m[1]);
  if (queries.length < 4) throw new Error('migration statements not found -- did up() change shape?');
  return queries;
}

const describeOrSkip = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

describeOrSkip('request-log organization migration (real Postgres)', () => {
  let db: Client;
  const statements = statementsFromMigration();
  // Everything up to and including the request_logs foreign key. The
  // usage_metrics half runs against a table this fixture does not build.
  const upToRequestLogFk = statements.slice(
    0,
    statements.findIndex((q) => q.includes('FK_request_logs_organizationId')) + 1,
  );

  beforeAll(async () => {
    db = new Client({
      host: process.env.DATABASE_HOST || 'localhost',
      port: Number(process.env.DATABASE_PORT || 5432),
      user: process.env.DATABASE_USERNAME || 'postgres',
      password: process.env.DATABASE_PASSWORD || 'postgres',
      database: process.env.DATABASE_NAME || 'almyty_test',
    });
    await db.connect();
    await db.query('CREATE SCHEMA IF NOT EXISTS reqlogmig');
    await db.query('SET search_path TO reqlogmig');
  }, 30_000);

  afterAll(async () => {
    await db.query('DROP SCHEMA IF EXISTS reqlogmig CASCADE');
    await db.end();
  });

  beforeEach(async () => {
    await db.query('DROP TABLE IF EXISTS request_logs');
    await db.query('DROP TABLE IF EXISTS gateways');
    await db.query('DROP TABLE IF EXISTS organizations');
    await db.query(`CREATE TABLE organizations (id uuid PRIMARY KEY DEFAULT gen_random_uuid())`);
    await db.query(`
      CREATE TABLE gateways (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "organizationId" uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE
      )`);
    // The pre-migration shape: no organizationId column, gatewayId nulled
    // out when the gateway goes.
    await db.query(`
      CREATE TABLE request_logs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "gatewayId" uuid REFERENCES gateways(id) ON DELETE SET NULL,
        "metadata" json,
        "timestamp" timestamp NOT NULL DEFAULT now()
      )`);
  });

  const org = async () => (await db.query(`INSERT INTO organizations DEFAULT VALUES RETURNING id`)).rows[0].id as string;
  const gateway = async (orgId: string) =>
    (await db.query(`INSERT INTO gateways ("organizationId") VALUES ($1) RETURNING id`, [orgId])).rows[0].id as string;
  const log = async (gatewayId: string | null, metaOrg: string | null) =>
    (
      await db.query(`INSERT INTO request_logs ("gatewayId", "metadata") VALUES ($1, $2::json) RETURNING id`, [
        gatewayId,
        metaOrg === null ? null : JSON.stringify({ organizationId: metaOrg }),
      ])
    ).rows[0].id as string;

  const runMigration = async () => {
    for (const q of upToRequestLogFk) await db.query(q);
  };

  const owner = async (id: string) =>
    (await db.query(`SELECT "organizationId" FROM request_logs WHERE id = $1`, [id])).rows[0].organizationId as
      | string
      | null;

  it('does not abort when a log remembers an organization that has since been deleted', async () => {
    // The shape that kills the deploy. The organization is deleted, which
    // cascades its gateway away and nulls this row's gatewayId; the dead
    // organization id survives in metadata, which is the only source the
    // migration has for rows like this one.
    const doomed = await org();
    const gw = await gateway(doomed);
    const orphan = await log(gw, doomed);
    await db.query(`DELETE FROM organizations WHERE id = $1`, [doomed]);

    await expect(runMigration()).resolves.not.toThrow();

    // The row keeps its place in the table; it simply has no owner to name.
    expect(await owner(orphan)).toBeNull();
  });

  it('still takes the owner from the gateway when there is one', async () => {
    const live = await org();
    const gw = await gateway(live);
    const id = await log(gw, null);
    await runMigration();
    expect(await owner(id)).toBe(live);
  });

  it('still recovers the owner from metadata when the gateway is gone but the organization is not', async () => {
    // A gateway deleted on its own: the organization is alive and the
    // metadata is the only remaining evidence of who the row belongs to.
    const live = await org();
    const gw = await gateway(live);
    const id = await log(gw, live);
    await db.query(`DELETE FROM gateways WHERE id = $1`, [gw]);
    await runMigration();
    expect(await owner(id)).toBe(live);
  });

  it('ignores metadata that is not a uuid at all', async () => {
    const id = await log(null, 'not-a-uuid');
    await expect(runMigration()).resolves.not.toThrow();
    expect(await owner(id)).toBeNull();
  });

  it('is idempotent: running it twice changes nothing the second time', async () => {
    const live = await org();
    const gw = await gateway(live);
    const kept = await log(gw, null);
    const doomed = await org();
    const deadGw = await gateway(doomed);
    const orphan = await log(deadGw, doomed);
    await db.query(`DELETE FROM organizations WHERE id = $1`, [doomed]);

    await runMigration();
    const first = [await owner(kept), await owner(orphan)];
    await runMigration();
    expect([await owner(kept), await owner(orphan)]).toEqual(first);
  });
});
