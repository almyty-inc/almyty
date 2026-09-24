/**
 * Shared helper for TestAppModule-based DB integration specs.
 *
 * These specs run through TestAppModule, whose TypeORM DataSource builds
 * its schema by RUNNING THE MIGRATIONS (`migrationsRun: true`). When
 * several such specs run in parallel Jest workers against the same
 * Postgres schema, their interleaved DDL races and one file's beforeAll
 * intermittently blows up wholesale (every test failing together).
 * Isolating each spec into its own schema removes the race.
 *
 * Call `useIsolatedSchema('my_spec_test')` at module load time, BEFORE
 * `Test.createTestingModule(...).compile()` — TestAppModule reads
 * DATABASE_SCHEMA from ConfigService at DataSource-build time, so the
 * env var must already be set. `ensureSchema()` pre-creates the schema
 * because TypeORM's `dropSchema` + migrations assumes it exists.
 */
import { DataSource } from 'typeorm';

import { provisionExtensionsInPublic } from './test-db-extensions';

/**
 * Point TestAppModule's DataSource at a dedicated schema for this spec.
 * Must be invoked before the testing module compiles.
 */
export function useIsolatedSchema(schema: string): void {
  process.env.DATABASE_SCHEMA = schema;
}

/**
 * Pre-create the isolated schema via a throwaway connection so the
 * TestAppModule DataSource can dropSchema + run migrations into it, and
 * make sure the extensions those migrations need are in public.
 */
export async function ensureSchema(schema: string): Promise<void> {
  const bootstrap = new DataSource({
    type: 'postgres',
    host: process.env.DATABASE_HOST || 'localhost',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || 'password',
    database: process.env.DATABASE_NAME || 'almyty_test',
  });
  await bootstrap.initialize();
  try {
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    // The spec's migrations run with this schema first on the search_path,
    // so an extension they create would land here. Have them in public
    // first, whatever config this spec was started with.
    await provisionExtensionsInPublic((sql, params) => bootstrap.query(sql, params as any[]));
  } finally {
    await bootstrap.destroy();
  }
}
