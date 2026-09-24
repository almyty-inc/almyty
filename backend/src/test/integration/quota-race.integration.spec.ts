/**
 * Real-Postgres concurrency spec for the per-organization quotas
 * (`settings.maxTools`, `settings.maxGateways`, `settings.maxApis`).
 *
 * A quota check is COUNT then INSERT. Unserialised, N concurrent
 * creators all count the same number, all pass, and the organization
 * ends up over its limit -- by a whole batch when batches race. The
 * helpers in tools/tool-quota.ts, gateways/gateway-quota.ts and
 * apis/api-quota.ts run the check and the insert in one transaction
 * behind a per-organization advisory lock. Mocked specs cannot show that
 * a lock serialises anything; this one fires real concurrent transactions
 * at a real Postgres and asserts the final row count never exceeds the
 * limit.
 *
 * Every insert callback sleeps between the check and the write, so
 * without the lock every creator would pass the check before any of them
 * inserted: the overshoot is deterministic, not a timing lottery.
 *
 * Schema imports are raced through the real ApisToolGeneratorHelper and
 * ToolsOperationHelper: written row by row, two imports competing for the
 * last slots each landed part of their operations; written as one batch
 * (writeToolBatch), one lands whole and the other writes nothing.
 *
 * Gated behind RUN_DB_INTEGRATION=1 with the standard DATABASE_* env vars
 * (see bump-stats.integration.spec.ts); builds its schema by running the
 * migrations into an isolated Postgres schema.
 */
import { DataSource, EntityManager, Not } from 'typeorm';

import { Organization } from '../../entities/organization.entity';
import { Tool, ToolStatus, ToolType } from '../../entities/tool.entity';
import { Gateway, GatewayType } from '../../entities/gateway.entity';
import { Api } from '../../entities/api.entity';
import { ApiSchema } from '../../entities/api-schema.entity';
import { Operation } from '../../entities/operation.entity';
import { ToolQuotaExceededException, withToolQuota } from '../../modules/tools/tool-quota';
import { GatewayQuotaExceededException, withGatewayQuota } from '../../modules/gateways/gateway-quota';
import { ApiQuotaExceededException, withApiQuota } from '../../modules/apis/api-quota';
import { RunnerCapabilityPublisher } from '../../modules/runner/runner-capability.publisher';
import { ToolsOperationHelper } from '../../modules/tools/tools-operation.helper';
import { ApisToolGeneratorHelper } from '../../modules/apis/apis-tool-generator.helper';

const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'quota_race_test';

jest.setTimeout(120_000);

