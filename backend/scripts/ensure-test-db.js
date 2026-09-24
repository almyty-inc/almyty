#!/usr/bin/env node
/**
 * Bootstrap the database `npm run test:full` / `npm run test:db` need.
 *
 * These two scripts used to be unrunnable: they pointed at a user and a
 * database that existed nowhere, so nobody ran them and fifteen
 * DB-integration suites drifted unnoticed while a local "green" from
 * plain `npm test` (which skips them) looked like full coverage.
 *
 * CI does not have this problem — the Postgres service container in
 * .github/workflows/ci.yml is created with POSTGRES_DB=almyty_test and
 * a step pre-creates the extensions. Locally nothing did. This script
 * is the local equivalent, so `test:full` means the same thing in both
 * places.
 *
 * Expects a Postgres reachable at DATABASE_HOST:DATABASE_PORT — e.g.
 * the one `scripts/dev-stack.sh up` starts on 5433. Idempotent.
 */
'use strict';

const { Client } = require('pg');

const host = process.env.DATABASE_HOST || '127.0.0.1';
const port = Number(process.env.DATABASE_PORT || 5432);
const user = process.env.DATABASE_USERNAME || 'postgres';
const password = process.env.DATABASE_PASSWORD || 'postgres';
const database = process.env.DATABASE_NAME || 'almyty_test';

// The DB-integration specs each run migrations into their own schema
// (see src/test/integration/isolated-schema.helper.ts) so parallel Jest
// workers don't race each other's DDL. The extensions, though, are
// database-wide and must exist before any migration runs.
const EXTENSIONS = ['vector', 'pg_trgm', 'uuid-ossp'];

async function main() {
  const admin = new Client({ host, port, user, password, database: 'postgres' });
  try {
    await admin.connect();
  } catch (err) {
    console.error(
      `ensure-test-db: cannot reach Postgres at ${host}:${port} as "${user}".\n` +
        `  ${err.message}\n` +
        '  Start one first: docker-compose up -d postgres redis (maps 5433/6380),\n' +
        '  or scripts/dev-stack.sh up.',
    );
    process.exit(1);
  }

  try {
    const { rowCount } = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [database],
    );
    if (rowCount === 0) {
      // CREATE DATABASE cannot be parameterised.
      await admin.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`);
      console.log(`ensure-test-db: created database "${database}".`);
    } else {
      console.log(`ensure-test-db: database "${database}" already exists.`);
    }
  } finally {
    await admin.end();
  }

  const db = new Client({ host, port, user, password, database });
  await db.connect();
  try {
    // In `public`, explicitly, and moved back there if an earlier run
    // left one in a spec's schema -- the same rule the jest globalSetup
    // applies (src/test/integration/test-db-extensions.ts). A bare
    // CREATE EXTENSION is a no-op when the extension already exists
    // somewhere else, which is how `uuid_generate_v4() does not exist`
    // came to depend on test order.
    for (const ext of EXTENSIONS) {
      try {
        const { rows } = await db.query(
          `SELECT n.nspname AS schema FROM pg_extension e
             JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = $1`,
          [ext],
        );
        if (rows.length === 0) {
          await db.query(`CREATE EXTENSION IF NOT EXISTS "${ext}" WITH SCHEMA public`);
        } else if (rows[0].schema !== 'public') {
          await db.query(`ALTER EXTENSION "${ext}" SET SCHEMA public`);
        }
      } catch (err) {
        console.error(
          `ensure-test-db: could not create extension "${ext}": ${err.message}\n` +
            '  The memory suites need pgvector — use the pgvector/pgvector:pg16\n' +
            '  image, not plain postgres:16.',
        );
        process.exit(1);
      }
    }
    console.log(
      `ensure-test-db: ready — ${host}:${port}/${database} with ${EXTENSIONS.join(', ')}.`,
    );
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(`ensure-test-db: ${err.message}`);
  process.exit(1);
});
