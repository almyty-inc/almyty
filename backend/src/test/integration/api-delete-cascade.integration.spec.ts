import { DataSource, Logger as TypeOrmLogger } from 'typeorm';

import { Api } from '../../entities/api.entity';
import { ApisService } from '../../modules/apis/apis.service';
import { IndexApiDeleteCascadeForeignKeys1791001600000 } from '../../migrations/1791001600000-IndexApiDeleteCascadeForeignKeys';

/**
 * Deleting an API is one statement from the app and a bounded amount of
 * work in the database, however many tools it has.
 *
 * DELETE /apis/:id for the 21-tool SOAP CountryInfo import took over three
 * minutes on staging. The app sends one DELETE; Postgres then cascades to
 * the API's operations, tools, schemas, resources and credentials, and from
 * each deleted tool to its versions, request logs, usage metrics and so on.
 * A foreign key whose referencing column has no index makes every one of
 * those row deletions scan the whole referencing table: 21 tools meant 21
 * full scans of request_logs and usage_metrics (the largest tables there
 * are), one scan of tools per deleted operation and json schema, one of
 * operations per resource.
 *
 * This holds the delete to: a constant number of app queries, and not one
 * sequential scan anywhere in the cascade (counted by Postgres itself in
 * pg_stat_xact_user_tables, with sequential scans priced out so a missing
 * index is the only way one happens). And every foreign key the cascade
 * reaches has an index on its referencing columns.
 *
 * Real Postgres, gated on RUN_DB_INTEGRATION=1, in its own schema.
 */
const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'api_delete_cascade_test';

jest.setTimeout(180_000);

