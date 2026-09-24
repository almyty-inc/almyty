/**
 * The Postgres extensions the migrations need, provisioned in `public`.
 *
 * Every DB-integration spec runs the migrations into a schema of its own
 * with `search_path=<schema>,public`, and the first migration says
 * `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"` with no schema. An
 * extension is database-wide but its functions live in ONE schema: the
 * first on the search_path of whichever spec got there first. Every
 * other spec's `IF NOT EXISTS` was then a no-op and its tables' default
 * `uuid_generate_v4()` did not resolve -- so `quota-race` failed with
 * "function uuid_generate_v4() does not exist" whenever
 * `import-schema-with-tools` happened to run before it, and passed
 * otherwise.
 *
 * Provisioning them in `public` before any spec runs (the jest
 * globalSetup, and scripts/ensure-test-db.js) makes the order irrelevant:
 * `public` is on every spec's search_path, and a migration's
 * `IF NOT EXISTS` finds them already there. An extension a previous run
 * left in some spec's schema is moved back.
 */
export const TEST_DB_EXTENSIONS = ['uuid-ossp', 'pg_trgm', 'vector'] as const;

type Query = (sql: string, params?: unknown[]) => Promise<unknown>;

function rowsOf(result: unknown): Array<Record<string, any>> {
  if (Array.isArray(result)) return result as Array<Record<string, any>>;
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, any>>) : [];
}

export async function provisionExtensionsInPublic(query: Query): Promise<void> {
  for (const extension of TEST_DB_EXTENSIONS) {
    const found = rowsOf(
      await query(
        `SELECT n.nspname AS schema FROM pg_extension e
           JOIN pg_namespace n ON n.oid = e.extnamespace
          WHERE e.extname = $1`,
        [extension],
      ),
    );
    if (found.length === 0) {
      await query(`CREATE EXTENSION IF NOT EXISTS "${extension}" WITH SCHEMA public`);
    } else if (found[0].schema !== 'public') {
      await query(`ALTER EXTENSION "${extension}" SET SCHEMA public`);
    }
  }
}

/** Every test extension that exists somewhere other than `public`. */
export async function extensionsOutsidePublic(
  query: Query,
): Promise<Array<{ extension: string; schema: string }>> {
  const rows = rowsOf(
    await query(
      `SELECT e.extname AS extension, n.nspname AS schema FROM pg_extension e
         JOIN pg_namespace n ON n.oid = e.extnamespace
        WHERE e.extname = ANY($1) AND n.nspname <> 'public'
        ORDER BY e.extname`,
      [[...TEST_DB_EXTENSIONS]],
    ),
  );
  return rows.map((r) => ({ extension: String(r.extension), schema: String(r.schema) }));
}

/**
 * The shared test database's connection settings, the same defaults the
 * globalSetup and scripts/ensure-test-db.js use.
 */
export function testDbConnection(): {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
} {
  return {
    host: process.env.DATABASE_HOST || 'localhost',
    port: Number(process.env.DATABASE_PORT || 5432),
    user: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || 'password',
    database: process.env.DATABASE_NAME || 'almyty_test',
  };
}

/**
 * Throws when a test extension has left `public`. Run after every
 * DB-integration spec file (src/test/setup.ts): a spec whose migrations
 * or DDL put an extension in its own schema fails right there, instead of
 * a later spec failing with "function uuid_generate_v4() does not exist".
 */
export async function assertExtensionsInPublic(specPath: string): Promise<void> {
  // Required here, not imported: the setup file loads this module for every
  // unit spec too, and a unit run needs no Postgres driver.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Client } = require('pg');
  const client = new Client(testDbConnection());
  await client.connect();
  try {
    const misplaced = await extensionsOutsidePublic((sql, params) => client.query(sql, params));
    if (misplaced.length > 0) {
      throw new Error(
        `${specPath} left Postgres extensions outside public: ` +
          misplaced.map((m) => `${m.extension} in ${m.schema}`).join(', ') +
          '. Integration specs create extensions only WITH SCHEMA public (see test-db-extensions.ts).',
      );
    }
  } finally {
    await client.end();
  }
}
