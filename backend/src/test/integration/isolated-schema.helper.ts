/**
 * Shared helper for TestAppModule-based DB integration specs.
 *
 * These specs run through TestAppModule, whose TypeORM DataSource is
 * configured with `synchronize: true`. When several such specs run in
 * parallel Jest workers against the same Postgres schema, their
 * interleaved CREATE/ALTER/DROP TABLE cycles race and one file's
 * beforeAll intermittently blows up wholesale (every test failing
 * together). Isolating each spec into its own schema removes the race.
 *
 * Call `useIsolatedSchema('my_spec_test')` at module load time, BEFORE
 * `Test.createTestingModule(...).compile()` — TestAppModule reads
 * DATABASE_SCHEMA from ConfigService at DataSource-build time, so the
 * env var must already be set. `ensureSchema()` pre-creates the schema
 * because TypeORM's `dropSchema + synchronize` assumes it exists.
 */
import { DataSource } from 'typeorm';

/**
 * Point TestAppModule's DataSource at a dedicated schema for this spec.
 * Must be invoked before the testing module compiles.
 */
export function useIsolatedSchema(schema: string): void {
  process.env.DATABASE_SCHEMA = schema;
}

/**
 * Pre-create the isolated schema via a throwaway connection so the
 * TestAppModule DataSource can dropSchema + synchronize into it.
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
  } finally {
    await bootstrap.destroy();
  }
}
