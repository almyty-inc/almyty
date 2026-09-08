import { Model } from '../../../../entities/model.entity';
import { ModelDeployment } from '../../../../entities/model-deployment.entity';
import { LlmProvider, LlmProviderStatus, LlmProviderType } from '../../../../entities/llm-provider.entity';
import { AuditAction } from '../../../../entities/audit-log.entity';
import { ModelRouterService } from '../model-router.service';

function card(over: Partial<Model>): Model {
  return Object.assign(new Model(), {
    id: 'm-' + Math.random().toString(36).slice(2, 8),
    organizationId: 'org',
    name: 'card',
    vendorModelId: 'vendor/model',
    providerId: 'p1',
    providerType: 'custom',
    endpointRef: null,
    capabilities: {},
    pricing: { inPerMTok: 1, outPerMTok: 2, currency: 'USD' },
    pricingOverride: null,
    privacyTier: 'public',
    status: 'active',
    validationStatus: 'passed',
    modelVersionId: null,
    createdAt: new Date(),
    ...over,
  });
}

function provider(over: Partial<LlmProvider> = {}): LlmProvider {
  return Object.assign(new LlmProvider(), {
    id: 'p1', organizationId: 'org', name: 'stored', type: LlmProviderType.CUSTOM,
    status: LlmProviderStatus.ACTIVE, isHealthy: true, configuration: { baseUrl: 'https://x/v1' }, ...over,
  });
}

