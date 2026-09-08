import { Model } from '../../../entities/model.entity';
import { LlmProvider, LlmProviderStatus, LlmProviderType } from '../../../entities/llm-provider.entity';
import { AuditAction } from '../../../entities/audit-log.entity';
import { ModelCatalogService } from '../model-catalog.service';

function memRepo<T extends { id?: string }>(seed: T[] = [], make: () => T) {
  const rows = [...seed];
  const matches = (row: any, where: any) => Object.entries(where).every(([k, v]) => row[k] === v);
  return {
    rows,
    create: jest.fn((partial: any) => Object.assign(make(), partial)),
    save: jest.fn(async (row: any) => {
      if (!row.id) row.id = 'id-' + (rows.length + 1);
      const i = rows.findIndex((r) => r.id === row.id);
      if (i >= 0) rows[i] = row; else rows.push(row);
      return row;
    }),
    find: jest.fn(async ({ where }: any = {}) => rows.filter((r) => !where || matches(r, where))),
    findOne: jest.fn(async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null),
    remove: jest.fn(async (row: any) => { const i = rows.indexOf(row); if (i >= 0) rows.splice(i, 1); return row; }),
  };
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
      { findOne: jest.fn().mockResolvedValue(null) } as any,
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

  it('registers a hand-run endpoint as an encrypted custom provider plus a private card', async () => {
    const card = await svc.registerEndpoint('org', { name: 'vllm-box', url: 'https://vllm.internal/v1', apiKey: 'sk-plain', vendorModelId: 'llama-3-8b', region: 'eu-central' }, 'u');
    expect(runner.validateProviderConfiguration).toHaveBeenCalledWith(LlmProviderType.CUSTOM, expect.objectContaining({ baseUrl: 'https://vllm.internal/v1', model: 'llama-3-8b' }));
    const provider = providers.rows.find((p) => p.name === 'vllm-box')!;
    expect(provider.type).toBe(LlmProviderType.CUSTOM);
    expect(provider.configuration.apiKey).not.toBe('sk-plain');
    expect(provider.configuration.apiKey.startsWith('encrypted:')).toBe(true);
    expect(card.providerId).toBe(provider.id);
    expect(card.privacyTier).toBe('private_cloud');
    expect(card.region).toBe('eu-central');
    expect(card.validationStatus).toBe('never');
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
});
