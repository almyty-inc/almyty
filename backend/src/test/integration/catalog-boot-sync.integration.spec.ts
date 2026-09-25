/**
 * Real-Postgres spec for the catalog boot sync (CatalogWarmupService).
 *
 * Every API instance queues the boot sync; the one that takes the session
 * advisory lock does the work and the rest return. A double can only
 * model that lock, so this spec runs two instances, each with its own
 * connection pool, against one real Postgres, with the first held open
 * mid-run while the second tries. It also reads the pending providers
 * through the real `modelsSyncedAt` column the migration adds.
 *
 * The provider key check and the vendor listing are doubles (there is
 * no vendor here): the check writes the provider row and the catalog the
 * way LlmProvidersService.performHealthCheck does. The catalog is the
 * real service over the real tables.
 *
 * Gated behind RUN_DB_INTEGRATION=1 with the standard DATABASE_* env
 * vars; builds its schema by running the migrations into an isolated
 * Postgres schema.
 */
import { DataSource } from 'typeorm';

import { Organization } from '../../entities/organization.entity';
import { LlmProvider, LlmProviderStatus, LlmProviderType } from '../../entities/llm-provider.entity';
import { Model } from '../../entities/model.entity';
import { ModelVersion } from '../../entities/model-version.entity';
import { ModelCatalogService } from '../../modules/model-catalog/model-catalog.service';
import { BOOT_SYNC_LOCK_KEY, CatalogWarmupService } from '../../modules/model-catalog/catalog-warmup.service';
import { FakeRedis } from '../fake-redis';
import { ensureSchema } from './isolated-schema.helper';

const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'catalog_boot_sync_test';

jest.setTimeout(120_000);

const connection = {
  type: 'postgres' as const,
  host: process.env.DATABASE_HOST || 'localhost',
  port: Number(process.env.DATABASE_PORT || 5432),
  username: process.env.DATABASE_USERNAME || 'postgres',
  password: process.env.DATABASE_PASSWORD || 'password',
  database: process.env.DATABASE_NAME || 'almyty_test',
};

const LIST = [{ id: 'gpt-5', name: 'gpt-5' }, { id: 'gpt-5-mini', name: 'gpt-5-mini' }];

describeIfDb('catalog boot sync across instances (real Postgres)', () => {
  let first: DataSource;
  let second: DataSource;
  let orgId: string;
  const redis = new FakeRedis();
  let checks: string[] = [];
  let gate: Promise<void> | null = null;
  let entered: () => void = () => undefined;

  const instance = (ds: DataSource) => {
    const catalog = new ModelCatalogService(
      ds.getRepository(Model),
      ds.getRepository(ModelVersion),
      ds.getRepository(LlmProvider),
      {} as any,
      {} as any,
      { fetchModelsFromProvider: async () => LIST } as any,
    );
    const llmProviders = {
      // What performHealthCheck writes when the key check passes.
      performHealthCheck: async (providerId: string, organizationId: string) => {
        checks.push(providerId);
        entered();
        if (gate) await gate;
        await ds.getRepository(LlmProvider).update({ id: providerId, organizationId }, { isHealthy: true, lastHealthCheckAt: new Date(), lastError: null as any });
        await catalog.applyProviderCheck(organizationId, providerId, { passed: true });
        return { isHealthy: true };
      },
    };
    return new CatalogWarmupService(
      ds.getRepository(LlmProvider),
      ds.getRepository(Model),
      catalog,
      llmProviders as any,
      ds,
      redis as any,
      { concurrency: 2, vendorGapMs: 0, debounceMs: 60_000, loadWaitMs: 1_000 },
    );
  };

  beforeAll(async () => {
    await ensureSchema(SCHEMA);
    const options = {
      ...connection,
      schema: SCHEMA,
      extra: { options: `-c search_path=${SCHEMA},public`, max: 5 },
      entities: [__dirname + '/../../entities/*.entity{.ts,.js}'],
      logging: false,
    };
    first = new DataSource({ ...options, migrations: [__dirname + '/../../migrations/*{.ts,.js}'], migrationsRun: true, dropSchema: true });
    await first.initialize();
    // The second instance: its own pool, so its own Postgres sessions.
    second = new DataSource(options);
    await second.initialize();

    const org = await first.getRepository(Organization).save(
      first.getRepository(Organization).create({ name: 'boot-sync', slug: `boot-sync-${Date.now()}`, plan: 'free', isActive: true } as Partial<Organization>),
    );
    orgId = org.id;
  });

  afterAll(async () => {
    if (second?.isInitialized) await second.destroy();
    if (first?.isInitialized) await first.destroy();
  });

  const provider = (name: string, modelsSyncedAt: Date | null) =>
    first.getRepository(LlmProvider).save(
      first.getRepository(LlmProvider).create({
        name,
        type: LlmProviderType.OPENAI,
        status: LlmProviderStatus.ACTIVE,
        organizationId: orgId,
        configuration: { model: 'gpt-5' },
        modelsSyncedAt,
      } as Partial<LlmProvider>),
    );

  it('one instance runs it while the other returns; only never-synced providers are checked; their models become usable', async () => {
    const legacy = await provider('legacy', null);
    const done = await provider('already synced', new Date('2026-09-01T00:00:00Z'));

    let open!: () => void;
    gate = new Promise<void>((resolve) => (open = resolve));
    const reached = new Promise<void>((resolve) => (entered = resolve));

    const running = instance(first).syncNeverSynced('boot');
    await reached;
    const other = await instance(second).syncNeverSynced('boot');
    open();
    gate = null;
    const result = await running;

    expect(other).toMatchObject({ ran: false, providers: 0 });
    expect(result).toMatchObject({ ran: true, providers: 1, synced: 1, failed: 0 });
    expect(checks).toEqual([legacy.id]);

    const rows = await first.getRepository(LlmProvider).find({ where: { organizationId: orgId } });
    expect(rows.find((p) => p.id === legacy.id)?.modelsSyncedAt).toBeInstanceOf(Date);
    expect(rows.find((p) => p.id === done.id)?.modelsSyncedAt?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    const usable = (await first.getRepository(Model).find({ where: { providerId: legacy.id } })).filter((m) => m.isSelectable());
    expect(usable.map((m) => m.vendorModelId).sort()).toEqual(['gpt-5', 'gpt-5-mini']);

    // The lock is free once the run is over, and nothing is left to do.
    checks = [];
    expect(await instance(second).syncNeverSynced('boot')).toMatchObject({ ran: true, providers: 0 });
    expect(checks).toEqual([]);
  });

  it('the lock goes with the session: an instance that dies mid-run does not block the next one', async () => {
    const holder = new DataSource({ ...connection, extra: { max: 1 } });
    await holder.initialize();
    const [{ locked }] = await holder.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [BOOT_SYNC_LOCK_KEY]);
    expect(locked).toBe(true);
    expect(await instance(second).syncNeverSynced('boot')).toMatchObject({ ran: false });
    await holder.destroy();
    expect(await instance(second).syncNeverSynced('boot')).toMatchObject({ ran: true });
  });
});