describe('ModelRouterService', () => {
  let cards: Model[];
  let providers: Record<string, LlmProvider>;
  let deployments: Record<string, ModelDeployment>;
  let audit: { log: jest.Mock };
  let svc: ModelRouterService;
  let modelsUpdate: jest.Mock;

  beforeEach(() => {
    cards = [];
    providers = {};
    deployments = {};
    audit = { log: jest.fn().mockResolvedValue(null) };
    modelsUpdate = jest.fn().mockResolvedValue({ affected: 1 });
    svc = new ModelRouterService(
      { find: jest.fn(async () => cards), update: modelsUpdate } as any,
      { findOne: jest.fn(async ({ where }: any) => providers[where.id] ?? null) } as any,
      { findOne: jest.fn(async ({ where }: any) => deployments[where.id] ?? null) } as any,
      audit as any,
    );
  });

  it('resolves stored providers and drops cards whose provider is unhealthy', async () => {
    providers.p1 = provider();
    providers.p2 = provider({ id: 'p2', isHealthy: false, name: 'sick' });
    cards = [card({ id: 'a', providerId: 'p1' }), card({ id: 'b', providerId: 'p2' })];
    const plan = await svc.plan('org', {});
    expect(plan.candidates.map((c) => c.modelId)).toEqual(['a']);
    expect(plan.rejected).toEqual([{ modelId: 'b', reason: 'provider sick is unhealthy' }]);
    expect(plan.candidates[0].provider).toBe(providers.p1);
  });

  it('builds a transient custom provider for endpoint-only cards, using the deployment secret as key', async () => {
    const dep = Object.assign(new ModelDeployment(), { id: 'd1', organizationId: 'org', providerConfig: { token: 'hf_secret', region: 'eu' } });
    deployments.d1 = dep;
    cards = [card({ id: 'e', providerId: null, endpointRef: { url: 'https://ep.example/v1', deploymentId: 'd1' }, vendorModelId: 'my-llama' })];
    const plan = await svc.plan('org', {});
    expect(plan.candidates).toHaveLength(1);
    const p = plan.candidates[0].provider;
    expect(p.type).toBe(LlmProviderType.CUSTOM);
    expect(p.id).toBe('endpoint:e');
    expect(p.configuration).toEqual({ baseUrl: 'https://ep.example/v1', model: 'my-llama', apiKey: 'hf_secret' });
  });

  it('rejects cards whose endpoint has no url', async () => {
    cards = [card({ id: 'x', providerId: null, endpointRef: { deploymentId: 'pending' } })];

    const plan = await svc.plan('org', {});
    expect(plan.candidates).toEqual([]);
    expect(plan.rejected[0].reason).toBe('no callable provider');
  });

  it('applies the policy before resolving providers', async () => {
    providers.p1 = provider();
    cards = [card({ id: 'pub', privacyTier: 'public' }), card({ id: 'loc', privacyTier: 'local' })];
    const plan = await svc.plan('org', { privacyTier: 'local' });
    expect(plan.candidates.map((c) => c.modelId)).toEqual(['loc']);
    expect(plan.rejected[0]).toMatchObject({ modelId: 'pub' });
  });

  it('writes a MODEL_ROUTED audit row with rationale and attempt', async () => {
    svc.recordRoute('org', {
      modelId: 'a', modelVersionId: 'v1', vendorModelId: 'x', providerId: 'p1', rationale: 'cheapest', attempt: 2,
      tried: [{ modelId: 'z', reason: 'MODEL_NOT_FOUND' }], rejected: [],
    }, { userId: 'u', conversationId: 'c' });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: AuditAction.MODEL_ROUTED, resourceId: 'a', userId: 'u',
      details: expect.objectContaining({ modelVersionId: 'v1', rationale: 'cheapest', attempt: 2, tried: [{ modelId: 'z', reason: 'MODEL_NOT_FOUND' }], conversationId: 'c' }),
    }));
  });

  describe('recordLatency', () => {
    const T0 = 1_700_000_000_000;

    it('writes the first sample straight to the card', async () => {
      const c = card({ id: 'a', measuredLatencyMs: null });
      await svc.recordLatency(c, 250, T0);
      expect(modelsUpdate).toHaveBeenCalledWith({ id: 'a' }, { measuredLatencyMs: { p50: 250, p95: 250, updatedAt: new Date(T0).toISOString() } });
      expect(c.measuredLatencyMs).toMatchObject({ p50: 250, p95: 250 });
    });

    it('averages in memory and writes at most once a minute per card', async () => {
      const c = card({ id: 'a', measuredLatencyMs: null });
      await svc.recordLatency(c, 100, T0);
      await svc.recordLatency(c, 200, T0 + 1_000);
      await svc.recordLatency(c, 300, T0 + 30_000);
      expect(modelsUpdate).toHaveBeenCalledTimes(1);
      await svc.recordLatency(c, 300, T0 + 61_000);
      expect(modelsUpdate).toHaveBeenCalledTimes(2);
      // p50: 100 -> 120 -> 156 -> 184.8; p95 follows the slowest sample at once.
      expect(modelsUpdate.mock.calls[1][1].measuredLatencyMs).toMatchObject({ p50: 185, p95: 300 });
      const other = card({ id: 'b', measuredLatencyMs: null });
      await svc.recordLatency(other, 50, T0 + 61_000);
      expect(modelsUpdate).toHaveBeenCalledTimes(3);
    });

    it('seeds from the stored value and lets p95 decay slowly toward faster samples', async () => {
      const c = card({ id: 'a', measuredLatencyMs: { p50: 500, p95: 1000, updatedAt: 'earlier' } });
      await svc.recordLatency(c, 100, T0);
      expect(modelsUpdate).toHaveBeenCalledWith({ id: 'a' }, { measuredLatencyMs: expect.objectContaining({ p50: 420, p95: 910 }) });
    });

    it('ignores unusable samples and survives a failed write', async () => {
      const c = card({ id: 'a', measuredLatencyMs: null });
      await svc.recordLatency(c, 0, T0);
      await svc.recordLatency(c, Number.NaN, T0);
      expect(modelsUpdate).not.toHaveBeenCalled();
      modelsUpdate.mockRejectedValueOnce(new Error('db away'));
      await expect(svc.recordLatency(c, 80, T0)).resolves.toBeUndefined();
    });
  });
});
