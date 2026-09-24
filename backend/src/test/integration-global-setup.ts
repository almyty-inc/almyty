import { Client } from 'pg';

import { provisionExtensionsInPublic } from './integration/test-db-extensions';

/**
 * Jest globalSetup: runs once, before any worker starts.
 *
 * For a DB-integration run it provisions the Postgres extensions in
 * `public`, so which spec's migrations happen to run first no longer
 * decides where `uuid_generate_v4()` lives (see test-db-extensions.ts).
 * A plain unit run does nothing here.
 */
export default async function globalSetup(): Promise<void> {
  if (process.env.RUN_DB_INTEGRATION !== '1') return;
  const client = new Client({
    host: process.env.DATABASE_HOST || 'localhost',
    port: Number(process.env.DATABASE_PORT || 5432),
    user: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || 'password',
    database: process.env.DATABASE_NAME || 'almyty_test',
  });
  await client.connect();
  try {
    await provisionExtensionsInPublic((sql, params) => client.query(sql, params as any[]));
  } finally {
    await client.end();
  }
}
