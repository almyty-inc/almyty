/**
 * Real-Postgres spec for model readiness on data that predates the rule.
 *
 * Staging's shape (2026-09-25, org "Northwind AI"): five providers whose
 * key checks passed in July, no `modelsSyncedAt`, and 205 cards a sync
 * imported on 2026-09-09 while a model still needed a check of its own,
 * all `validationStatus = 'never'`. The Models page said "Key works" on
 * every provider and "Not available" on 204 of 205 rows.
 *
 * This runs the real migrations into an isolated schema, writes rows in
 * that shape, and checks that the boot pass, the list endpoint and the
 * data migration each leave every model those providers list usable,
 * with the provider API's `keyChecked` agreeing. The vendor listing and
 * key check are doubles (there is no vendor here); the catalog, the
 * controller and the tables are real.
 *
 * Gated behind RUN_DB_INTEGRATION=1 with the standard DATABASE_* env vars.
 */
import { DataSource, IsNull } from 'typeorm';

import { Organization } from '../../entities/organization.entity';
import { LlmProvider, LlmProviderStatus, LlmProviderType } from '../../entities/llm-provider.entity';
import { Model } from '../../entities/model.entity';
import { ModelVersion } from '../../entities/model-version.entity';
import { ModelCatalogService } from '../../modules/model-catalog/model-catalog.service';
import { ModelCatalogController } from '../../modules/model-catalog/model-catalog.controller';
import { ModelReadinessBackfill1750812500000 } from '../../migrations/1750812500000-ModelReadinessBackfill';
import { ensureSchema } from './isolated-schema.helper';

const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'model_readiness_backfill_test';

jest.setTimeout(120_000);

const connection = {
  type: 'postgres' as const,
  host: process.env.DATABASE_HOST || 'localhost',
  port: Number(process.env.DATABASE_PORT || 5432),
  username: process.env.DATABASE_USERNAME || 'postgres',
  password: process.env.DATABASE_PASSWORD || 'password',
  database: process.env.DATABASE_NAME || 'almyty_test',
};

