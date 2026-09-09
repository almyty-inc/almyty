import { ModelDeployment } from '../../../entities/model-deployment.entity';
import { AdapterRegistry } from '../adapters/adapter.registry';
import { StubAdapter } from '../adapters/stub.adapter';
import { ModelDeploymentsProcessor } from '../model-deployments.processor';

/**
 * The state machine, driven against the stub adapter with the
 * repositories mocked. Every branch the spec names: deploy to ready,
 * scale diff, budget stop, orphan, teardown, failure.
 */
describe('ModelDeploymentsProcessor.reconcile', () => {
  let stub: StubAdapter;
  let registry: AdapterRegistry;
  let deployments: any;
  let versions: any;
  let models: any;
  let budgets: any;
  let service: any;
  let notifications: any;
  let processor: ModelDeploymentsProcessor;
  let row: ModelDeployment;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'unit-test-key-32-bytes-minimum-len';
    stub = new StubAdapter({ architectures: 'any', centsPerHour: 100 });
    registry = new AdapterRegistry();
    registry.register(stub);
    row = Object.assign(new ModelDeployment(), {
      id: 'd-1', organizationId: 'org-1', modelVersionId: 'v-1', modelId: 'm-1', providerType: 'stub',
      desired: { replicas: 1, minScale: 0, maxScale: 1 }, providerConfig: { token: 'valid', simulate: 'none' },
      externalRef: null, actual: null, state: 'pending', budgetId: null, createdBy: 'u-1', createdAt: new Date(), updatedAt: new Date(),
    });
    deployments = { findOne: jest.fn(async () => row), save: jest.fn(async (r: any) => r), find: jest.fn(async () => [row]) };
    versions = { findOne: jest.fn(async () => ({ id: 'v-1', name: 'qwen', base: 'qwen3-0.6b', registryUri: 's3://r/q@1', quantizations: [], manifestSha: 'x' })) };
    models = { findOne: jest.fn(async () => ({ id: 'm-1', organizationId: 'org-1', pricingOverride: null })), save: jest.fn(async (m: any) => m) };
    budgets = { findOne: jest.fn(async () => null) };
    service = { credentialsFor: jest.fn(async () => ({ token: 'valid' })), audit: jest.fn() };
    notifications = { emit: jest.fn(async () => undefined) };
    processor = new ModelDeploymentsProcessor({ getRepeatableJobs: jest.fn(), add: jest.fn() } as any, deployments, versions, models, budgets, registry, service, notifications);
  });

  it('deploys a pending row, reaches ready, fills the card and records cost', async () => {
    const out = await processor.reconcile('d-1');
    expect(out?.state).toBe('ready');
    expect(out?.externalRef?.id).toMatch(/^stub-ep-/);
    expect(out?.actual).toMatchObject({ state: 'ready', replicas: 1, spentCents: 1, ratePerHourCents: 100 });
    expect(models.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'm-1', status: 'active', endpointRef: expect.objectContaining({ deploymentId: 'd-1' }) }));
    const transitions = service.audit.mock.calls.map((c: any[]) => c[3]?.to);
    expect(transitions).toEqual(['deploying', 'ready']);
  });

  it('scales when desired replicas differ from actual', async () => {
    await processor.reconcile('d-1');
    row.desired = { ...row.desired, replicas: 0 };
    const out = await processor.reconcile('d-1');
    expect(out?.state).toBe('scaling');
    const actual = await stub.readEndpoint(row.externalRef!, { token: 'valid' });
    expect(actual.replicas).toBe(0);
    const again = await processor.reconcile('d-1');
    expect(again?.state).toBe('ready');
    expect(again?.actual?.ratePerHourCents).toBe(0);
  });

  it('scales to zero and audits when the budget is reached', async () => {
    row.budgetId = 'b-1';
    budgets.findOne.mockResolvedValue({ id: 'b-1', organizationId: 'org-1', active: true, limitCents: 1 });
    const out = await processor.reconcile('d-1');
    expect(out?.desired.replicas).toBe(0);
    expect(service.audit).toHaveBeenCalledWith(expect.anything(), 'model_deployment_budget_stop', null, expect.objectContaining({ limitCents: 1 }));
    expect(notifications.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'model.deployment.budget_stop' }));
  });

  it('marks a deployment orphaned when the provider forgot it', async () => {
    await processor.reconcile('d-1');
    stub.vanish(row.externalRef!.id);
    row.updatedAt = new Date(Date.now() - 60 * 60 * 1000);
    const out = await processor.reconcile('d-1');
    expect(out?.state).toBe('orphaned');
    expect(service.audit).toHaveBeenCalledWith(expect.anything(), 'model_deployment_orphan_teardown', null, expect.anything());
  });

  it('tears down on request, drops the handle, and leaves the version alone', async () => {
    await processor.reconcile('d-1');
    const ref = row.externalRef!;
    row.state = 'tearing_down';
    const out = await processor.reconcile('d-1');
    expect(out?.state).toBe('torn_down');
    expect(out?.externalRef).toBeNull();
    expect((await stub.readEndpoint(ref, { token: 'valid' })).state).toBe('missing');
    expect(versions.findOne).toHaveBeenCalledTimes(1);
  });

  it('records a provider failure on the row instead of throwing', async () => {
    row.providerConfig = { token: 'valid', simulate: 'quota_exceeded' };
    const out = await processor.reconcile('d-1');
    expect(out?.state).toBe('failed');
    expect(out?.lastError).toMatch(/quota exceeded/);
  });

  it('never writes secrets into actual', async () => {
    const leaky = new StubAdapter({ architectures: 'any' });
    leaky.readEndpoint = async () => ({ state: 'ready', url: 'u', replicas: 1, details: { apiToken: 'leak', note: 'ok' } });
    registry = new AdapterRegistry();
    registry.register(leaky);
    processor = new ModelDeploymentsProcessor({} as any, deployments, versions, models, budgets, registry, service, notifications);
    const out = await processor.reconcile('d-1');
    expect(JSON.stringify(out?.actual)).not.toContain('leak');
    expect(out?.actual?.details).toEqual({ note: 'ok' });
  });

  it('is disabled under test and by MODEL_RECONCILE_CRON=off', () => {
    expect(processor.isEnabled()).toBe(false);
    process.env.MODEL_RECONCILE_CRON = 'off';
    expect(processor.cron()).toBeUndefined();
    delete process.env.MODEL_RECONCILE_CRON;
    expect(processor.cron()).toBe('*/2 * * * *');
  });
});