describeIfDb('deleting an API (real Postgres)', () => {
  let ds: DataSource;
  let organizationId: string;
  const queries: string[] = [];
  let counting = false;

  const logger: TypeOrmLogger = {
    logQuery: (query) => { if (counting) queries.push(query); },
    logQueryError: () => undefined,
    logQuerySlow: () => undefined,
    logSchemaBuild: () => undefined,
    logMigration: () => undefined,
    log: () => undefined,
  };

  beforeAll(async () => {
    const connection = {
      type: 'postgres' as const,
      host: process.env.DATABASE_HOST || '127.0.0.1',
      port: Number(process.env.DATABASE_PORT || 5432),
      username: process.env.DATABASE_USERNAME || 'postgres',
      password: process.env.DATABASE_PASSWORD || '',
      database: process.env.DATABASE_NAME || 'almyty_test',
    };
    const bootstrap = new DataSource(connection);
    await bootstrap.initialize();
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await bootstrap.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public`);
    await bootstrap.destroy();

    ds = new DataSource({
      ...connection,
      schema: SCHEMA,
      entities: [__dirname + '/../../entities/*.entity{.ts,.js}'],
      extra: { options: `-c search_path=${SCHEMA},public` },
      migrations: [__dirname + '/../../migrations/*{.ts,.js}'],
      migrationsRun: true,
      migrationsTransactionMode: 'each',
      dropSchema: true,
      logging: ['query'],
      logger,
    });
    await ds.initialize();
    [{ id: organizationId }] = await ds.query(`INSERT INTO organizations (name, slug) VALUES ('Delete Org', 'delete-org') RETURNING id`);
  });

  afterAll(async () => {
    await ds?.destroy();
  });

  /** An imported API the way a schema import leaves it, with `n` tools that have been used. */
  async function importedApi(n: number): Promise<string> {
    const [{ id: apiId }] = await ds.query(
      `INSERT INTO apis (name, "baseUrl", "organizationId") VALUES ($1, 'http://countryinfo.test', $2) RETURNING id`,
      [`CountryInfo ${n}-${Date.now()}`, organizationId],
    );
    const [{ id: schemaId }] = await ds.query(
      `INSERT INTO api_schemas ("apiId", "rawSchema", "schemaHash") VALUES ($1, '<wsdl/>', md5(random()::text)) RETURNING id`, [apiId],
    );
    await ds.query(`INSERT INTO credentials (name, config, "organizationId", "apiId") VALUES ('key', '{}', $1, $2)`, [organizationId, apiId]);
    const [{ id: gatewayId }] = await ds.query(
      `INSERT INTO gateways (name, type, configuration, endpoint, "organizationId") VALUES ($1, 'mcp', '{}', $1, $2) RETURNING id`,
      [`gw-${apiId}`, organizationId],
    );
    for (let i = 0; i < n; i++) {
      const [{ id: resourceId }] = await ds.query(`INSERT INTO resources ("apiId", name) VALUES ($1, $2) RETURNING id`, [apiId, `r${i}`]);
      const [{ id: inSchema }] = await ds.query(
        `INSERT INTO json_schemas (name, schema, "schemaHash", "sourceSchemaId") VALUES ($1, '{}', md5(random()::text), $2) RETURNING id`, [`in${i}`, schemaId],
      );
      const [{ id: outSchema }] = await ds.query(
        `INSERT INTO json_schemas (name, schema, "schemaHash", "sourceSchemaId") VALUES ($1, '{}', md5(random()::text), $2) RETURNING id`, [`out${i}`, schemaId],
      );
      const [{ id: operationId }] = await ds.query(
        `INSERT INTO operations (name, endpoint, "apiId", "resourceId") VALUES ($1, '/', $2, $3) RETURNING id`, [`Op${i}`, apiId, resourceId],
      );
      const [{ id: toolId }] = await ds.query(
        `INSERT INTO tools (name, "organizationId", "apiId", "operationId", "inputSchemaId", "outputSchemaId") VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [`tool_${i}_${apiId.slice(0, 8)}`, organizationId, apiId, operationId, inSchema, outSchema],
      );
      await ds.query(`INSERT INTO tool_versions ("toolId", definition, version) VALUES ($1, '{}', '1')`, [toolId]);
      await ds.query(`INSERT INTO gateway_tools ("gatewayId", "toolId") VALUES ($1, $2)`, [gatewayId, toolId]);
      await ds.query(`INSERT INTO tool_executions ("toolId", "organizationId", parameters, success) VALUES ($1, $2, '{}', true)`, [toolId, organizationId]);
      await ds.query(`INSERT INTO request_logs ("toolId", method, path, "statusCode", "responseTime", timestamp) VALUES ($1, 'POST', '/', 200, 5, now())`, [toolId]);
      await ds.query(`INSERT INTO usage_metrics ("toolId", type, value, timestamp) VALUES ($1, 'tool_execution', 1, now())`, [toolId]);
    }
    return apiId;
  }

  /** Delete through ApisService.remove inside one transaction; report what it cost. */
  async function deleteAndMeasure(apiId: string): Promise<{ appQueries: number; seqScans: Record<string, number> }> {
    const runner = ds.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      // Price sequential scans out: with an index on the referencing
      // column every cascade step uses it, so a sequential scan here means
      // a foreign key with no index.
      await runner.query('SET LOCAL enable_seqscan = off');
      const before = await runner.query(`SELECT relname, seq_scan FROM pg_stat_xact_user_tables WHERE schemaname = $1`, [SCHEMA]);
      const service = Object.assign(Object.create(ApisService.prototype), {
        apiRepository: runner.manager.getRepository(Api),
        auditLogService: { logDelete: () => undefined },
      }) as ApisService;
      queries.length = 0;
      counting = true;
      await service.remove(apiId, organizationId);
      counting = false;
      const appQueries = queries.length;
      const after = await runner.query(`SELECT relname, seq_scan FROM pg_stat_xact_user_tables WHERE schemaname = $1`, [SCHEMA]);
      const was = new Map<string, number>(before.map((r: any) => [r.relname, Number(r.seq_scan)]));
      const seqScans: Record<string, number> = {};
      for (const r of after) {
        const delta = Number(r.seq_scan) - (was.get(r.relname) ?? 0);
        if (delta > 0) seqScans[r.relname] = delta;
      }
      await runner.commitTransaction();
      return { appQueries, seqScans };
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      counting = false;
      await runner.release();
    }
  }

  it('sends the same few queries for 3 tools as for 21', async () => {
    const small = await deleteAndMeasure(await importedApi(3));
    const large = await deleteAndMeasure(await importedApi(21));
    expect(large.appQueries).toBe(small.appQueries);
    expect(large.appQueries).toBeLessThanOrEqual(3);
  });

  it('cascades without a single sequential scan', async () => {
    const apiId = await importedApi(21);
    const { seqScans } = await deleteAndMeasure(apiId);
    expect(seqScans).toEqual({});
    // And the cascade did its job.
    expect(await ds.query(`SELECT 1 FROM tools WHERE "apiId" = $1`, [apiId])).toEqual([]);
    expect(Number((await ds.query(`SELECT count(*) AS n FROM request_logs WHERE "toolId" IS NULL`))[0].n)).toBeGreaterThanOrEqual(21);
  });

  it('every foreign key a deleted API reaches has an index on its referencing column', async () => {
    const unindexed = await ds.query(
      `WITH RECURSIVE reach AS (
         SELECT c.conrelid, c.confrelid, c.conkey, c.confdeltype, 1 AS depth
           FROM pg_constraint c WHERE c.contype = 'f' AND c.confrelid = $1::regclass
         UNION
         SELECT c.conrelid, c.confrelid, c.conkey, c.confdeltype, reach.depth + 1
           FROM pg_constraint c JOIN reach ON c.confrelid = reach.conrelid
          WHERE c.contype = 'f' AND reach.confdeltype = 'c' AND reach.depth < 6
       )
       SELECT DISTINCT reach.conrelid::regclass::text || '(' ||
              (SELECT string_agg(a.attname, ',') FROM pg_attribute a WHERE a.attrelid = reach.conrelid AND a.attnum = ANY(reach.conkey)) ||
              ') -> ' || reach.confrelid::regclass::text AS fk
         FROM reach
        WHERE NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = reach.conrelid AND i.indkey[0] = reach.conkey[1])
        ORDER BY 1`,
      [`${SCHEMA}.apis`],
    );
    expect(unindexed.map((r: any) => r.fk)).toEqual([]);
  });

  // The migration builds CONCURRENTLY: writes go on while an index builds,
  // and an interrupted build's INVALID leftover is rebuilt, not skipped.
  // API_DELETE_BENCH_ROWS sizes request_logs (usage_metrics gets half);
  // 2,000,000 is the local proof, CI runs a smaller copy.
  it('the index migration builds concurrently: writes are not blocked and an invalid leftover is rebuilt', async () => {
    const rows = Number(process.env.API_DELETE_BENCH_ROWS || 200_000);
    const migration = new IndexApiDeleteCascadeForeignKeys1791001600000();
    expect(migration.transaction).toBe(false);

    const runner = ds.createQueryRunner();
    await runner.connect();
    const writer = ds.createQueryRunner();
    await writer.connect();
    const reader = ds.createQueryRunner();
    await reader.connect();
    try {
      await migration.down(runner);
      await runner.query(`INSERT INTO request_logs (method, path, "statusCode", "responseTime", timestamp) SELECT 'GET', '/', 200, 1, now() FROM generate_series(1, $1::int)`, [rows]);
      await runner.query(`INSERT INTO usage_metrics (type, value, timestamp) SELECT 'x', 1, now() FROM generate_series(1, $1::int)`, [Math.floor(rows / 2)]);
      await runner.query('ANALYZE request_logs; ANALYZE usage_metrics');

      // 1. Writes go on while an index builds. A reader holding an old
      // snapshot keeps the first build (tools) from finishing, so it is
      // certainly under way; a plain CREATE INDEX would hold the insert
      // until it was done.
      await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await reader.query('SELECT count(*) FROM tools');
      const firstBuild = migration.up(runner);
      let inProgress = false;
      for (let i = 0; i < 1000 && !inProgress; i++) {
        inProgress = (await writer.query(`SELECT 1 FROM pg_stat_progress_create_index p JOIN pg_class c ON c.oid = p.relid WHERE c.relname = 'tools'`)).length > 0;
        if (!inProgress) await new Promise((r) => setTimeout(r, 10));
      }
      expect(inProgress).toBe(true);
      const t = Date.now();
      await writer.query(`INSERT INTO tools (name, "organizationId") VALUES ('written-during-build', $1)`, [organizationId]);
      const writeMs = Date.now() - t;
      await reader.query('COMMIT');
      await firstBuild;
      expect(writeMs).toBeLessThan(2_000);

      // 2. An interrupted build's INVALID leftover under the migration's
      // name (here from a unique build that failed) is rebuilt, and the
      // whole migration is timed.
      await migration.down(runner);
      await runner.query(`CREATE UNIQUE INDEX CONCURRENTLY "IDX_request_logs_toolId" ON request_logs (method)`).catch(() => undefined);
      const leftover = await runner.query(`SELECT i.indisvalid FROM pg_index i WHERE i.indexrelid = to_regclass('"IDX_request_logs_toolId"')`);
      expect(leftover).toEqual([{ indisvalid: false }]);
      const started = Date.now();
      await migration.up(runner);
      const buildMs = Date.now() - started;
      process.stdout.write(`index migration over ${rows} request_logs / ${Math.floor(rows / 2)} usage_metrics: ${buildMs} ms; an insert during a build took ${writeMs} ms\n`);

      const indexes = await runner.query(
        `SELECT c.relname, i.indisvalid, pg_get_indexdef(i.indexrelid) AS def FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname = ANY($1) AND c.relnamespace = to_regnamespace($2)`,
        [['IDX_request_logs_toolId', 'IDX_usage_metrics_toolId', 'IDX_tools_apiId'], SCHEMA],
      );
      expect(indexes).toHaveLength(3);
      for (const index of indexes) expect(index.indisvalid).toBe(true);
      // The leftover was replaced, not kept: it is on toolId and not unique.
      expect(indexes.find((x: any) => x.relname === 'IDX_request_logs_toolId').def).toMatch(/^CREATE INDEX .*\("toolId"\)$/);
    } finally {
      await reader.query('ROLLBACK').catch(() => undefined);
      await reader.release();
      await writer.release();
      await runner.release();
    }
  });
});