const JULY = new Date('2026-07-02T10:18:20Z');
const suffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIfDb('model readiness on cards made before the rule (real Postgres)', () => {
  let ds: DataSource;
  let orgId: string;

  const catalogOver = (listed: Record<string, string[]>) =>
    new ModelCatalogService(
      ds.getRepository(Model),
      ds.getRepository(ModelVersion),
      ds.getRepository(LlmProvider),
      {} as any,
      {} as any,
      { fetchModelsFromProvider: async (p: LlmProvider) => (listed[p.name] ?? []).map((id) => ({ id, name: id })) } as any,
    );

  const provider = (name: string, fields: Partial<LlmProvider>) =>
    ds.getRepository(LlmProvider).save(
      ds.getRepository(LlmProvider).create({
        name,
        type: LlmProviderType.OPENAI,
        status: LlmProviderStatus.ACTIVE,
        organizationId: orgId,
        configuration: {},
        isHealthy: true,
        lastHealthCheckAt: JULY,
        modelsSyncedAt: null,
        ...fields,
      } as Partial<LlmProvider>),
    );

  /** A card as the sync before the readiness rule left it: listed, waiting. */
  const oldCard = (p: LlmProvider, vendorModelId: string, fields: Partial<Model> = {}) =>
    ds.getRepository(Model).save(
      ds.getRepository(Model).create({
        organizationId: orgId,
        providerId: p.id,
        providerType: p.type,
        vendorModelId,
        name: vendorModelId,
        status: 'active',
        validationStatus: 'never',
        pricingSource: 'unpriced',
        capabilities: {},
        metadata: { syncedFrom: 'provider_list' },
        ...fields,
      } as Partial<Model>),
    );

  const usableOf = async (p: LlmProvider) =>
    (await ds.getRepository(Model).find({ where: { providerId: p.id } }))
      .filter((m) => m.isSelectable())
      .map((m) => m.vendorModelId)
      .sort();

  beforeAll(async () => {
    await ensureSchema(SCHEMA);
    ds = new DataSource({
      ...connection,
      schema: SCHEMA,
      extra: { options: `-c search_path=${SCHEMA},public`, max: 5 },
      entities: [__dirname + '/../../entities/*.entity{.ts,.js}'],
      migrations: [__dirname + '/../../migrations/*{.ts,.js}'],
      migrationsRun: true,
      dropSchema: true,
      logging: false,
    });
    await ds.initialize();
  });

  beforeEach(async () => {
    const org = await ds.getRepository(Organization).save(
      ds.getRepository(Organization).create({ name: `Northwind AI ${suffix()}`, slug: `northwind-${suffix()}`, plan: 'free', isActive: true } as Partial<Organization>),
    );
    orgId = org.id;
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  it('after the boot pass and boot sync, every model a checked provider lists is usable, synced before or not', async () => {
    const openai = await provider('OpenAI', {});
    // Synced already, so the boot sync never calls it again: before this
    // fix its cards stayed waiting until someone checked the key by hand.
    const mistral = await provider('Mistral', { type: LlmProviderType.MISTRAL, modelsSyncedAt: new Date('2026-09-09T14:26:22Z') });
    // Listed once, key never checked, and not due a boot sync either.
    const unchecked = await provider('Never checked', { type: LlmProviderType.ANTHROPIC, lastHealthCheckAt: null as any, modelsSyncedAt: new Date('2026-09-09T14:26:16Z') });
    for (const id of ['gpt-4o', 'gpt-4o-mini', 'o1']) await oldCard(openai, id);
    for (const id of ['mistral-large', 'mistral-small']) await oldCard(mistral, id);
    await oldCard(unchecked, 'claude-x');
    expect(await usableOf(openai)).toEqual([]);

    const listed = { OpenAI: ['gpt-4o', 'gpt-4o-mini', 'o1', 'gpt-5'], Mistral: ['mistral-large', 'mistral-small'] };
    const catalog = catalogOver(listed);
    const checks: string[] = [];
    // What performHealthCheck writes when the key check passes.
    const keyCheck = async (providerId: string, organizationId: string) => {
      checks.push(providerId);
      await ds.getRepository(LlmProvider).update({ id: providerId, organizationId }, { isHealthy: true, lastHealthCheckAt: new Date() });
      await catalog.applyProviderCheck(organizationId, providerId, { passed: true });
    };

    // Boot: the readiness pass (CatalogSyncProcessor.onApplicationBootstrap),
    // then what the boot sync does for each never-synced provider
    // (CatalogWarmupService.warmProvider: the key check, then the list).
    // Called directly: the job itself takes a database-wide advisory lock
    // that catalog-boot-sync.integration.spec.ts asserts on in parallel.
    await catalog.reconcileReadiness();
    for (const p of await ds.getRepository(LlmProvider).find({ where: { organizationId: orgId, status: LlmProviderStatus.ACTIVE, modelsSyncedAt: IsNull() } })) {
      await keyCheck(p.id, orgId);
      await catalog.syncFromProvider(orgId, p.id);
    }

    expect(await usableOf(openai)).toEqual(['gpt-4o', 'gpt-4o-mini', 'gpt-5', 'o1']);
    expect(await usableOf(mistral)).toEqual(['mistral-large', 'mistral-small']);
    expect(checks).toContain(openai.id);
    expect(checks).not.toContain(mistral.id);
    // A provider whose key was never checked lends its models nothing, and says so.
    expect(await usableOf(unchecked)).toEqual([]);

    // The provider API's "Key works" is the same rule the rows follow.
    const rows = await ds.getRepository(LlmProvider).find({ where: { organizationId: orgId } });
    const keyChecked = Object.fromEntries(rows.map((p) => [p.name, p.maskSensitiveData().keyChecked]));
    expect(keyChecked).toEqual({ OpenAI: true, Mistral: true, 'Never checked': false });
  });

  it('GET /models shows the cards of a checked provider as usable, whatever state they were stored in', async () => {
    const google = await provider('Google', { type: LlmProviderType.GOOGLE, modelsSyncedAt: new Date('2026-09-09T14:26:20Z') });
    for (const id of ['gemini-2.5-flash', 'gemini-2.5-pro']) await oldCard(google, id);
    const controller = new ModelCatalogController(catalogOver({}), {} as any);

    const res = await controller.list({ user: { id: 'u', currentOrganizationId: orgId } }, {} as any);

    expect(res.data.map((c: any) => [c.vendorModelId, c.selectable]).sort()).toEqual([
      ['gemini-2.5-flash', true],
      ['gemini-2.5-pro', true],
    ]);
  });

  it('the data migration marks those cards, keeps a model the vendor refused, and stops calling Ollama Cloud free', async () => {
    const openai = await provider('OpenAI', {});
    const failing = await provider('Failing', { isHealthy: false });
    const cloud = await provider('Ollama Cloud', { type: LlmProviderType.OLLAMA, configuration: { apiUrl: 'https://ollama.com' } as any });
    const own = await provider('Ollama box', { type: LlmProviderType.OLLAMA, configuration: { apiUrl: 'http://10.0.0.5:11434' } as any });
    await oldCard(openai, 'gpt-4o');
    await oldCard(openai, 'gpt-retired', { validationStatus: 'failed', lastValidationError: 'model_not_found' });
    await oldCard(failing, 'x');
    const free = { inPerMTok: 0, outPerMTok: 0, currency: 'USD' };
    await oldCard(cloud, 'deepseek-v4-flash:0731', { pricing: free, pricingSource: 'native', privacyTier: 'local' });
    await oldCard(cloud, 'priced-by-hand', { pricing: free, pricingSource: 'manual', pricingOverride: { inPerMTok: 1, outPerMTok: 2, currency: 'USD' }, privacyTier: 'local' });
    await oldCard(own, 'llama3.2', { pricing: free, pricingSource: 'native', privacyTier: 'local' });

    const runner = ds.createQueryRunner();
    try {
      await new ModelReadinessBackfill1750812500000().up(runner);
      const after = await ds.getRepository(Model).find({ where: { organizationId: orgId } });
      await new ModelReadinessBackfill1750812500000().up(runner);
      const again = await ds.getRepository(Model).find({ where: { organizationId: orgId } });
      const shape = (rows: Model[]) =>
        rows.map((m) => ({ id: m.vendorModelId, v: m.validationStatus, lv: m.lastValidatedAt?.toISOString(), p: m.pricingSource, t: m.privacyTier })).sort((a, b) => a.id.localeCompare(b.id));
      expect(shape(again)).toEqual(shape(after));
    } finally {
      await runner.release();
    }

    const byId = Object.fromEntries((await ds.getRepository(Model).find({ where: { organizationId: orgId } })).map((m) => [m.vendorModelId, m]));
    expect(byId['gpt-4o'].isSelectable()).toBe(true);
    expect(byId['gpt-4o'].metadata).toEqual({ syncedFrom: 'provider_list', checkedBy: 'provider_check' });
    expect(byId['gpt-retired'].validationStatus).toBe('failed');
    expect(byId['x'].validationStatus).toBe('never');

    expect(byId['deepseek-v4-flash:0731']).toMatchObject({ pricing: null, pricingSource: 'unpriced', privacyTier: 'public' });
    expect(byId['priced-by-hand']).toMatchObject({ pricingSource: 'manual', privacyTier: 'local' });
    expect(byId['llama3.2']).toMatchObject({ pricing: free, pricingSource: 'native', privacyTier: 'local' });
  });
});
