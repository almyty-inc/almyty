import { Model } from '../../../../entities/model.entity';
import { ModelDeployment } from '../../../../entities/model-deployment.entity';
import { LlmProvider, LlmProviderStatus, LlmProviderType } from '../../../../entities/llm-provider.entity';
import { AuditAction } from '../../../../entities/audit-log.entity';
import { ModelRouterService } from '../model-router.service';
import { fakeRepository } from '../../../../test/fake-repository';

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
    status: LlmProviderStatus.ACTIVE, isHealthy: true, configuration: { apiUrl: 'https://x/v1' }, ...over,
  });
}

describe('ModelRouterService', () => {
  let cards: Model[];
  let providers: Record<string, LlmProvider>;
  let deployments: Record<string, ModelDeployment>;
  let audit: { log: jest.Mock };
  let svc: ModelRouterService;
  let modelsUpdate: jest.Mock;

  /**
   * Reads go through the shared truthful table over whatever `cards` and
   * `providers` hold at call time, so every `where` is evaluated. The
   * doubles these replace answered every card for any organization and
   * looked providers up by id alone, so the org predicate in `plan()`,
   * `providerFor()` and `providerForModelId()` could each be deleted with
   * the module's suites green.
   */
  const cardTable = () => fakeRepository<Model>({ seed: cards, make: () => new Model() });
  const modelsRepo = (update?: jest.Mock) => ({
    find: jest.fn(async (o: any) => cardTable().find(o)),
    findOne: jest.fn(async (o: any) => cardTable().findOne(o)),
    update,
  });
  const providersRepo = () => ({
    findOne: jest.fn(async (o: any) =>
      fakeRepository<LlmProvider>({ seed: Object.values(providers), make: () => new LlmProvider() }).findOne(o),
    ),
  });

  beforeEach(() => {
    cards = [];
    providers = {};
    deployments = {};
    audit = { log: jest.fn().mockResolvedValue(null) };
    modelsUpdate = jest.fn().mockResolvedValue({ affected: 1 });
    svc = new ModelRouterService(
      modelsRepo(modelsUpdate) as any,
      providersRepo() as any,
      { findOne: jest.fn(async ({ where }: any) => deployments[where.id] ?? null) } as any,
      audit as any,
    );
  });

  it('plans only this organization’s catalog, through this organization’s providers', async () => {
    providers.p1 = provider();
    providers.p2 = provider({ id: 'p2', organizationId: 'other', name: 'theirs' });
    cards = [
      card({ id: 'mine', providerId: 'p1' }),
      card({ id: 'theirs', organizationId: 'other', providerId: 'p2' }),
      // Our card pointing at another tenant's provider row: not callable.
      card({ id: 'borrowed', providerId: 'p2' }),
    ];

    const plan = await svc.plan('org', {});
    expect(plan.candidates.map((c) => c.modelId)).toEqual(['mine']);
    expect(plan.rejected).toEqual([{ modelId: 'borrowed', reason: 'no callable provider' }]);
  });

  it('resolves a named model only from this organization’s catalog', async () => {
    providers.p2 = provider({ id: 'p2', organizationId: 'other' });
    cards = [card({ id: 'theirs', organizationId: 'other', providerId: 'p2' })];

    await expect(svc.providerForModelId('org', 'theirs')).rejects.toThrow(/not in this organization/);
    await expect(svc.providerForModelId('other', 'theirs')).resolves.toMatchObject({ provider: { id: 'p2' } });
  });

  it('resolves stored providers and drops cards whose provider is unhealthy', async () => {
    providers.p1 = provider();
    providers.p2 = provider({ id: 'p2', isHealthy: false, name: 'sick' });
    cards = [card({ id: 'a', providerId: 'p1' }), card({ id: 'b', providerId: 'p2' })];
    const plan = await svc.plan('org', {});
    expect(plan.candidates.map((c) => c.modelId)).toEqual(['a']);
    expect(plan.rejected).toEqual([{ modelId: 'b', reason: 'provider sick is unhealthy' }]);
    expect(plan.candidates[0].provider).toMatchObject({ id: 'p1', name: 'stored' });
  });

  it('an endpoint card is called through its stored provider row, never a transient one', async () => {
    providers.p9 = provider({ id: 'p9', name: 'deployed llama', type: LlmProviderType.OPENAI, configuration: { apiUrl: 'https://ep.example/v1', model: 'my-llama' } });
    cards = [card({ id: 'e', providerId: 'p9', endpointRef: { url: 'https://ep.example/v1', deploymentId: 'd1' }, vendorModelId: 'my-llama' })];
    const plan = await svc.plan('org', {});
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0].provider).toMatchObject({ id: 'p9', name: 'deployed llama' });
    expect(plan.candidates[0].provider.id).not.toMatch(/^endpoint:/);
  });

  it('a card whose endpoint has no provider row yet is not a candidate', async () => {
    cards = [card({ id: 'e', providerId: null, endpointRef: { url: 'https://ep.example/v1', deploymentId: 'd1' } })];
    const plan = await svc.plan('org', {});
    expect(plan.candidates).toEqual([]);
    expect(plan.rejected[0]).toMatchObject({ modelId: 'e', reason: 'no callable provider' });
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


  /** Last audit.log() payload. Array.prototype.at is past this tsconfig's lib. */
  const lastAuditCall = () => {
    const calls = (audit.log as jest.Mock).mock.calls;
    return calls[calls.length - 1];
  };
  it('records what the routed call cost, and which run and node made it', async () => {
    // The row carried a model and a rationale but no cost, no tokens, no
    // run and no node — while audit_logs has had a `cost` column all
    // along that this writer left null. So the one table recording a
    // per-call model decision could not answer "spend by model last
    // week", and a routed call could not be tied back to its run.
    const { runWithRequestContext } = require('../../../../common/request-context');

    runWithRequestContext({ requestId: 'req-1', runId: 'run-42', nodeId: 'llm_1' }, () => {
      svc.recordRoute(
        'org',
        {
          modelId: 'a', modelVersionId: 'v1', vendorModelId: 'x', providerId: 'p1',
          rationale: 'cheapest', attempt: 1, tried: [], rejected: [],
        },
        { userId: 'u', conversationId: 'c', cost: 0.0123, tokens: 850 },
      );
    });

    const call = lastAuditCall()[0];
    // The dedicated column, so spend-by-model is a SUM not a json dig.
    expect(call.cost).toBeCloseTo(0.0123);
    expect(call.details).toMatchObject({
      cost: 0.0123,
      tokens: 850,
      runId: 'run-42',
      nodeId: 'llm_1',
      requestId: 'req-1',
    });
  });

  it('takes the run and node from the correlation scope, not a parameter', async () => {
    const { runWithRequestContext } = require('../../../../common/request-context');

    runWithRequestContext({ requestId: 'req-2', runId: 'run-7' }, () => {
      svc.recordRoute('org', {
        modelId: 'a', modelVersionId: null, vendorModelId: 'x', providerId: 'p1',
        rationale: 'fastest', attempt: 1, tried: [], rejected: [],
      });
    });

    expect(lastAuditCall()[0].details).toMatchObject({
      runId: 'run-7',
    });
  });

  it('omits cost entirely when the caller has none, rather than writing 0', async () => {
    svc.recordRoute('org', {
      modelId: 'a', modelVersionId: null, vendorModelId: 'x', providerId: 'p1',
      rationale: 'only candidate', attempt: 1, tried: [], rejected: [],
    });

    const call = lastAuditCall()[0];
    expect('cost' in call).toBe(false);
    expect('cost' in call.details).toBe(false);
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

  it('a provider that references a connection is only a candidate while that connection resolves', async () => {
    providers.p9 = provider({ id: 'p9', name: 'deployed llama', type: LlmProviderType.OPENAI, credentialId: 'cred-1', configuration: { apiUrl: 'https://ep.example/v1' } });
    cards = [card({ id: 'e', providerId: 'p9', endpointRef: { url: 'https://ep.example/v1', deploymentId: 'd1' } })];
    const credentialRefs = { tryResolve: jest.fn().mockResolvedValue({ credential: { id: 'cred-1' }, config: { apiKey: 'vault-fresh' } }) };
    const withRefs = new ModelRouterService(
      modelsRepo() as any,
      providersRepo() as any,
      { findOne: jest.fn(async ({ where }: any) => deployments[where.id] ?? null) } as any,
      audit as any,
      credentialRefs as any,
    );

    const plan = await withRefs.plan('org', {}, { id: 'u-1' });
    expect(plan.candidates).toHaveLength(1);
    expect(credentialRefs.tryResolve).toHaveBeenCalledWith('org', 'cred-1', { principal: { id: 'u-1' }, context: { purpose: 'llm_call', resourceType: 'model', resourceId: 'e' } });

    // Revoked, expired, or not granted to this caller: the card drops out
    // rather than being called without the key.
    credentialRefs.tryResolve.mockResolvedValue(null);
    const closed = await withRefs.plan('org', {}, { id: 'u-1' });
    expect(closed.candidates).toEqual([]);
    expect(closed.rejected[0]).toMatchObject({ modelId: 'e', reason: 'no callable provider' });
  });
});
