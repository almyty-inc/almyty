import { Client } from 'pg';

import { ToolSideEffectClass1750813799000 } from '../../migrations/1750813799000-ToolSideEffectClass';
import { ToolEmbeddings1750813800000 } from '../../migrations/1750813800000-ToolEmbeddings';
import { ToolEmbeddingService } from '../../modules/tool-discovery/tool-embedding.service';
import { computeToolHash, computeToolHashWithoutClass } from '../../common/security/tool-integrity';

/**
 * Code mode part A and B on a real Postgres with pgvector: the side-effect
 * class migration on json columns shaped like the initial schema's, and the
 * tool embeddings table with its nearest-neighbour query, filtered by the
 * query's model and the caller's candidate tools.
 */
const describeOrSkip = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

describeOrSkip('code mode: side-effect class and tool embeddings (real Postgres)', () => {
  let db: Client;
  const ORG = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
  const ids = {
    get: '11111111-1111-4111-8111-111111111111',
    del: '22222222-2222-4222-8222-222222222222',
    gql: '33333333-3333-4333-8333-333333333333',
    other: '44444444-4444-4444-8444-444444444444',
  };
  const OP = '55555555-5555-4555-8555-555555555555';
  const runner = () => ({ query: (sql: string, params?: any[]) => db.query(sql, params).then((r) => r.rows) }) as any;

  beforeAll(async () => {
    db = new Client({
      host: process.env.DATABASE_HOST || 'localhost',
      port: Number(process.env.DATABASE_PORT || 5432),
      user: process.env.DATABASE_USERNAME || 'postgres',
      password: process.env.DATABASE_PASSWORD || 'postgres',
      database: process.env.DATABASE_NAME || 'almyty_test',
    });
    await db.connect();
    await db.query('DROP SCHEMA IF EXISTS codemode CASCADE');
    await db.query('CREATE SCHEMA codemode');
    await db.query('SET search_path TO codemode, public');
    await db.query(`CREATE TABLE operations ("id" uuid PRIMARY KEY, "type" varchar)`);
    await db.query(`
      CREATE TABLE tools (
        "id" uuid PRIMARY KEY, "name" varchar NOT NULL, "description" varchar, "parameters" json, "code" text,
        "executionMethod" varchar, "metadata" json, "configuration" json, "httpConfig" json, "graphqlConfig" json,
        "llmConfig" json, "definitionHash" varchar(64), "operationId" uuid, "status" varchar DEFAULT 'active',
        "organizationId" uuid
      )`);
  }, 30_000);

  afterAll(async () => {
    await db.query('DROP SCHEMA IF EXISTS codemode CASCADE');
    await db.end();
  });

  it('classifies every tool, copies a GraphQL operation type, and re-stamps only hashes that held', async () => {
    const intact = { name: 'petstore_get_pet', description: 'Get', parameters: { a: 1 }, code: null, executionMethod: null };
    await db.query(`INSERT INTO operations VALUES ($1, 'query')`, [OP]);
    await db.query(
      `INSERT INTO tools ("id", "name", "description", "parameters", "metadata", "definitionHash", "operationId", "organizationId") VALUES
        ($1, 'petstore_get_pet', 'Get', '{"a":1}', '{"sourceOperation":{"method":"GET"},"sourceApi":{"type":"openapi"}}', $5, NULL, $6),
        ($2, 'petstore_delete_pet', 'Delete', '{}', '{"sourceOperation":{"method":"DELETE"}}', $7, NULL, $6),
        ($3, 'gql_pets', 'Pets', '{}', '{"sourceOperation":{"method":"POST"},"sourceApi":{"type":"graphql"}}', NULL, $4, $6)`,
      [ids.get, ids.del, ids.gql, OP, computeToolHashWithoutClass(intact as any), ORG, 'f'.repeat(64)],
    );

    const migration = new ToolSideEffectClass1750813799000();
    await migration.up(runner());

    const { rows } = await db.query(`SELECT "id", "sideEffect", "openWorld", "sideEffectSource", "definitionHash", "metadata" FROM tools`);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect([byId[ids.get].sideEffect, byId[ids.get].sideEffectSource]).toEqual(['read', 'http_method']);
    expect([byId[ids.del].sideEffect, byId[ids.del].sideEffectSource]).toEqual(['destructive', 'http_method']);
    expect([byId[ids.gql].sideEffect, byId[ids.gql].sideEffectSource]).toEqual(['read', 'graphql']);
    expect(byId[ids.gql].metadata.sourceOperation.type).toBe('query');
    expect(byId[ids.get].definitionHash).toBe(computeToolHash({ ...intact, metadata: { sourceOperation: { method: 'GET' } } } as any).hash);
    expect(byId[ids.del].definitionHash).toBe('f'.repeat(64));

    // The constraints hold the column to a class.
    await expect(db.query(`UPDATE tools SET "sideEffect" = 'harmless' WHERE "id" = $1`, [ids.get])).rejects.toThrow(/CHK_tools_side_effect/);

    await migration.down(runner());
    const columns = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'codemode' AND table_name = 'tools'`);
    expect(columns.rows.map((r) => r.column_name)).not.toContain('sideEffect');
    await migration.up(runner());
  });

  it('stores embeddings and finds the nearest candidates, comparing only the query\'s model', async () => {
    await new ToolEmbeddings1750813800000().up(runner());
    await db.query(`INSERT INTO tools ("id", "name", "description", "metadata", "organizationId") VALUES ($1, 'other_tool', 'Other', '{}', $2)`, [ids.other, ORG]);

    // Fixed vectors per text: each tool points one way; the query points at "delete".
    const direction = (text: string) => (/delete/i.test(text) ? [1, 0] : /get/i.test(text) ? [0, 1] : [0.7, 0.7]);
    const embeddings: any = { generateEmbedding: jest.fn(async (text: string) => ({ vector: direction(text), model: 'test-model', dim: 2, provider: 'openai' })) };
    const toolRow = async (id: string) => (await db.query(`SELECT * FROM tools WHERE "id" = $1`, [id])).rows[0];
    const dataSource: any = {
      subscribers: [],
      query: (sql: string, params?: any[]) => db.query(sql, params).then((r) => r.rows),
      getRepository: () => ({ findOne: async ({ where }: any) => toolRow(where.id) }),
    };
    const svc = new ToolEmbeddingService(dataSource, embeddings);

    for (const id of [ids.get, ids.del, ids.other]) expect(await svc.embedTool(id)).toBe('embedded');
    expect(await svc.embedTool(ids.get)).toBe('unchanged');

    // A vector from another model never competes.
    await db.query(
      `INSERT INTO tool_embeddings ("toolId", "organizationId", "model", "dim", "embedding", "textHash") VALUES ($1, $2, 'other-model', 2, $3::vector, 'x')`,
      [ids.gql, ORG, `[${[1, 0, ...new Array(1534).fill(0)].join(',')}]`],
    );

    const ranked = (await svc.nearest(ORG, [ids.get, ids.del, ids.gql], 'delete it', 10)).ids;
    expect(ranked).toEqual([ids.del, ids.get]);
    expect((await svc.nearest(ORG, [ids.get], 'delete it', 10)).ids).toEqual([ids.get]);
    expect((await svc.nearest('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', [ids.del], 'delete it', 10)).ids).toEqual([]);

    // A deleted tool's embeddings go.
    await db.query(`UPDATE tools SET "status" = 'deleted' WHERE "id" = $1`, [ids.del]);
    expect(await svc.embedTool(ids.del)).toBe('removed');
    expect((await db.query(`SELECT count(*)::int AS n FROM tool_embeddings WHERE "toolId" = $1`, [ids.del])).rows[0].n).toBe(0);

    // A tool removed outright takes its embeddings with it.
    await db.query(`DELETE FROM tools WHERE "id" = $1`, [ids.other]);
    expect((await db.query(`SELECT count(*)::int AS n FROM tool_embeddings WHERE "toolId" = $1`, [ids.other])).rows[0].n).toBe(0);
  });
});
