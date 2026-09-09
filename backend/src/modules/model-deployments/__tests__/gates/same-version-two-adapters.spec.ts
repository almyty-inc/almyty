import { Model } from '../../../../entities/model.entity';
import { ModelDeployment } from '../../../../entities/model-deployment.entity';
import { AuditAction } from '../../../../entities/audit-log.entity';
import { LlmProvider, LlmProviderType } from '../../../../entities/llm-provider.entity';
import { ModelRouterService } from '../../../model-catalog/routing/model-router.service';
import { EndpointProviderHelper } from '../../../llm-providers/endpoint-provider.helper';
import { AdapterRegistry } from '../../adapters/adapter.registry';
import { HuggingFaceEndpointsAdapter } from '../../adapters/huggingface-endpoints.adapter';
import { StubAdapter } from '../../adapters/stub.adapter';
import { ModelDeploymentsProcessor } from '../../model-deployments.processor';
import { ModelDeploymentsService } from '../../model-deployments.service';
import { hfFixtureHttp } from '../conformance/huggingface-endpoints.fixture';
import { REGISTRY_KEYS, ensureTestKey, fakeAudit, fakeEnvelope, fakeQueue, fakeRegistry, fakeRepo, newDeployment } from './fakes';

/**
 * Gate (2): the same ModelVersion deployed to two providers by changing
 * only providerType + providerConfig. The service validates and stores
 * desired state, the processor drives each adapter to ready, each
 * deployment fills its own catalog card, the audit trail names the
 * adapter on every transition, and nothing from one adapter shows up in
 * the other's config, handle or observed state. The router then plans
 * over both cards without ever seeing a provider-specific field.
 *
 * Adapters: the in-memory stub and the Hugging Face Endpoints adapter
 * over its API fixture (the same fixture the conformance suite uses).
 */
const ORG = 'org-gate2';
const VERSION = { id: 'v-shared', organizationId: ORG, name: 'qwen3-0.6b', base: 'qwen3-0.6b', registryUri: 'hf://Qwen/Qwen3-0.6B@main', quantizations: [], manifestSha: 'sha-1' };

const card = (id: string, name: string): Model =>
  Object.assign(new Model(), {
    id, organizationId: ORG, name, providerId: null, providerType: null, vendorModelId: 'qwen3-0.6b', endpointRef: null, base: 'qwen3-0.6b',
    modelVersionId: VERSION.id, capabilities: {}, contextLength: null, pricing: { inPerMTok: 0.1, outPerMTok: 0.1, currency: 'USD' }, pricingSource: 'manual',
    pricingFetchedAt: null, pricingOverride: null, measuredLatencyMs: null, privacyTier: 'private_cloud', region: null, status: 'draft', validationStatus: 'passed',
    lastValidatedAt: null, metadata: {}, createdAt: new Date(), updatedAt: new Date(),
  });

