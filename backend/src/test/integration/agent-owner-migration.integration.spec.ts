import { Client } from 'pg';

import { AgentOwnerNotSystem1750812100000 } from '../../migrations/1750812100000-AgentOwnerNotSystem';

/**
 * The migration that takes the 'system' sentinel out of agents."createdBy",
 * run as shipped (the class itself, not retyped SQL) against a real
 * Postgres, on tables shaped like the ones the initial schema creates.
 */
const describeOrSkip = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

describeOrSkip('agent owner migration (real Postgres)', () => {
  let db: Client;
  const MEMBER = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
  const OTHER = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';

  beforeAll(async () => {
    db = new Client({
      host: process.env.DATABASE_HOST || 'localhost',
      port: Number(process.env.DATABASE_PORT || 5432),
      user: process.env.DATABASE_USERNAME || 'postgres',
      password: process.env.DATABASE_PASSWORD || 'postgres',
      database: process.env.DATABASE_NAME || 'almyty_test',
    });
    await db.connect();
    await db.query('CREATE SCHEMA IF NOT EXISTS agentownermig');
    await db.query('SET search_path TO agentownermig');
    await db.query('DROP TABLE IF EXISTS agents');
    await db.query('DROP TABLE IF EXISTS agent_runs');
    await db.query(`
      CREATE TABLE agent_runs (
        "id" uuid PRIMARY KEY,
        "userId" character varying
      )`);
    await db.query(`
      CREATE TABLE agents (
        "id" text PRIMARY KEY,
        "isTemporary" boolean NOT NULL DEFAULT false,
        "parentRunId" character varying,
        "createdBy" character varying
      )`);
  }, 30_000);

  afterAll(async () => {
    await db.query('DROP SCHEMA IF EXISTS agentownermig CASCADE');
    await db.end();
  });

  it("gives a temporary agent its parent run's user, and every other 'system' owner null", async () => {
    const memberRun = 'a0000000-0000-4000-8000-000000000001';
    const visitorRun = 'a0000000-0000-4000-8000-000000000002';
    await db.query(`INSERT INTO agent_runs VALUES ($1, $2), ($3, NULL)`, [memberRun, MEMBER, visitorRun]);
    await db.query(
      `INSERT INTO agents ("id", "isTemporary", "parentRunId", "createdBy") VALUES
        ('temp-member', true, $1, 'system'),
        ('temp-visitor', true, $2, 'system'),
        ('temp-orphan', true, 'a0000000-0000-4000-8000-00000000dead', 'system'),
        ('temp-no-parent', true, NULL, 'system'),
        ('regular-system', false, NULL, 'system'),
        ('regular-owned', false, NULL, $3),
        ('temp-owned', true, $1, $3),
        ('unowned', false, NULL, NULL)`,
      [memberRun, visitorRun, OTHER],
    );

    const migration = new AgentOwnerNotSystem1750812100000();
    const runner = { query: (sql: string) => db.query(sql) } as any;
    await migration.up(runner);
    // Idempotent: a second run changes nothing.
    await migration.up(runner);

    const { rows } = await db.query(`SELECT "id", "createdBy" FROM agents ORDER BY "id"`);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.createdBy]))).toEqual({
      'temp-member': MEMBER,
      'temp-visitor': null,
      'temp-orphan': null,
      'temp-no-parent': null,
      'regular-system': null,
      'regular-owned': OTHER,
      'temp-owned': OTHER,
      unowned: null,
    });
  });
});
