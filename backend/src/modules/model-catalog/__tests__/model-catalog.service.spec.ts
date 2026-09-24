import { Model } from '../../../entities/model.entity';
import { LlmProvider, LlmProviderStatus, LlmProviderType } from '../../../entities/llm-provider.entity';
import { AuditAction } from '../../../entities/audit-log.entity';
import { ModelCatalogService } from '../model-catalog.service';
import { fakeRepository } from '../../../test/fake-repository';

/**
 * The shared truthful table, with `rows` read as the table holds it now.
 * The double this replaces stored and handed out the caller's own object
 * and was only ever seeded with one organization, so a dropped save or
 * organization predicate in this service changed nothing it could see.
 */
function memRepo<T extends { id?: string }>(seed: T[] = [], make: () => T) {
  const repo = fakeRepository<T>({ seed, make, idPrefix: 'id' });
  const current = repo.rows;
  Object.defineProperty(repo, 'rows', { get: () => current() });
  return repo as unknown as Omit<typeof repo, 'rows'> & { readonly rows: T[] };
}

describe('ModelCatalogService', () => {
  let models: ReturnType<typeof memRepo<Model>>;
  let providers: ReturnType<typeof memRepo<LlmProvider>>;
  let runner: { callWithRetries: jest.Mock; validateProviderConfiguration: jest.Mock };
  let router: { providerFor: jest.Mock };
  let audit: { log: jest.Mock };
  let priceFeed: { lookup: jest.Mock };
  let svc: ModelCatalogService;

  const storedProvider = Object.assign(new LlmProvider(), {
    id: 'p1', organizationId: 'org', name: 'OpenAI', type: LlmProviderType.OPENAI, status: LlmProviderStatus.ACTIVE, isHealthy: true, configuration: { apiKey: 'k' },
  });

  beforeEach(() => {
    models = memRepo<Model>([], () => new Model());
    providers = memRepo<LlmProvider>([storedProvider], () => new LlmProvider());
    runner = { callWithRetries: jest.fn(), validateProviderConfiguration: jest.fn() };
    router = { providerFor: jest.fn() };
    audit = { log: jest.fn().mockResolvedValue(null) };
    priceFeed = { lookup: jest.fn().mockReturnValue(null) };
    svc = new ModelCatalogService(
      models as any,
      fakeRepository([
        { id: 'v-mine', organizationId: 'org', name: 'mine' },
        { id: 'v-theirs', organizationId: 'org2', name: 'theirs' },
      ]) as any,
      providers as any,
      router as any,
      runner as any,
      { fetchModelsFromProvider: jest.fn(), getDefaultCapabilities: jest.fn().mockReturnValue({ supportedModels: [] }) } as any,
      priceFeed as any,
      undefined,
      audit as any,
    );
  });

  it('registers a card against a stored provider, unvalidated and priced from the feed', async () => {
    priceFeed.lookup.mockReturnValue({ inPerMTok: 2, outPerMTok: 10, currency: 'USD', source: 'feed:litellm', contextLength: 200000, fetchedAt: new Date() });
    const card = await svc.register('org', { name: 'Sonnet', vendorModelId: 'claude-sonnet-5', providerId: 'p1' }, 'u');
    expect(card.validationStatus).toBe('never');
    expect(card.isSelectable()).toBe(false);
    expect(card.providerType).toBe('openai');
    expect(card.pricing).toEqual({ inPerMTok: 2, outPerMTok: 10, currency: 'USD' });
    expect(card.pricingSource).toBe('feed:litellm');
    expect(card.contextLength).toBe(200000);
    expect(priceFeed.lookup).toHaveBeenCalledWith('openai', 'claude-sonnet-5');
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.MODEL_REGISTERED, resourceId: card.id, userId: 'u' }));
  });

  it('refuses a card that cannot be called and a duplicate vendor id', async () => {
    await expect(svc.register('org', { name: 'x', vendorModelId: 'm' })).rejects.toMatchObject({ response: { code: 'MODEL_NOT_CALLABLE' } });
    await svc.register('org', { name: 'a', vendorModelId: 'm', providerId: 'p1' });
    await expect(svc.register('org', { name: 'b', vendorModelId: 'm', providerId: 'p1' })).rejects.toMatchObject({ response: { code: 'MODEL_EXISTS' } });
  });

  it('validate: a passing call makes the card selectable and records latency', async () => {
    const card = await svc.register('org', { name: 'a', vendorModelId: 'm', providerId: 'p1' });
    router.providerFor.mockResolvedValue(storedProvider);
    runner.callWithRetries.mockResolvedValue({ message: { content: 'ready' }, usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 }, cost: 0, model: 'm', responseTime: 40 });
    const outcome = await svc.validate('org', card.id, 'u');
    expect(outcome.passed).toBe(true);
    expect(runner.callWithRetries.mock.calls[0][1]).toMatchObject({ model: 'm', maxTokens: 8 });
    expect(outcome.model.validationStatus).toBe('passed');
    expect(outcome.model.isSelectable()).toBe(true);
    expect(outcome.model.measuredLatencyMs?.p50).toEqual(expect.any(Number));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.MODEL_VALIDATED, details: expect.objectContaining({ passed: true }) }));
  });

  it('validate: a failing call records the reason and keeps the card unselectable', async () => {
    const card = await svc.register('org', { name: 'a', vendorModelId: 'gone', providerId: 'p1' });
    router.providerFor.mockResolvedValue(storedProvider);
    runner.callWithRetries.mockRejectedValue(new Error('Model "gone" was not found'));
    const outcome = await svc.validate('org', card.id);
    expect(outcome.passed).toBe(false);
    expect(outcome.model.validationStatus).toBe('failed');
    expect(outcome.model.lastValidationError).toContain('not found');
    expect(outcome.model.status).toBe('error');
    expect(outcome.model.isSelectable()).toBe(false);
  });

  it('update: a manual price override wins and is audited; clearing it falls back to the feed', async () => {
    priceFeed.lookup.mockReturnValue({ inPerMTok: 1, outPerMTok: 3, currency: 'USD', source: 'feed:openrouter', fetchedAt: new Date() });
    const card = await svc.register('org', { name: 'a', vendorModelId: 'm', providerId: 'p1' });
    const withOverride = await svc.update('org', card.id, { pricingOverride: { inPerMTok: 0.5, outPerMTok: 0.5 } }, 'u');
    expect(withOverride.effectivePricing()).toEqual({ inPerMTok: 0.5, outPerMTok: 0.5, currency: 'USD' });
    expect(withOverride.pricingSource).toBe('manual');
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.MODEL_PRICE_UPDATED }));
    const cleared = await svc.update('org', card.id, { pricingOverride: null });
    expect(cleared.effectivePricing()).toEqual({ inPerMTok: 1, outPerMTok: 3, currency: 'USD' });
    expect(cleared.pricingSource).toBe('feed:openrouter');
  });

  it('syncFromProvider imports listed models once, as unvalidated cards', async () => {
    (svc as any).modelsHelper.fetchModelsFromProvider.mockResolvedValue([{ id: 'gpt-x', name: 'GPT X' }, { id: 'gpt-y', name: 'GPT Y' }]);
    const first = await svc.syncFromProvider('org', 'p1');
    expect(first.created.map((c) => c.vendorModelId)).toEqual(['gpt-x', 'gpt-y']);
    expect(first.created.every((c) => c.validationStatus === 'never' && c.privacyTier === 'public')).toBe(true);
    const second = await svc.syncFromProvider('org', 'p1');
    expect(second.created).toEqual([]);
    expect(second.skipped).toBe(2);
  });

  describe('auto-population', () => {
    const fetch = () => (svc as any).modelsHelper.fetchModelsFromProvider as jest.Mock;

    it('sync retires cards the provider no longer lists and reinstates them when they return', async () => {
      fetch().mockResolvedValueOnce([{ id: 'x' }, { id: 'y' }]);
      await svc.syncFromProvider('org', 'p1');
      fetch().mockResolvedValueOnce([{ id: 'x' }]);
      const second = await svc.syncFromProvider('org', 'p1');
      expect(second.retired.map((c) => c.vendorModelId)).toEqual(['y']);
      const y = models.rows.find((m) => m.vendorModelId === 'y')!;
      expect(y.status).toBe('inactive');
      expect(y.metadata?.retiredAt).toEqual(expect.any(String));
      expect(y.metadata?.retiredReason).toBe('not listed by provider');
      expect(models.rows).toHaveLength(2);
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.UPDATE, details: expect.objectContaining({ retired: ['y'] }) }));
      fetch().mockResolvedValueOnce([{ id: 'x' }, { id: 'y' }]);
      const third = await svc.syncFromProvider('org', 'p1');
      expect(third.reinstated.map((c) => c.vendorModelId)).toEqual(['y']);
      expect(third.created).toEqual([]);
      const back = models.row(y.id)!;
      expect(back.status).toBe('active');
      expect(back.metadata?.retiredAt).toBeUndefined();
      expect(back.metadata?.reinstatedAt).toEqual(expect.any(String));
    });

    it('sync leaves a card an admin set inactive alone and retires nothing from an empty list', async () => {
      fetch().mockResolvedValueOnce([{ id: 'x' }, { id: 'y' }]);
      await svc.syncFromProvider('org', 'p1');
      const y = models.rows.find((m) => m.vendorModelId === 'y')!;
      await svc.update('org', y.id, { status: 'inactive' });
      fetch().mockResolvedValueOnce([]);
      const empty = await svc.syncFromProvider('org', 'p1');
      expect(empty.retired).toEqual([]);
      expect(models.rows.find((m) => m.vendorModelId === 'x')!.status).toBe('active');
      fetch().mockResolvedValueOnce([{ id: 'x' }, { id: 'y' }]);
      const again = await svc.syncFromProvider('org', 'p1');
      expect(again.reinstated).toEqual([]);
      expect(models.row(y.id)?.status).toBe('inactive');
    });

    it('syncAll walks every active provider and reports a provider that fails to list', async () => {
      providers.seed(Object.assign(new LlmProvider(), { id: 'p2', organizationId: 'org', name: 'Broken', type: LlmProviderType.MISTRAL, status: LlmProviderStatus.ACTIVE, isHealthy: true, configuration: {} }));
      providers.seed(Object.assign(new LlmProvider(), { id: 'p3', organizationId: 'org', name: 'Off', type: LlmProviderType.OPENAI, status: LlmProviderStatus.INACTIVE, isHealthy: true, configuration: {} }));
      fetch().mockImplementation(async (p: LlmProvider) => {
        if (p.id === 'p2') throw new Error('listing failed');
        return [{ id: 'gpt-x' }];
      });
      const summary = await svc.syncAll('org', 'u');
      expect(summary.created.map((c) => c.vendorModelId)).toEqual(['gpt-x']);
      expect(summary.providers).toEqual([
        { providerId: 'p1', name: 'OpenAI', created: 1, skipped: 0, retired: 0, reinstated: 0 },
        { providerId: 'p2', name: 'Broken', created: 0, skipped: 0, retired: 0, reinstated: 0, error: 'listing failed' },
      ]);
    });

    it('syncInBackground shares an in-flight sync, honours the cooldown and never rejects', async () => {
      let release!: (v: any[]) => void;
      fetch().mockReturnValueOnce(new Promise((r) => { release = r; }));
      const a = svc.syncInBackground('org', 'p1', 'provider_created');
      const b = svc.syncInBackground('org', 'p1', 'health_check');
      expect(b).toBe(a);
      release([{ id: 'gpt-x', name: 'GPT X' }]);
      expect((await a)?.created.map((c) => c.vendorModelId)).toEqual(['gpt-x']);
      expect(fetch()).toHaveBeenCalledTimes(1);
      expect(await svc.syncInBackground('org', 'p1', 'health_check')).toBeNull();
      fetch().mockResolvedValueOnce([{ id: 'gpt-x', name: 'GPT X' }]);
      expect((await svc.syncInBackground('org', 'p1', 'manual', 0))?.skipped).toBe(1);
      expect(await svc.syncInBackground('org', 'missing', 'provider_created', 0)).toBeNull();
    });

    it('backfill syncs only active providers that have no cards yet', async () => {
      providers.seed(Object.assign(new LlmProvider(), { id: 'p2', organizationId: 'org2', name: 'Other', type: LlmProviderType.OPENAI, status: LlmProviderStatus.ACTIVE, isHealthy: true, configuration: {} }));
      fetch().mockResolvedValueOnce([{ id: 'a' }]);
      await svc.syncFromProvider('org', 'p1');
      fetch().mockClear();
      fetch().mockResolvedValue([{ id: 'b' }]);
      const result = await svc.backfill();
      expect(result).toEqual({ providers: 2, synced: 1, created: 1, failed: 0 });
      expect(fetch()).toHaveBeenCalledTimes(1);
      expect(fetch().mock.calls[0][0].id).toBe('p2');
      expect(models.rows.find((m) => m.vendorModelId === 'b')?.organizationId).toBe('org2');
    });

    it('recordExternalValidation: a passing health check creates the card if needed and makes it selectable', async () => {
      const card = await svc.recordExternalValidation('org', 'p1', 'gpt-probe', { passed: true, latencyMs: 120, source: 'health_check' });
      expect(card?.validationStatus).toBe('passed');
      expect(card?.isSelectable()).toBe(true);
      expect(card?.measuredLatencyMs).toMatchObject({ p50: 120, p95: 120 });
      expect(card?.metadata?.syncedFrom).toBe('health_check');
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.MODEL_VALIDATED, details: expect.objectContaining({ passed: true, source: 'health_check' }) }));
      const again = await svc.recordExternalValidation('org', 'p1', 'gpt-probe', { passed: true, latencyMs: 90 });
      expect(again?.id).toBe(card?.id);
      expect(models.rows).toHaveLength(1);
    });

    it('recordExternalValidation: a failure marks an existing card and ignores an unknown one', async () => {
      expect(await svc.recordExternalValidation('org', 'p1', 'never-seen', { passed: false, error: 'gone' })).toBeNull();
      expect(models.rows).toHaveLength(0);
      const card = await svc.register('org', { name: 'a', vendorModelId: 'gone-soon', providerId: 'p1' });
      const failed = await svc.recordExternalValidation('org', 'p1', 'gone-soon', { passed: false, error: 'Model "gone-soon" is not available' });
      expect(failed?.id).toBe(card.id);
      expect(failed?.validationStatus).toBe('failed');
      expect(failed?.status).toBe('error');
      expect(failed?.lastValidationError).toContain('not available');
    });

    it('recordExternalValidation: a pass brings back a card the sync had retired', async () => {
      fetch().mockResolvedValueOnce([{ id: 'x' }]);
      await svc.syncFromProvider('org', 'p1');
      fetch().mockResolvedValueOnce([{ id: 'other' }]);
      await svc.syncFromProvider('org', 'p1');
      expect(models.rows.find((m) => m.vendorModelId === 'x')!.status).toBe('inactive');
      const back = await svc.recordExternalValidation('org', 'p1', 'x', { passed: true, latencyMs: 10 });
      expect(back?.status).toBe('active');
      expect(back?.metadata?.retiredAt).toBeUndefined();
      expect(back?.isSelectable()).toBe(true);
    });

    it('retireProviderCards keeps the cards but takes them out of routing', async () => {
      fetch().mockResolvedValueOnce([{ id: 'x' }, { id: 'y' }]);
      await svc.syncFromProvider('org', 'p1');
      await svc.recordExternalValidation('org', 'p1', 'x', { passed: true });
      expect(await svc.retireProviderCards('org', 'p1')).toBe(2);
      expect(models.rows).toHaveLength(2);
      expect(models.rows.every((m) => m.status === 'inactive' && m.metadata?.retiredReason === 'provider deleted' && !m.isSelectable())).toBe(true);
      expect(await svc.retireProviderCards('org', 'p1')).toBe(0);
    });
  });

  describe('organization scoping', () => {
    const theirProvider = Object.assign(new LlmProvider(), {
      id: 'p-theirs', organizationId: 'org2', name: 'Theirs', type: LlmProviderType.OPENAI, status: LlmProviderStatus.ACTIVE, isHealthy: true, configuration: {},
    });

    it('another organization’s card is not listed, read, changed or removed', async () => {
      const theirs = models.seed(Object.assign(new Model(), { id: 'm-theirs', organizationId: 'org2', name: 'theirs', vendorModelId: 'x', status: 'active' }));

      expect(await svc.list('org')).toEqual([]);
      await expect(svc.get('org', theirs.id)).rejects.toMatchObject({ status: 404 });
      await expect(svc.update('org', theirs.id, { status: 'inactive' })).rejects.toMatchObject({ status: 404 });
      await expect(svc.remove('org', theirs.id)).rejects.toMatchObject({ status: 404 });
      expect(models.row(theirs.id)).toMatchObject({ organizationId: 'org2', status: 'active' });
    });

    it('a card cannot be registered against another organization’s provider or version', async () => {
      providers.seed(theirProvider);
      await expect(svc.register('org', { name: 'a', vendorModelId: 'm', providerId: 'p-theirs' })).rejects.toMatchObject({ status: 404 });
      await expect(svc.register('org', { name: 'a', vendorModelId: 'm', providerId: 'p1', modelVersionId: 'v-theirs' })).rejects.toMatchObject({ status: 404 });
      expect(models.rows).toHaveLength(0);

      const card = await svc.register('org', { name: 'a', vendorModelId: 'm', providerId: 'p1', modelVersionId: 'v-mine' });
      await expect(svc.update('org', card.id, { modelVersionId: 'v-theirs' })).rejects.toMatchObject({ status: 404 });
      expect(models.row(card.id)?.modelVersionId).toBe('v-mine');
    });

    it('update writes the change to the table', async () => {
      const card = await svc.register('org', { name: 'a', vendorModelId: 'm', providerId: 'p1' });
      await svc.update('org', card.id, { name: 'renamed', region: 'eu' });
      expect(models.row(card.id)).toMatchObject({ name: 'renamed', region: 'eu' });
    });
  });
});