describe('gate 2: one ModelVersion, two adapters, provider specifics never cross', () => {
  let stub: StubAdapter;
  let hf: HuggingFaceEndpointsAdapter;
  let fixture: ReturnType<typeof hfFixtureHttp>;
  let registry: AdapterRegistry;
  let deployments: ReturnType<typeof fakeRepo<ModelDeployment>>;
  let models: ReturnType<typeof fakeRepo<Model>>;
  let audit: ReturnType<typeof fakeAudit>;
  let service: ModelDeploymentsService;
  let processor: ModelDeploymentsProcessor;
  let providerRows: ReturnType<typeof fakeRepo<any>>;
  let stubDeploy: jest.SpyInstance;
  let hfDeploy: jest.SpyInstance;
  let modelRegistry: ReturnType<typeof fakeRegistry>;
  let stubId: string;
  let hfId: string;

  const stubConfig = { token: 'valid' };
  const hfConfig = { token: 'hf_valid', namespace: 'almyty-test', instanceType: 'nvidia-t4', hourlyRateCents: 60 };

  beforeEach(async () => {
    ensureTestKey();
    stub = new StubAdapter({ architectures: 'any', centsPerHour: 100 });
    fixture = hfFixtureHttp();
    hf = new HuggingFaceEndpointsAdapter(fixture.http);
    stubDeploy = jest.spyOn(stub, 'deploy');
    hfDeploy = jest.spyOn(hf, 'deploy');
    registry = new AdapterRegistry();
    registry.register(stub);
    registry.register(hf);

    deployments = fakeRepo<ModelDeployment>(newDeployment);
    models = fakeRepo<Model>(() => new Model(), [card('m-stub', 'qwen on stub'), card('m-hf', 'qwen on hf')]);
    const versions = fakeRepo<any>(() => ({}), [VERSION]);
    const credentials = fakeRepo<any>(() => ({}));
    const budgets = fakeRepo<any>(() => ({}));
    audit = fakeAudit();
    const queue = fakeQueue();

    modelRegistry = fakeRegistry();
    service = new ModelDeploymentsService(deployments as any, versions as any, credentials as any, queue as any, registry, fakeEnvelope as any, audit as any, modelRegistry as any);
    providerRows = fakeRepo<any>(() => new LlmProvider());
    const endpointProviders = new EndpointProviderHelper(providerRows as any, { applyKey: jest.fn(async () => undefined) } as any);
    processor = new ModelDeploymentsProcessor(queue as any, deployments as any, versions as any, models as any, budgets as any, registry, service, { emit: jest.fn(async () => undefined) } as any, endpointProviders);

    // Only providerType and providerConfig differ between the two requests.
    const common = { modelVersionId: VERSION.id, desired: { replicas: 1, region: undefined } };
    stubId = (await service.create(ORG, 'u-1', { ...common, providerType: 'stub', providerConfig: stubConfig, modelId: 'm-stub' })).id;
    hfId = (await service.create(ORG, 'u-1', { ...common, providerType: 'huggingface-endpoints', providerConfig: hfConfig, modelId: 'm-hf' })).id;
    expect(queue.add).toHaveBeenCalledTimes(2);

    await processor.reconcile(stubId);
    await processor.reconcile(hfId);
  });

  it('brings both deployments to ready from the same version', () => {
    const s = deployments.get(stubId);
    const h = deployments.get(hfId);
    expect(s.state).toBe('ready');
    expect(h.state).toBe('ready');
    expect(s.modelVersionId).toBe(VERSION.id);
    expect(h.modelVersionId).toBe(VERSION.id);
    expect(s.lastError).toBeNull();
    expect(h.lastError).toBeNull();

    // Both adapters were handed the identical version record.
    expect(stubDeploy).toHaveBeenCalledTimes(1);
    expect(hfDeploy).toHaveBeenCalledTimes(1);
    const versionSeenByStub = stubDeploy.mock.calls[0][0].version;
    const versionSeenByHf = hfDeploy.mock.calls[0][0].version;
    expect(versionSeenByStub).toEqual(versionSeenByHf);
    expect(versionSeenByHf).toMatchObject({ id: VERSION.id, registryUri: VERSION.registryUri, manifestSha: VERSION.manifestSha });
  });

  it('fills one card per deployment with that deployment\'s endpoint', () => {
    const s = models.get('m-stub');
    const h = models.get('m-hf');
    expect(s.status).toBe('active');
    expect(h.status).toBe('active');
    expect(s.endpointRef).toEqual({ url: expect.stringMatching(/^https:\/\/stub\.invalid\/stub-ep-\d+\/v1$/), deploymentId: stubId, providerType: 'stub' });
    expect(h.endpointRef).toEqual({ url: expect.stringMatching(/^https:\/\/almyty-[a-z0-9]+\.endpoints\.huggingface\.cloud$/), deploymentId: hfId, providerType: 'huggingface-endpoints' });
    expect(s.endpointRef!.url).not.toBe(h.endpointRef!.url);
  });

  it('audits every transition with the adapter key on the row', () => {
    const transitions = audit.rows.filter((r) => r.action === AuditAction.MODEL_DEPLOYMENT_TRANSITION);
    const byDeployment = (id: string) => transitions.filter((r) => r.resourceId === id);
    for (const [id, key] of [[stubId, 'stub'], [hfId, 'huggingface-endpoints']] as const) {
      const rows = byDeployment(id);
      expect(rows.map((r) => r.details.to)).toEqual(['pending', 'deploying', 'ready']);
      for (const row of rows) {
        expect(row.details.providerType).toBe(key);
        expect(row.resourceName).toBe(`${key}:${VERSION.id}`);
        expect(row.organizationId).toBe(ORG);
      }
    }
    // No audit row ever carries a token.
    expect(JSON.stringify(audit.rows)).not.toMatch(/hf_valid|"valid"/);
  });

  it('keeps providerConfig, externalRef and actual private to each adapter', () => {
    const s = deployments.get(stubId);
    const h = deployments.get(hfId);
    const stubKeys = Object.keys(stub.configSchema().properties);
    const hfKeys = Object.keys(hf.configSchema().properties);
    const onlyHf = hfKeys.filter((k) => !stubKeys.includes(k));
    const onlyStub = stubKeys.filter((k) => !hfKeys.includes(k));

    // Config: each row holds only what its own adapter's schema names.
    for (const k of Object.keys(s.providerConfig)) expect(stubKeys).toContain(k);
    for (const k of Object.keys(h.providerConfig)) expect(hfKeys).toContain(k);
    for (const k of onlyHf) expect(s.providerConfig).not.toHaveProperty(k);
    for (const k of onlyStub) expect(h.providerConfig).not.toHaveProperty(k);
    expect(s.getDecryptedProviderConfig()).toEqual(stubConfig);
    expect(h.getDecryptedProviderConfig()).toEqual(hfConfig);
    // Secrets are encrypted at rest on both rows.
    expect(s.providerConfig.token).toMatch(/^encrypted:/);
    expect(h.providerConfig.token).toMatch(/^encrypted:/);

    // Handle: adapter-owned, no cross-talk.
    expect(s.externalRef).toEqual({ id: expect.stringMatching(/^stub-ep-/), url: expect.stringContaining('stub.invalid') });
    expect(h.externalRef).toMatchObject({ namespace: 'almyty-test', name: expect.stringMatching(/^almyty-/), hourlyRateCents: 60 });
    expect(JSON.stringify(s.externalRef)).not.toMatch(/huggingface|almyty-test|namespace/);
    expect(JSON.stringify(h.externalRef)).not.toMatch(/stub/);

    // Observed state: what each provider reported, nothing secret, nothing foreign.
    expect(s.actual).toMatchObject({ state: 'ready', replicas: 1, ratePerHourCents: 100 });
    expect(h.actual).toMatchObject({ state: 'ready', replicas: 1, hardware: 'nvidia-t4', region: 'us-east-1', details: { rawState: 'running' } });
    expect(JSON.stringify(s.actual)).not.toMatch(/huggingface|almyty-test|nvidia/);
    expect(JSON.stringify(h.actual)).not.toMatch(/stub/);
    for (const actual of [s.actual, h.actual]) {
      expect(JSON.stringify(actual)).not.toMatch(/token|hf_valid/);
    }

    // Each adapter only ever saw its own request; the HF fixture holds one endpoint, the stub one.
    expect(fixture.endpoints.size).toBe(1);
    expect(stub.endpoints.size).toBe(1);
    expect(hfDeploy.mock.calls[0][0].providerConfig).not.toHaveProperty('simulate');
    expect(stubDeploy.mock.calls[0][0].providerConfig).not.toHaveProperty('namespace');

    // A hub version needs no registry key at all, so none is resolved and
    // none is handed to an adapter; providerConfig never carries one either.
    expect(modelRegistry.adapterCredentialsFor).not.toHaveBeenCalled();
    for (const spy of [stubDeploy, hfDeploy]) {
      expect(spy.mock.calls[0][1]).not.toHaveProperty('registrySecretAccessKey');
      expect(spy.mock.calls[0][0].providerConfig).not.toHaveProperty('registryAccessKeyId');
      expect(spy.mock.calls[0][0].providerConfig).not.toHaveProperty('registrySecretAccessKey');
    }
    const hfBody = fixture.http.post.mock.calls[0][1];
    // Hugging Face builds the endpoint from the Hub repository itself, so no
    // registry location and no registry key belongs anywhere in the request.
    expect(hfBody.model).toMatchObject({ repository: 'Qwen/Qwen3-0.6B', revision: 'main' });
    expect(JSON.stringify(hfBody)).not.toContain(REGISTRY_KEYS.registryAccessKeyId);
    expect(JSON.stringify(hfBody)).not.toContain(REGISTRY_KEYS.registrySecretAccessKey);
    const stored = JSON.stringify([s.providerConfig, s.externalRef, s.actual, h.providerConfig, h.externalRef, h.actual, audit.rows]);
    expect(stored).not.toContain(REGISTRY_KEYS.registrySecretAccessKey);
    expect(stored).not.toContain(REGISTRY_KEYS.registryAccessKeyId);
  });

  it('gives each card its own stored provider row and lets the router plan over both, with no provider specifics', async () => {
    const router = new ModelRouterService(models as any, providerRows as any, deployments as any, audit as any);
    const plan = await router.plan(ORG, { objective: 'cheapest', privacyTier: 'private_cloud' });
    expect(plan.rejected).toEqual([]);
    expect(plan.candidates.map((c) => c.modelId).sort()).toEqual(['m-hf', 'm-stub']);
    const seen = new Set<string>();
    for (const c of plan.candidates) {
      const own = models.get(c.modelId);
      expect(c.modelVersionId).toBe(VERSION.id);
      // A real row on the OpenAI-compatible path: chat goes to
      // <apiUrl>/chat/completions, and a conversation can reference it.
      expect(c.provider.type).toBe(LlmProviderType.OPENAI);
      expect(c.provider.id).toBe(own.providerId);
      expect(seen.has(c.provider.id)).toBe(false);
      seen.add(c.provider.id);
      const configuration = c.provider.configuration as Record<string, any>;
      expect(configuration.apiUrl).toBe(EndpointProviderHelper.baseFor(own.endpointRef!.url));
      expect(configuration.model).toBe('qwen3-0.6b');
      // URL + model only; no adapter field and no inline secret reach the caller.
      expect(Object.keys(configuration).sort()).toEqual(['apiUrl', 'model']);
      expect(c.rationale).toMatch(/^cheapest/);
    }
  });
});
