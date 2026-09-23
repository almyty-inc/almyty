import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

/**
 * The CollaborationParticipants migration against a real Postgres.
 *
 * Runs the migration's ACTUAL statements, read out of the file rather than
 * retyped, on a `json` column shaped like `agents.collaboration`.
 */
const FILE = '1750808000000-CollaborationParticipants.ts';

function statements(which: 'up' | 'down'): string[] {
  const src = readFileSync(join(__dirname, '..', '..', 'migrations', FILE), 'utf8');
  const body = which === 'up'
    ? src.slice(src.indexOf('public async up'), src.indexOf('public async down'))
    : src.slice(src.indexOf('public async down'));
  const queries = [...body.matchAll(/await queryRunner\.query\(`\n([\s\S]*?)\n    `\)/g)].map((m) => m[1]);
  if (queries.length === 0) throw new Error(`no statements found in ${FILE} ${which}()`);
  return queries;
}

const describeOrSkip = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

describeOrSkip('collaboration participants migration (real Postgres)', () => {
  const schema = 'collabmig';
  let db: Client;
  const run = async (which: 'up' | 'down') => {
    for (const q of statements(which)) await db.query(q);
  };
  const collabOf = async (name: string) =>
    (await db.query(`SELECT "collaboration" FROM agents WHERE name = $1`, [name])).rows[0].collaboration;

  beforeAll(async () => {
    db = new Client({
      host: process.env.DATABASE_HOST || 'localhost',
      port: Number(process.env.DATABASE_PORT || 5432),
      user: process.env.DATABASE_USERNAME || 'postgres',
      password: process.env.DATABASE_PASSWORD || 'postgres',
      database: process.env.DATABASE_NAME || 'almyty_test',
    });
    await db.connect();
    await db.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
  }, 30_000);

  afterAll(async () => {
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.end();
  });

  beforeEach(async () => {
    await db.query('DROP TABLE IF EXISTS agents');
    await db.query('CREATE TABLE agents (name text PRIMARY KEY, "collaboration" json)');
    const rows: Array<[string, unknown]> = [
      ['old', {
        strategy: 'debate',
        agents: [{ agentId: 'a1', role: 'pro' }, { agentId: 'a2' }],
        judgeAgentId: 'j1',
        maxRounds: 2,
        rules: { maxTotalCost: 3 },
      }],
      ['no-judge', { strategy: 'sequential', agents: [{ agentId: 'a3' }] }],
      ['current', {
        strategy: 'parallel',
        participants: [{ kind: 'model', providerId: 'p1', model: 'm1' }],
        judge: { kind: 'model', providerId: 'p2' },
      }],
      ['none', null],
    ];
    for (const [name, collab] of rows) {
      await db.query('INSERT INTO agents (name, "collaboration") VALUES ($1, $2)', [
        name,
        collab === null ? null : JSON.stringify(collab),
      ]);
    }
  });

  it('turns agents into agent participants and judgeAgentId into an agent judge', async () => {
    await run('up');
    expect(await collabOf('old')).toEqual({
      strategy: 'debate',
      participants: [
        { kind: 'agent', agentId: 'a1', role: 'pro' },
        { kind: 'agent', agentId: 'a2' },
      ],
      judge: { kind: 'agent', agentId: 'j1' },
      maxRounds: 2,
      rules: { maxTotalCost: 3 },
    });
    expect(await collabOf('no-judge')).toEqual({
      strategy: 'sequential',
      participants: [{ kind: 'agent', agentId: 'a3' }],
    });
  });

  it('leaves rows already in the participants shape, and null rows, alone', async () => {
    await run('up');
    expect(await collabOf('current')).toEqual({
      strategy: 'parallel',
      participants: [{ kind: 'model', providerId: 'p1', model: 'm1' }],
      judge: { kind: 'model', providerId: 'p2' },
    });
    expect(await collabOf('none')).toBeNull();
  });

  it('is idempotent', async () => {
    await run('up');
    const once = await collabOf('old');
    await run('up');
    expect(await collabOf('old')).toEqual(once);
  });

  it('down restores the agent-only keys from agent participants', async () => {
    await run('up');
    await run('down');
    expect(await collabOf('old')).toEqual({
      strategy: 'debate',
      agents: [{ agentId: 'a1', role: 'pro' }, { agentId: 'a2' }],
      judgeAgentId: 'j1',
      maxRounds: 2,
      rules: { maxTotalCost: 3 },
    });
    // Model participants have no old-shape equivalent and are dropped.
    expect(await collabOf('current')).toEqual({ strategy: 'parallel', agents: [] });
  });
});