const connection = {
  type: 'postgres' as const,
  host: process.env.DATABASE_HOST || '127.0.0.1',
  port: Number(process.env.DATABASE_PORT || 5432),
  username: process.env.DATABASE_USERNAME || 'postgres',
  password: process.env.DATABASE_PASSWORD || 'postgres',
  database: process.env.DATABASE_NAME || 'almyty_test',
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const API_BASE = 'https://api.example.test';

describeIfDb('quota enforcement under concurrency (real Postgres)', () => {
  let ds: DataSource;
  let seq = 0;

  beforeAll(async () => {
    const bootstrap = new DataSource(connection);
    await bootstrap.initialize();
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await bootstrap.destroy();

    ds = new DataSource({
      ...connection,
      schema: SCHEMA,
      extra: { options: `-c search_path=${SCHEMA},public`, max: 40 },
      migrations: [__dirname + '/../../migrations/*{.ts,.js}'],
      migrationsRun: true,
      dropSchema: true,
      entities: [__dirname + '/../../entities/*.entity{.ts,.js}'],
      logging: false,
    });
    await ds.initialize();
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  async function org(settings: Organization['settings']): Promise<string> {
    seq += 1;
    const saved = await ds.getRepository(Organization).save(
      ds.getRepository(Organization).create({
        name: `quota-race-${seq}`,
        slug: `quota-race-${seq}-${Date.now()}`,
        plan: 'free',
        isActive: true,
        settings,
      } as Partial<Organization>),
    );
    return saved.id;
  }

  const toolRow = (tx: EntityManager, organizationId: string, name: string) =>
    tx.getRepository(Tool).save(
      tx.getRepository(Tool).create({
        name,
        description: 'race',
        organizationId,
        type: ToolType.FUNCTION,
        status: ToolStatus.ACTIVE,
        parameters: { type: 'object', properties: {} },
      } as Partial<Tool>),
    );

  const gatewayRow = (tx: EntityManager, organizationId: string, n: string, isSystem = false) =>
    tx.getRepository(Gateway).save(
      tx.getRepository(Gateway).create({
        name: `gw-${n}`,
        endpoint: `/gw-${n}`,
        type: GatewayType.MCP,
        organizationId,
        configuration: { transport: 'http' },
        isSystem,
      } as Partial<Gateway>),
    );

  const apiRow = (tx: EntityManager, organizationId: string, name: string) =>
    tx.getRepository(Api).save(tx.getRepository(Api).create({ name, baseUrl: API_BASE, organizationId } as Partial<Api>));
  const tools = (organizationId: string) => ds.getRepository(Tool).count({ where: { organizationId } });
  const gateways = (organizationId: string) =>
    ds.getRepository(Gateway).count({ where: { organizationId, isSystem: false } });

  /** Settle every promise; count fulfilled and quota-refused. */
  async function race<T>(jobs: Array<() => Promise<T>>, refusal: new (...a: any[]) => Error) {
    const results = await Promise.allSettled(jobs.map((job) => job()));
    const other = results.filter((r) => r.status === 'rejected' && !(r.reason instanceof refusal));
    if (other.length) throw (other[0] as PromiseRejectedResult).reason;
    return {
      ok: results.filter((r) => r.status === 'fulfilled').length,
      refused: results.filter((r) => r.status === 'rejected').length,
    };
  }

  it('10 parallel single-tool creates against maxTools=3 end at exactly 3', async () => {
    const orgId = await org({ maxTools: 3 });
    const { ok, refused } = await race(
      Array.from({ length: 10 }, (_, i) => () =>
        withToolQuota(ds.manager, orgId, 1, async (tx) => {
          await pause(50);
          return toolRow(tx, orgId, `single_${i}`);
        }),
      ),
      ToolQuotaExceededException,
    );
    expect(await tools(orgId)).toBe(3);
    expect(ok).toBe(3);
    expect(refused).toBe(7);
  });

  it('parallel batches never overshoot: a batch fits whole or is refused whole', async () => {
    const orgId = await org({ maxTools: 5 });
    const { ok } = await race(
      Array.from({ length: 6 }, (_, b) => () =>
        withToolQuota(ds.manager, orgId, 2, async (tx) => {
          await pause(50);
          await toolRow(tx, orgId, `batch_${b}_a`);
          return toolRow(tx, orgId, `batch_${b}_b`);
        }),
      ),
      ToolQuotaExceededException,
    );
    expect(ok).toBe(2);
    expect(await tools(orgId)).toBe(4);
  });

  it('parallel runner capability publishes (a real batch path) stay within maxTools', async () => {
    const orgId = await org({ maxTools: 7 });
    const publisher = new RunnerCapabilityPublisher(ds.getRepository(Tool));
    const runner = (i: number) =>
      ({ id: `00000000-0000-4000-8000-00000000000${i}`, name: `box${i}`, organizationId: orgId, ownerUserId: null, visibility: 'org' }) as any;
    await race(
      Array.from({ length: 6 }, (_, i) => () => publisher.publish(runner(i))),
      ToolQuotaExceededException,
    );
    // Three capabilities per runner: two publishes fit (6), the rest are refused whole.
    expect(await tools(orgId)).toBe(6);
  });

  it('an organization without a limit is not serialised or capped', async () => {
    const orgId = await org({});
    const { ok } = await race(
      Array.from({ length: 10 }, (_, i) => () => withToolQuota(ds.manager, orgId, 1, (tx) => toolRow(tx, orgId, `free_${i}`))),
      ToolQuotaExceededException,
    );
    expect(ok).toBe(10);
  });

  it('10 parallel gateway creates against maxGateways=2 end at exactly 2', async () => {
    const orgId = await org({ maxGateways: 2 });
    const { ok, refused } = await race(
      Array.from({ length: 10 }, (_, i) => () =>
        withGatewayQuota(ds.manager, orgId, 1, async (tx) => {
          await pause(50);
          return gatewayRow(tx, orgId, `${seq}-${i}`);
        }),
      ),
      GatewayQuotaExceededException,
    );
    expect(await gateways(orgId)).toBe(2);
    expect(ok).toBe(2);
    expect(refused).toBe(8);
  });

  it('the system gateway does not use up a slot', async () => {
    const orgId = await org({ maxGateways: 1 });
    await gatewayRow(ds.manager, orgId, `${seq}-system`, true);
    await withGatewayQuota(ds.manager, orgId, 1, (tx) => gatewayRow(tx, orgId, `${seq}-tenant`));
    await expect(
      withGatewayQuota(ds.manager, orgId, 1, (tx) => gatewayRow(tx, orgId, `${seq}-over`)),
    ).rejects.toBeInstanceOf(GatewayQuotaExceededException);
    expect(await gateways(orgId)).toBe(1);
  });

  it('the tool and gateway locks are independent', async () => {
    const orgId = await org({ maxTools: 1, maxGateways: 1 });
    // Hold the tool-quota lock while a gateway create runs: it must not wait.
    let gatewayDone = false;
    await withToolQuota(ds.manager, orgId, 1, async (tx) => {
      await withGatewayQuota(ds.manager, orgId, 1, (gtx) => gatewayRow(gtx, orgId, `${seq}-indep`));
      gatewayDone = true;
      return toolRow(tx, orgId, 'indep');
    });
    expect(gatewayDone).toBe(true);
  });

  it('10 parallel API creates against maxApis=3 end at exactly 3', async () => {
    const orgId = await org({ maxApis: 3 });
    const { ok, refused } = await race(
      Array.from({ length: 10 }, (_, i) => () =>
        withApiQuota(ds.manager, orgId, 1, async (tx) => {
          await pause(50);
          return apiRow(tx, orgId, `api-${i}`);
        }),
      ),
      ApiQuotaExceededException,
    );
    expect(await ds.getRepository(Api).count({ where: { organizationId: orgId } })).toBe(3);
    expect(ok).toBe(3);
    expect(refused).toBe(7);
  });

  it('a soft-deleted tool frees its slot', async () => {
    const orgId = await org({ maxTools: 2 });
    await withToolQuota(ds.manager, orgId, 1, (tx) => toolRow(tx, orgId, 'keep'));
    const gone = await withToolQuota(ds.manager, orgId, 1, (tx) => toolRow(tx, orgId, 'gone'));
    await expect(
      withToolQuota(ds.manager, orgId, 1, (tx) => toolRow(tx, orgId, 'over')),
    ).rejects.toBeInstanceOf(ToolQuotaExceededException);
    // The delete path: the row stays, its status says it is gone.
    await ds.getRepository(Tool).update({ id: gone.id }, { status: ToolStatus.DELETED });
    await withToolQuota(ds.manager, orgId, 1, (tx) => toolRow(tx, orgId, 'room-again'));
    expect(await tools(orgId)).toBe(3);
    expect(await ds.getRepository(Tool).count({ where: { organizationId: orgId, status: Not(ToolStatus.DELETED) } })).toBe(2);
  });

  describe('schema import is all-or-nothing against maxTools', () => {
    /** A schema-import tool generator wired to the real tables. */
    function generator() {
      const noVersions = { createToolVersion: async () => undefined };
      const ops = new ToolsOperationHelper(
        ds.getRepository(Tool),
        ds.getRepository(Operation),
        ds.getRepository(ApiSchema),
        noVersions as any,
      );
      // ToolsService only delegates these to ToolsOperationHelper.
      const toolsService = new Proxy(
        {
          ...noVersions,
          findByName: (name: string, organizationId: string) =>
            ds.getRepository(Tool).findOne({ where: { name, organizationId } }),
        } as Record<string, any>,
        proxyTo(ops),
      );
      // ApisService.findOne, as the import path calls it: operations loaded.
      const apisService = {
        findOne: (id: string, organizationId: string) =>
          ds.getRepository(Api).findOne({ where: { id, organizationId }, relations: { operations: true } }),
      };
      return new ApisToolGeneratorHelper(ds.getRepository(Api), toolsService as any, apisService as any);
    }
    /** Fall through to the operation helper for anything the target lacks. */
    const proxyTo = (ops: any): ProxyHandler<Record<string, any>> => ({
      get: (target, prop: string) =>
        prop in target ? target[prop] : typeof ops[prop] === 'function' ? ops[prop].bind(ops) : undefined,
    });
    const operationRow = (apiId: string, i: number) =>
      ds.getRepository(Operation).create({
        name: `op${i}`,
        operationId: `op${i}`,
        apiId,
        method: 'GET',
        endpoint: `/things/${i}`,
        isActive: true,
      } as Partial<Operation>);
    /** Tools generated from the API called `apiName` (its name is in their metadata). */
    const toolsOf = (organizationId: string, apiName: string) =>
      ds
        .getRepository(Tool)
        .createQueryBuilder('t')
        .where('t."organizationId" = :organizationId', { organizationId })
        .andWhere(`t.metadata::jsonb -> 'sourceApi' ->> 'name' = :apiName`, { apiName })
        .getCount();
    async function apiWithOperations(organizationId: string, name: string, n: number): Promise<string> {
      const apis = ds.getRepository(Api);
      const api = await apis.save(apis.create({ name, baseUrl: API_BASE, organizationId } as Partial<Api>));
      await ds.getRepository(Operation).save(Array.from({ length: n }, (_, i) => operationRow(api.id, i)));
      return api.id;
    }
    it('two imports racing for the last slots: one lands whole, the other writes nothing', async () => {
      const orgId = await org({ maxTools: 30 });
      const a = await apiWithOperations(orgId, `alpha${seq}`, 20);
      const b = await apiWithOperations(orgId, `beta${seq}`, 20);
      const gen = generator();
      const results = await Promise.allSettled([gen.generateToolsFromApi(a, orgId), gen.generateToolsFromApi(b, orgId)]);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      for (const r of rejected) expect(r.reason).toBeInstanceOf(ToolQuotaExceededException);
      const perApi = [await toolsOf(orgId, `alpha${seq}`), await toolsOf(orgId, `beta${seq}`)].sort((x, y) => x - y);
      // Never a partial import: each API has all of its tools or none.
      expect(perApi).toEqual([0, 20]);
      expect(rejected).toHaveLength(1);
      expect(await tools(orgId)).toBe(20);
    });
    it('a refused import writes nothing, not even the updates it planned', async () => {
      const orgId = await org({ maxTools: 3 });
      const a = await apiWithOperations(orgId, `gamma${seq}`, 2);
      const gen = generator();
      await gen.generateToolsFromApi(a, orgId);
      expect(await tools(orgId)).toBe(2);
      // Upstream changes one operation and adds two: two updates and two
      // new rows, with one slot left.
      const first = await ds.getRepository(Operation).findOneByOrFail({ apiId: a, name: 'op0' });
      await ds.getRepository(Operation).update({ id: first.id }, { description: 'changed upstream' });
      await ds.getRepository(Operation).save(operationRow(a, 2));
      await ds.getRepository(Operation).save(operationRow(a, 3));
      await expect(gen.generateToolsFromApi(a, orgId)).rejects.toBeInstanceOf(ToolQuotaExceededException);
      expect(await tools(orgId)).toBe(2);
      const rows = await ds.getRepository(Tool).find({ where: { organizationId: orgId } });
      expect(rows.map((t) => t.description)).not.toContain('changed upstream');
    });
  });
});
