/**
 * Real-Postgres concurrency spec for the per-organization quotas
 * (`settings.maxTools`, `settings.maxGateways`).
 *
 * A quota check is COUNT then INSERT. Unserialised, N concurrent
 * creators all count the same number, all pass, and the organization
 * ends up over its limit -- by a whole batch when batches race. The
 * helpers in tools/tool-quota.ts and gateways/gateway-quota.ts run the
 * check and the insert in one transaction behind a per-organization
 * advisory lock. Mocked specs cannot show that a lock serialises
 * anything; this one fires real concurrent transactions at a real
 * Postgres and asserts the final row count never exceeds the limit.
 *
 * Every insert callback sleeps between the check and the write, so
 * without the lock every creator would pass the check before any of them
 * inserted: the overshoot is deterministic, not a timing lottery.
 *
 * Gated behind RUN_DB_INTEGRATION=1 with the standard DATABASE_* env vars
 * (see bump-stats.integration.spec.ts); builds its schema by running the
 * migrations into an isolated Postgres schema.
 */
import { DataSource, EntityManager } from 'typeorm';

import { Organization } from '../../entities/organization.entity';
import { Tool, ToolStatus, ToolType } from '../../entities/tool.entity';
import { Gateway, GatewayType } from '../../entities/gateway.entity';
import { ToolQuotaExceededException, withToolQuota } from '../../modules/tools/tool-quota';
import { GatewayQuotaExceededException, withGatewayQuota } from '../../modules/gateways/gateway-quota';
import { RunnerCapabilityPublisher } from '../../modules/runner/runner-capability.publisher';

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
});
