import { Client } from 'pg';

import { CollapseRunnerToolCopies1791001100000 } from '../../migrations/1791001100000-CollapseRunnerToolCopies';

/**
 * CollapseRunnerToolCopies against a real Postgres: the copies of a
 * runner's tools go, the row agents and gateways use stays, and every
 * reference to a copy is moved onto it.
 */
const describeOrSkip = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;
const SCHEMA = 'runnertoolmig';

describeOrSkip('CollapseRunnerToolCopies migration (real Postgres)', () => {
  let db: Client;
  const runner = { query: (sql: string, params?: unknown[]) => db.query(sql, params).then((r) => r.rows) } as any;

  const ORG = '00000000-0000-4000-8000-000000000001';
  const ORG2 = '00000000-0000-4000-8000-000000000002';
  const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const [A, B, C, D, E, X, P1, P2, O1] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(id);
  const G1 = id(101);
  const G2 = id(102);
  const G3 = id(103);

  beforeAll(async () => {
    db = new Client({
      host: process.env.DATABASE_HOST || 'localhost',
      port: Number(process.env.DATABASE_PORT || 5432),
      user: process.env.DATABASE_USERNAME || 'postgres',
      password: process.env.DATABASE_PASSWORD || 'postgres',
      database: process.env.DATABASE_NAME || 'almyty_test',
    });
    await db.connect();
    await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await db.query(`CREATE SCHEMA ${SCHEMA}`);
    await db.query(`SET search_path TO ${SCHEMA}`);
  }, 30_000);

  afterAll(async () => {
    await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await db.end();
  });

  beforeEach(async () => {
    for (const t of ['gateway_tools', 'tool_executions', 'usage_metrics', 'request_logs', 'approval_requests', 'approval_policies', 'agents', 'tools']) {
      await db.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
    }
    await db.query(`
      CREATE TABLE tools (
        id uuid PRIMARY KEY,
        "organizationId" uuid NOT NULL,
        name varchar NOT NULL,
        status varchar NOT NULL,
        "runnerConfig" jsonb,
        "createdAt" timestamptz NOT NULL
      )`);
    await db.query(`CREATE UNIQUE INDEX tools_org_name_uq ON tools ("organizationId", name) WHERE status <> 'deleted'`);
    await db.query(`CREATE TABLE agents (id uuid PRIMARY KEY, "toolIds" uuid[] NOT NULL DEFAULT '{}', pipeline json, "agentConfig" json)`);
    await db.query(`
      CREATE TABLE gateway_tools (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "gatewayId" uuid NOT NULL,
        "toolId" uuid NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
        UNIQUE ("gatewayId", "toolId")
      )`);
    for (const t of ['tool_executions', 'usage_metrics', 'request_logs', 'approval_requests']) {
      await db.query(`CREATE TABLE ${t} (id serial PRIMARY KEY, "toolId" uuid)`);
    }
    await db.query(`CREATE TABLE approval_policies (id serial PRIMARY KEY, "trigger" jsonb)`);

    const tool = (tid: string, org: string, name: string, status: string, day: number, runnerConfig: object | null) =>
      db.query(`INSERT INTO tools VALUES ($1, $2, $3, $4, $5, $6)`, [
        tid, org, name, status, runnerConfig ? JSON.stringify(runnerConfig) : null, `2026-06-${10 + day}T00:00:00Z`,
      ]);
    const rc = { runnerId: 'r1', method: 'shell.exec', requiresWorkspace: true };
    // shell.exec: A live and oldest, B and C retired copies. B is the one
    // an agent and a gateway use.
    await tool(A, ORG, 'runner.ava.shell.exec', 'active', 1, rc);
    await tool(B, ORG, 'runner.ava.shell.exec', 'deleted', 2, rc);
    await tool(C, ORG, 'runner.ava.shell.exec', 'deleted', 3, rc);
    // runner.info: nothing uses either; the live one stays.
    await tool(D, ORG, 'runner.ava.runner.info', 'active', 1, { ...rc, method: 'runner.info' });
    await tool(E, ORG, 'runner.ava.runner.info', 'deleted', 2, { ...rc, method: 'runner.info' });
    // Not runner tools: a user's deleted tool and its live namesake stay.
    await tool(P1, ORG, 'petstore.get', 'deleted', 1, null);
    await tool(P2, ORG, 'petstore.get', 'active', 2, null);
    // Another organization's single runner tool of the same name.
    await tool(O1, ORG2, 'runner.ava.shell.exec', 'active', 1, rc);
    await tool(X, ORG, 'weather', 'active', 1, null);

    await db.query(`INSERT INTO agents VALUES ($1, $2, $3, $4)`, [
      id(201),
      [A, X, B, C],
      JSON.stringify({ nodes: [{ type: 'tool_call', data: { toolId: C } }] }),
      null,
    ]);
    // B is on two gateways and the agent: the most used.
    await db.query(`INSERT INTO gateway_tools ("gatewayId", "toolId") VALUES ($1, $2), ($1, $3), ($4, $5), ($6, $2)`, [G1, B, C, G2, A, G3]);
    await db.query(`INSERT INTO tool_executions ("toolId") VALUES ($1), ($2)`, [C, X]);
    await db.query(`INSERT INTO approval_policies ("trigger") VALUES ($1)`, [JSON.stringify({ kind: 'tool_amount', toolId: A })]);
  });

  it('keeps the used row, live, and moves every reference onto it', async () => {
    await new CollapseRunnerToolCopies1791001100000().up(runner);

    const tools = await db.query(`SELECT id, status FROM tools ORDER BY id`);
    expect(tools.rows).toEqual([
      { id: B, status: 'active' },
      { id: D, status: 'active' },
      { id: X, status: 'active' },
      { id: P1, status: 'deleted' },
      { id: P2, status: 'active' },
      { id: O1, status: 'active' },
    ].sort((l, r) => l.id.localeCompare(r.id)));

    const agent = (await db.query(`SELECT "toolIds", pipeline FROM agents`)).rows[0];
    expect(agent.toolIds).toEqual([B, X]);
    expect(agent.pipeline.nodes[0].data.toolId).toBe(B);

    const attachments = await db.query(`SELECT "gatewayId", "toolId" FROM gateway_tools ORDER BY "gatewayId"`);
    expect(attachments.rows).toEqual([
      { gatewayId: G1, toolId: B },
      { gatewayId: G2, toolId: B },
      { gatewayId: G3, toolId: B },
    ]);
    const executions = await db.query(`SELECT "toolId" FROM tool_executions ORDER BY id`);
    expect(executions.rows.map((r) => r.toolId)).toEqual([B, X]);
    const policy = (await db.query(`SELECT "trigger" FROM approval_policies`)).rows[0];
    expect(policy.trigger.toolId).toBe(B);
  });

  it('is a no-op the second time', async () => {
    await new CollapseRunnerToolCopies1791001100000().up(runner);
    const before = (await db.query(`SELECT id, status FROM tools ORDER BY id`)).rows;
    await new CollapseRunnerToolCopies1791001100000().up(runner);
    expect((await db.query(`SELECT id, status FROM tools ORDER BY id`)).rows).toEqual(before);
  });
});
