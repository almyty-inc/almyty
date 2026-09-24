import { Client } from 'pg';

import { provisionExtensionsInPublic } from './test-db-extensions';

/**
 * Extension placement no longer depends on which spec migrates first.
 *
 * Runs against a database of its own, created and dropped here: moving
 * an extension is database-wide, and doing it in the shared test
 * database would pull functions out from under specs running in other
 * workers.
 */
const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;

const base = {
  host: process.env.DATABASE_HOST || 'localhost',
  port: Number(process.env.DATABASE_PORT || 5432),
  user: process.env.DATABASE_USERNAME || 'postgres',
  password: process.env.DATABASE_PASSWORD || 'password',
};
const DB = `ext_provision_${process.pid}`;

async function connect(searchPath?: string): Promise<Client> {
  const client = new Client({
    ...base,
    database: DB,
    ...(searchPath ? { options: `-c search_path=${searchPath}` } : {}),
  });
  await client.connect();
  return client;
}

describeIfDb('test database extensions are provisioned in public', () => {
  let admin: Client;

  beforeAll(async () => {
    admin = new Client({ ...base, database: process.env.DATABASE_NAME || 'almyty_test' });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
  });

  afterAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.end();
  });

  it('moves an extension the first spec created in its own schema back to public', async () => {
    // What the first migration does inside the first spec to run:
    // CREATE EXTENSION with that spec's schema first on the search_path.
    const first = await connect('spec_a,public');
    await first.query('CREATE SCHEMA spec_a');
    await first.query('CREATE SCHEMA spec_b');
    await first.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await first.end();

    // The next spec, in its own schema, cannot see the function.
    const second = await connect('spec_b,public');
    await expect(second.query('SELECT uuid_generate_v4()')).rejects.toThrow(/uuid_generate_v4\(\) does not exist/);
    await second.end();

    const setup = await connect();
    await provisionExtensionsInPublic((sql, params) => setup.query(sql, params as any[]));
    const placed = await setup.query(
      `SELECT e.extname, n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
        WHERE e.extname IN ('uuid-ossp', 'pg_trgm', 'vector') ORDER BY e.extname`,
    );
    await setup.end();
    expect(placed.rows).toEqual([
      { extname: 'pg_trgm', nspname: 'public' },
      { extname: 'uuid-ossp', nspname: 'public' },
      { extname: 'vector', nspname: 'public' },
    ]);

    const later = await connect('spec_b,public');
    const { rows } = await later.query('SELECT uuid_generate_v4() AS id');
    await later.end();
    expect(rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is idempotent', async () => {
    const setup = await connect();
    await provisionExtensionsInPublic((sql, params) => setup.query(sql, params as any[]));
    await provisionExtensionsInPublic((sql, params) => setup.query(sql, params as any[]));
    await setup.end();
  });
});
