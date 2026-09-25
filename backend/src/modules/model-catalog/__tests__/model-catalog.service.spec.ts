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

  it('syncFromProvider imports listed models once; from a provider not yet checked they wait for the check', async () => {
    (svc as any).modelsHelper.fetchModelsFromProvider.mockResolvedValue([{ id: 'gpt-x', name: 'GPT X' }, { id: 'gpt-y', name: 'GPT Y' }]);
    const first = await svc.syncFromProvider('org', 'p1');
    expect(first.created.map((c) => c.vendorModelId)).toEqual(['gpt-x', 'gpt-y']);
    expect(first.created.every((c) => c.validationStatus === 'never' && c.privacyTier === 'public')).toBe(true);
    const second = await svc.syncFromProvider('org', 'p1');
    expect(second.created).toEqual([]);
    expect(second.skipped).toBe(2);
  });

  describe('readiness: the provider key check makes its models usable', () => {
    const fetch = () => (svc as any).modelsHelper.fetchModelsFromProvider as jest.Mock;
    const checkedAt = new Date('2026-09-20T10:00:00Z');
    const markChecked = async (healthy = true) => {
      await providers.update({ id: 'p1' }, { isHealthy: healthy, lastHealthCheckAt: checkedAt });
    };
    const selectableIds = async () => (await svc.list('org', { selectable: true })).map((c) => c.vendorModelId).sort();

    it('a passing check makes every waiting model usable at once, and nothing else', async () => {
      fetch().mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
      await svc.syncFromProvider('org', 'p1');
      // The vendor said `c` is gone on a real call, and `b` was retired.
      await models.update({ vendorModelId: 'c' }, { validationStatus: 'failed', status: 'error' });
      await models.update({ vendorModelId: 'b' }, { status: 'inactive', metadata: { retiredAt: 'x', retiredReason: 'not listed by provider' } });
      expect(await selectableIds()).toEqual([]);

      await markChecked();
      const changed = await svc.applyProviderCheck('org', 'p1', { passed: true });

      expect(await selectableIds()).toEqual(['a']);
      expect(changed).toBe(2);
      expect(models.rows.find((m) => m.vendorModelId === 'a')!.metadata?.checkedBy).toBe('provider_check');
      expect(models.rows.find((m) => m.vendorModelId === 'c')!.validationStatus).toBe('failed');
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.MODEL_VALIDATED, details: expect.objectContaining({ source: 'provider_check', passed: true, count: 2 }) }));
    });

    it('models listed by a provider whose key already checked out are usable as they arrive', async () => {
      await markChecked();
      fetch().mockResolvedValue([{ id: 'new-1' }, { id: 'new-2' }]);
      await svc.syncFromProvider('org', 'p1');
      expect(await selectableIds()).toEqual(['new-1', 'new-2']);
      // ...and so is one registered by hand against it.
      const byHand = await svc.register('org', { name: 'x', vendorModelId: 'by-hand', providerId: 'p1' });
      expect(byHand.isSelectable()).toBe(true);
    });

    it('a provider whose last check failed, or that is switched off, lends its models nothing', async () => {
      await markChecked(false);
      fetch().mockResolvedValue([{ id: 'a' }]);
      await svc.syncFromProvider('org', 'p1');
      expect(await selectableIds()).toEqual([]);
      await providers.update({ id: 'p1' }, { isHealthy: true, status: LlmProviderStatus.INACTIVE });
      await svc.syncFromProvider('org', 'p1');
      fetch().mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
      await svc.syncFromProvider('org', 'p1');
      expect(await selectableIds()).toEqual([]);
    });

    it('a rejected key takes the models back out; an outage does not; the next pass restores them', async () => {
      await markChecked();
      fetch().mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
      await svc.syncFromProvider('org', 'p1');
      expect(await selectableIds()).toEqual(['a', 'b']);

      expect(await svc.applyProviderCheck('org', 'p1', { passed: false, keyRejected: false, error: 'timeout' })).toBe(0);
      expect(await selectableIds()).toEqual(['a', 'b']);

      await svc.applyProviderCheck('org', 'p1', { passed: false, keyRejected: true, error: 'Incorrect API key provided' });
      expect(await selectableIds()).toEqual([]);
      expect(models.rows.find((m) => m.vendorModelId === 'a')!.lastValidationError).toBe('Incorrect API key provided');

      await svc.applyProviderCheck('org', 'p1', { passed: true });
      expect(await selectableIds()).toEqual(['a', 'b']);
    });

    it('a key check touches only its own provider in its own organization', async () => {
      providers.seed(Object.assign(new LlmProvider(), { id: 'p2', organizationId: 'org', name: 'Other', type: LlmProviderType.OPENAI, status: LlmProviderStatus.ACTIVE, isHealthy: true, configuration: {} }));
      models.seed(Object.assign(new Model(), { id: 'other-org', organizationId: 'org2', providerId: 'p1', vendorModelId: 'z', name: 'z', status: 'active', validationStatus: 'never' }));
      models.seed(Object.assign(new Model(), { id: 'other-provider', organizationId: 'org', providerId: 'p2', vendorModelId: 'y', name: 'y', status: 'active', validationStatus: 'never' }));
      await svc.applyProviderCheck('org', 'p1', { passed: true });
      expect(models.rows.find((m) => m.id === 'other-org')!.validationStatus).toBe('never');
      expect(models.rows.find((m) => m.id === 'other-provider')!.validationStatus).toBe('never');
    });
  });

  describe('the periodic sweep', () => {
    const fetch = () => (svc as any).modelsHelper.fetchModelsFromProvider as jest.Mock;
    const selectableIds = async () => (await svc.list('org', { selectable: true })).map((c) => c.vendorModelId).sort();

    beforeEach(async () => {
      await providers.update({ id: 'p1' }, { isHealthy: true, lastHealthCheckAt: new Date() });
      fetch().mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
      await svc.syncFromProvider('org', 'p1');
    });

    it('picks up new models and marks retired ones unavailable, across organizations', async () => {
      providers.seed(Object.assign(new LlmProvider(), { id: 'q1', organizationId: 'org2', name: 'Groq', type: LlmProviderType.GROQ, status: LlmProviderStatus.ACTIVE, isHealthy: true, lastHealthCheckAt: new Date(), configuration: {} }));
      providers.seed(Object.assign(new LlmProvider(), { id: 'off', organizationId: 'org', name: 'Off', type: LlmProviderType.GROQ, status: LlmProviderStatus.INACTIVE, isHealthy: true, configuration: {} }));
      fetch().mockImplementation(async (p: LlmProvider) => (p.id === 'p1' ? [{ id: 'a' }, { id: 'c' }] : [{ id: 'llama' }]));

      const result = await svc.syncEveryProvider();

      expect(result).toEqual({ providers: 2, synced: 2, failed: 0, keyRejected: 0 });
      expect(await selectableIds()).toEqual(['a', 'c']);
      expect(models.rows.find((m) => m.vendorModelId === 'b')!.metadata?.retiredReason).toBe('not listed by provider');
      expect((await svc.list('org2', { selectable: true })).map((m) => m.vendorModelId)).toEqual(['llama']);
      expect(fetch().mock.calls.map(([p]) => p.id)).not.toContain('off');
    });

    it('a listing refused for the key takes the models out; one that merely failed does not', async () => {
      fetch().mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 503'), { response: { status: 503 } }));
      expect(await svc.syncEveryProvider()).toEqual({ providers: 1, synced: 0, failed: 1, keyRejected: 0 });
      expect(await selectableIds()).toEqual(['a', 'b']);

      fetch().mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 401'), { response: { status: 401 } }));
      expect(await svc.syncEveryProvider()).toEqual({ providers: 1, synced: 0, failed: 1, keyRejected: 1 });
      expect(await selectableIds()).toEqual([]);
    });
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

  /**
   * Every test above runs against one organization with one provider, so
   * the organization and provider halves of the predicates below could be
   * dropped with the suite green. These put a neighbour next to each row.
   */
  describe('provider and organization scoping of sync, retire and private providers', () => {
    const fetch = () => (svc as any).modelsHelper.fetchModelsFromProvider as jest.Mock;
    const provider = (over: Partial<LlmProvider>) =>
      Object.assign(new LlmProvider(), { type: LlmProviderType.OPENAI, status: LlmProviderStatus.ACTIVE, isHealthy: true, configuration: {}, ...over });
    const card = (over: Partial<Model>) =>
      models.seed(Object.assign(new Model(), { status: 'active', validationStatus: 'passed', capabilities: {}, ...over }));

    it('retireProviderCards retires only the cards of that provider in that organization', async () => {
      providers.seed(provider({ id: 'p2', organizationId: 'org', name: 'Second' }));
      providers.seed(provider({ id: 'p-theirs', organizationId: 'org2', name: 'Theirs' }));
      const mine = card({ id: 'c-mine', organizationId: 'org', providerId: 'p1', vendorModelId: 'x', name: 'x' });
      const sibling = card({ id: 'c-sibling', organizationId: 'org', providerId: 'p2', vendorModelId: 'x', name: 'x2' });
      const theirs = card({ id: 'c-theirs', organizationId: 'org2', providerId: 'p-theirs', vendorModelId: 'x', name: 'x3' });

      // Another organization's provider id, asked for from this one: nothing.
      expect(await svc.retireProviderCards('org', 'p-theirs')).toBe(0);
      expect(models.row(theirs.id)).toMatchObject({ status: 'active' });
      expect(models.row(theirs.id)?.metadata?.retiredAt).toBeUndefined();

      expect(await svc.retireProviderCards('org', 'p1')).toBe(1);
      expect(models.row(mine.id)).toMatchObject({ status: 'inactive', metadata: { retiredReason: 'provider deleted' } });
      expect(models.row(sibling.id)).toMatchObject({ status: 'active' });
      expect(models.row(theirs.id)).toMatchObject({ status: 'active' });
    });

    it("syncFromProvider refuses another organization's provider and writes nothing", async () => {
      providers.seed(provider({ id: 'p-theirs', organizationId: 'org2', name: 'Theirs' }));
      fetch().mockResolvedValue([{ id: 'gpt-x' }]);

      await expect(svc.syncFromProvider('org', 'p-theirs')).rejects.toMatchObject({ status: 404 });
      expect(fetch()).not.toHaveBeenCalled();
      expect(models.rows).toHaveLength(0);
    });

    it("syncFromProvider reconciles against its own provider's cards only", async () => {
      providers.seed(provider({ id: 'p2', organizationId: 'org', name: 'Second' }));
      const sibling = card({ id: 'c-sibling', organizationId: 'org', providerId: 'p2', vendorModelId: 'shared-id', name: 'on p2' });
      const unlisted = card({ id: 'c-sibling-2', organizationId: 'org', providerId: 'p2', vendorModelId: 'only-on-p2', name: 'only p2' });
      // A row whose organization disagrees with the provider's is not this sync's either.
      const stray = card({ id: 'c-stray', organizationId: 'org2', providerId: 'p1', vendorModelId: 'stray', name: 'stray' });
      fetch().mockResolvedValue([{ id: 'shared-id' }]);

      const result = await svc.syncFromProvider('org', 'p1');

      // p2 listing the same vendor id does not make p1's card exist already...
      expect(result.created.map((c) => c.vendorModelId)).toEqual(['shared-id']);
      expect(models.rows.filter((m) => m.providerId === 'p1' && m.organizationId === 'org').map((m) => m.vendorModelId)).toEqual(['shared-id']);
      // ...and p2's cards, absent from p1's list, are not retired by it.
      expect(result.retired).toEqual([]);
      expect(models.row(sibling.id)).toMatchObject({ status: 'active' });
      expect(models.row(unlisted.id)).toMatchObject({ status: 'active' });
      expect(models.row(stray.id)).toMatchObject({ status: 'active' });
    });

    it("syncFromProvider treats another member's private provider as missing, but not its owner's or a lifecycle sync", async () => {
      providers.seed(provider({ id: 'p-private', organizationId: 'org', name: 'Mine', visibility: 'private', ownerUserId: 'owner' }));
      fetch().mockResolvedValue([{ id: 'gpt-x' }]);

      await expect(svc.syncFromProvider('org', 'p-private', 'someone-else')).rejects.toMatchObject({ status: 404 });
      expect(fetch()).not.toHaveBeenCalled();
      expect(models.rows).toHaveLength(0);

      expect((await svc.syncFromProvider('org', 'p-private', 'owner')).created).toHaveLength(1);
      expect((await svc.syncFromProvider('org', 'p-private')).skipped).toBe(1);
    });

    it("list and get hide cards served by another member's private provider", async () => {
      providers.seed(provider({ id: 'p-private', organizationId: 'org', name: 'Mine', visibility: 'private', ownerUserId: 'owner' }));
      const shared = card({ id: 'c-shared', organizationId: 'org', providerId: 'p1', vendorModelId: 'a', name: 'a' });
      const privateCard = card({ id: 'c-private', organizationId: 'org', providerId: 'p-private', vendorModelId: 'b', name: 'b' });
      const ids = async (viewer?: string | null) => (await svc.list('org', {}, viewer)).map((m) => m.id).sort();

      expect(await ids('owner')).toEqual([shared.id, privateCard.id].sort());
      expect(await ids('someone-else')).toEqual([shared.id]);
      // No known person: fail closed.
      expect(await ids(null)).toEqual([shared.id]);
      // No viewer argument at all is an internal caller, which sees the org's cards.
      expect(await ids(undefined)).toEqual([shared.id, privateCard.id].sort());

      expect((await svc.get('org', privateCard.id, 'owner')).id).toBe(privateCard.id);
      await expect(svc.get('org', privateCard.id, 'someone-else')).rejects.toMatchObject({ status: 404 });
      await expect(svc.get('org', privateCard.id, null)).rejects.toMatchObject({ status: 404 });
      expect((await svc.get('org', shared.id, 'someone-else')).id).toBe(shared.id);
    });
  });
});
