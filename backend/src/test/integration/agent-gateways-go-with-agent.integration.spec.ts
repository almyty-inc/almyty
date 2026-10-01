import { Client } from 'pg';

import { AgentGatewaysGoWithAgent1750813783000 } from '../../migrations/1750813783000-AgentGatewaysGoWithAgent';

/**
 * An agent's gateways go with the agent, against a real Postgres.
 *
 * The foreign key was ON DELETE SET NULL: deleting an agent left its web
 * chat gateway active with no agent, holding its address (the next web
 * chat of that name got "-2") and answering a message with a 500. The
 * migration's own up() runs here, so the test cannot drift from what ships.
 */
const describeOrSkip = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

describeOrSkip('agent gateways go with the agent (real Postgres)', () => {
  let db: Client;
  const migration = new AgentGatewaysGoWithAgent1750813783000();
  const queryRunner = { query: (sql: string, params?: any[]) => db.query(sql, params) } as any;

  beforeAll(async () => {
    db = new Client({
      host: process.env.DATABASE_HOST || 'localhost',
      port: Number(process.env.DATABASE_PORT || 5432),
      user: process.env.DATABASE_USERNAME || 'postgres',
      password: process.env.DATABASE_PASSWORD || 'postgres',
      database: process.env.DATABASE_NAME || 'almyty_test',
    });
    await db.connect();
    await db.query('CREATE SCHEMA IF NOT EXISTS agentgw');
    await db.query('SET search_path TO agentgw');
  }, 30_000);

  afterAll(async () => {
    await db.query('DROP SCHEMA IF EXISTS agentgw CASCADE');
    await db.end();
  });

  beforeEach(async () => {
    await db.query('DROP TABLE IF EXISTS gateways');
    await db.query('DROP TABLE IF EXISTS agents');
    await db.query(`CREATE TABLE agents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL)`);
    // The shape InitialSchema gave the column, with its constraint name.
    await db.query(`
      CREATE TABLE gateways (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "kind" varchar NOT NULL DEFAULT 'tool',
        "type" varchar NOT NULL,
        "status" varchar NOT NULL DEFAULT 'active',
        "agentId" uuid NULL,
        "configuration" json NOT NULL DEFAULT '{}',
        CONSTRAINT "FK_gateways_agentId" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE SET NULL
      )`);
    await db.query(`
      CREATE UNIQUE INDEX "UQ_gateways_hosted_chat_slug" ON gateways (("configuration" -> 'hostedChat' ->> 'slug'))
       WHERE "type" = 'hosted_chat'`);
  });

  const agent = async (name = 'Support agent') =>
    (await db.query(`INSERT INTO agents (name) VALUES ($1) RETURNING id`, [name])).rows[0].id as string;

  const webChat = async (agentId: string | null, slug: string) =>
    (
      await db.query(
        `INSERT INTO gateways ("kind", "type", "agentId", "configuration") VALUES ('agent', 'hosted_chat', $1, $2::json) RETURNING id`,
        [agentId, JSON.stringify({ hostedChat: { slug } })],
      )
    ).rows[0].id as string;

  const gatewayIds = async () => (await db.query(`SELECT id FROM gateways ORDER BY id`)).rows.map((r) => r.id);

  it('before: deleting the agent leaves its web chat holding the address', async () => {
    const a = await agent();
    await webChat(a, 'support-agent');
    await db.query(`DELETE FROM agents WHERE id = $1`, [a]);

    const { rows } = await db.query(`SELECT "agentId" FROM gateways`);
    expect(rows).toEqual([{ agentId: null }]);
    await expect(webChat(await agent(), 'support-agent')).rejects.toThrow(/UQ_gateways_hosted_chat_slug/);
  });

  it('deletes agent gateways already left without an agent, and no tool gateway', async () => {
    const orphan = await webChat(null, 'support-agent');
    const live = await webChat(await agent('Billing'), 'billing');
    const { rows } = await db.query(`INSERT INTO gateways ("kind", "type") VALUES ('tool', 'mcp') RETURNING id`);
    const tool = rows[0].id;

    await migration.up(queryRunner);

    const left = await gatewayIds();
    expect(left).not.toContain(orphan);
    expect(left.sort()).toEqual([live, tool].sort());
  });

  it('after: deleting an agent deletes its gateways and frees the address', async () => {
    await migration.up(queryRunner);
    const a = await agent();
    await webChat(a, 'support-agent');

    await db.query(`DELETE FROM agents WHERE id = $1`, [a]);

    expect(await gatewayIds()).toEqual([]);
    await expect(webChat(await agent(), 'support-agent')).resolves.toEqual(expect.any(String));
  });

  it('down() puts the old rule back', async () => {
    await migration.up(queryRunner);
    await migration.down(queryRunner);
    const a = await agent();
    await webChat(a, 'x');
    await db.query(`DELETE FROM agents WHERE id = $1`, [a]);
    const { rows } = await db.query(`SELECT "agentId" FROM gateways`);
    expect(rows).toEqual([{ agentId: null }]);
  });
});
