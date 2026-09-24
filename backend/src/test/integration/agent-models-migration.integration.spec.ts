import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

import { agentModelsProblems } from '../../modules/agents/autonomous-models';
import { teamOf } from '../../modules/agents/autonomous-team';

/**
 * The AgentModels migration against a real Postgres.
 *
 * Runs the migration's ACTUAL statements, read out of the file rather than
 * retyped, on an `agents` table whose columns have the real types (`json`
 * for modelConfig and collaboration, varchar mode). Each converted row is
 * then read back through the engine's own validator and team resolver, so
 * "keeps working identically" is checked against the code that runs it.
 */
const FILE = '1750812200000-AgentModels.ts';

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

describeOrSkip('agent models migration (real Postgres)', () => {
  const schema = 'agentmodelsmig';
  let db: Client;
  const run = async (which: 'up' | 'down') => {
    for (const q of statements(which)) await db.query(q);
  };
  const rowOf = async (name: string) =>
    (await db.query(`SELECT "models", "collaboration", "modelConfig" FROM agents WHERE name = $1`, [name])).rows[0];

  const routing = { objective: 'cheapest', budgetHeadroomCents: null, capabilities: { toolUse: true } };

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
    await db.query(
      `CREATE TABLE agents (name text PRIMARY KEY, "mode" varchar NOT NULL DEFAULT 'workflow', "modelConfig" json, "collaboration" json)`,
    );
    const rows: Array<[string, string, unknown, unknown]> = [
      ['pinned', 'autonomous', { providerId: 'p-anthropic', model: 'claude-sonnet-5', temperature: 0.2, maxTokens: 512, compaction: { enabled: true } }, null],
      ['routed', 'autonomous', { routing, temperature: 0.7, model: null }, null],
      ['team', 'autonomous', { providerId: 'p-openai', model: 'gpt-4o' }, {
        strategy: 'parallel',
        participants: [
          { kind: 'agent', agentId: 'agent-researcher', role: 'Researcher' },
          { kind: 'model', providerId: 'p-mistral', model: 'mistral-large', instructions: 'Be terse', temperature: 0.1, role: '' },
          { kind: 'agent' },
          { kind: 'model', model: 'orphan' },
          { kind: 'model', routing: { objective: 'fastest' } },
        ],
        judge: { kind: 'model', providerId: 'p-judge', model: 'judge-1' },
        rules: { maxTotalCost: 2 },
      }],
      ['no-model', 'autonomous', { temperature: 0.5 }, { strategy: 'sequential', participants: [{ kind: 'agent', agentId: 'a9' }] }],
      ['workflow', 'workflow', { providerId: 'p-openai', model: 'gpt-4o' }, null],
      ['null-config', 'autonomous', null, null],
    ];
    for (const [name, mode, modelConfig, collab] of rows) {
      await db.query('INSERT INTO agents (name, "mode", "modelConfig", "collaboration") VALUES ($1, $2, $3, $4)', [
        name,
        mode,
        modelConfig === null ? null : JSON.stringify(modelConfig),
        collab === null ? null : JSON.stringify(collab),
      ]);
    }
  });

  it('gives a pinned autonomous agent a Single strategy whose main role is its model, and leaves modelConfig alone', async () => {
    await run('up');
    const row = await rowOf('pinned');
    expect(row.models).toEqual({
      strategy: 'single',
      roles: [
        { key: 'main', name: 'Main', purpose: 'main', kind: 'model', providerId: 'p-anthropic', model: 'claude-sonnet-5', temperature: 0.2, maxTokens: 512 },
      ],
    });
    expect(row.modelConfig).toEqual({ providerId: 'p-anthropic', model: 'claude-sonnet-5', temperature: 0.2, maxTokens: 512, compaction: { enabled: true } });
    // The engine reads it as the same model it ran on before.
    expect(agentModelsProblems(row.models)).toEqual([]);
    const team = teamOf({ models: row.models, modelConfig: row.modelConfig });
    expect(team.strategy).toBe('single');
    expect(team.main).toMatchObject({ key: 'main', providerId: 'p-anthropic', model: 'claude-sonnet-5', temperature: 0.2, maxTokens: 512 });
    expect(team.teammates).toEqual([]);
  });

  it('keeps a routing policy whole, nulls inside it included, and drops null top-level fields', async () => {
    await run('up');
    const row = await rowOf('routed');
    expect(row.models.roles).toEqual([{ key: 'main', name: 'Main', purpose: 'main', kind: 'model', routing, temperature: 0.7 }]);
    expect(agentModelsProblems(row.models)).toEqual([]);
  });

  it('turns collaboration participants and the judge into teammates, drops the uncallable ones, and clears collaboration', async () => {
    await run('up');
    const row = await rowOf('team');
    expect(row.collaboration).toBeNull();
    expect(row.models).toEqual({
      strategy: 'single',
      roles: [
        { key: 'main', name: 'Main', purpose: 'main', kind: 'model', providerId: 'p-openai', model: 'gpt-4o' },
        { key: 'teammate_1', name: 'Researcher', purpose: 'teammate', kind: 'agent', agentId: 'agent-researcher' },
        { key: 'teammate_2', name: 'Teammate 2', purpose: 'teammate', kind: 'model', providerId: 'p-mistral', model: 'mistral-large', instructions: 'Be terse', temperature: 0.1 },
        { key: 'teammate_3', name: 'Teammate 3', purpose: 'teammate', kind: 'model', routing: { objective: 'fastest' } },
        { key: 'teammate_4', name: 'Judge', purpose: 'teammate', kind: 'model', providerId: 'p-judge', model: 'judge-1' },
      ],
    });
    expect(agentModelsProblems(row.models)).toEqual([]);
    expect(teamOf({ models: row.models, modelConfig: row.modelConfig }).teammates.map((t) => t.key)).toEqual([
      'teammate_1',
      'teammate_2',
      'teammate_3',
      'teammate_4',
    ]);
  });

  it('leaves workflow agents, and autonomous agents with no model to make main, untouched', async () => {
    await run('up');
    expect((await rowOf('workflow')).models).toBeNull();
    const noModel = await rowOf('no-model');
    expect(noModel.models).toBeNull();
    expect(noModel.collaboration).toEqual({ strategy: 'sequential', participants: [{ kind: 'agent', agentId: 'a9' }] });
    expect((await rowOf('null-config')).models).toBeNull();
  });

  it('is idempotent', async () => {
    await run('up');
    const once = (await rowOf('team')).models;
    await run('up');
    expect((await rowOf('team')).models).toEqual(once);
  });

  it('down puts teammates back as parallel participants and drops the column', async () => {
    await run('up');
    await run('down');
    const row = (await db.query(`SELECT * FROM agents WHERE name = 'team'`)).rows[0];
    expect(row).not.toHaveProperty('models');
    expect(row.collaboration).toEqual({
      strategy: 'parallel',
      participants: [
        { kind: 'agent', agentId: 'agent-researcher', role: 'Researcher' },
        { kind: 'model', role: 'Teammate 2', providerId: 'p-mistral', model: 'mistral-large', instructions: 'Be terse', temperature: 0.1 },
        { kind: 'model', role: 'Teammate 3', routing: { objective: 'fastest' } },
        { kind: 'model', role: 'Judge', providerId: 'p-judge', model: 'judge-1' },
      ],
    });
    expect((await db.query(`SELECT "collaboration" FROM agents WHERE name = 'pinned'`)).rows[0].collaboration).toBeNull();
  });
});
