import { Model } from '../../../entities/model.entity';
import { ModelDeployment } from '../../../entities/model-deployment.entity';
import { AdapterRegistry } from '../adapters/adapter.registry';
import { StubAdapter } from '../adapters/stub.adapter';
import { ModelDeploymentsProcessor } from '../model-deployments.processor';
import { FakeRepo, fakeRepo, newDeployment } from './gates/fakes';

/**
 * The state machine, driven against the stub adapter. Every branch the
 * spec names: deploy to ready, scale diff, budget stop, orphan, teardown,
 * failure.
 *
 * Deployments, cards and budgets are truthful tables (gates/fakes). The
 * hand-rolled doubles these replace answered the same card whatever
 * `where` they were handed and a claim of `{ affected: 1 }` whatever the
 * row said, so the organization predicate on the card `clearCard` unroutes
 * could be deleted with this suite green, and the claim could only ever be
 * seen winning.
 */
describe('ModelDeploymentsProcessor.reconcile', () => {
  let stub: StubAdapter;
  let registry: AdapterRegistry;
  let deployments: FakeRepo<ModelDeployment>;
  let versions: any;
  let models: FakeRepo<Model>;
  let budgets: FakeRepo<any>;
  let service: any;
  let notifications: any;
  let processor: ModelDeploymentsProcessor;

  const row = () => deployments.get('d-1');
  const card = (over: Partial<Model> = {}) =>
    Object.assign(new Model(), { id: 'm-1', organizationId: 'org-1', status: 'draft', endpointRef: null, metadata: null, pricingOverride: null, ...over });

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'unit-test-key-32-bytes-minimum-len';
    stub = new StubAdapter({ architectures: 'any', centsPerHour: 100 });
    registry = new AdapterRegistry();
    registry.register(stub);
    deployments = fakeRepo<ModelDeployment>(newDeployment, [
      Object.assign(new ModelDeployment(), {
        id: 'd-1', organizationId: 'org-1', modelVersionId: 'v-1', modelId: 'm-1', providerType: 'stub',
        desired: { replicas: 1, minScale: 0, maxScale: 1 }, providerConfig: { token: 'valid', simulate: 'none' },
        externalRef: null, actual: null, state: 'pending', budgetId: null, createdBy: 'u-1', createdAt: new Date(), updatedAt: new Date(),
      }),
    ]);
    versions = { findOne: jest.fn(async () => ({ id: 'v-1', name: 'qwen', base: 'qwen3-0.6b', registryUri: 's3://r/q@1', quantizations: [], manifestSha: 'x' })) };
    models = fakeRepo<Model>(() => new Model(), [card()]);
    budgets = fakeRepo<any>(() => ({}));
    service = { credentialsFor: jest.fn(async () => ({ token: 'valid' })), audit: jest.fn() };
    notifications = { emit: jest.fn(async () => undefined) };
    processor = new ModelDeploymentsProcessor({ getRepeatableJobs: jest.fn(), add: jest.fn() } as any, deployments as any, versions, models as any, budgets as any, registry, service, notifications);
  });

  it('deploys a pending row, reaches ready, fills the card and records cost', async () => {
    const out = await processor.reconcile('d-1');
    expect(out?.state).toBe('ready');
    expect(out?.externalRef?.id).toMatch(/^stub-ep-/);
    expect(out?.actual).toMatchObject({ state: 'ready', replicas: 1, spentCents: 1, ratePerHourCents: 100 });
    expect(row()).toMatchObject({ state: 'ready', externalRef: { id: out?.externalRef?.id } });
    expect(models.get('m-1')).toMatchObject({ status: 'active', endpointRef: { deploymentId: 'd-1' } });
    const transitions = service.audit.mock.calls.map((c: any[]) => c[3]?.to);
    expect(transitions).toEqual(['deploying', 'ready']);
  });

  /**
   * The deploy claim, from the losing side. adapter.deploy() runs for
   * minutes and two readers -- the sweep and a retry, or two replicas --
   * both see externalRef null. The conditional UPDATE lets one through;
   * the other matches no row and must stop there, or it deploys a second
   * paid endpoint and overwrites the first one's ref.
   */
  it('leaves a deployment alone when another replica holds a live claim', async () => {
    await deployments.update('d-1', { state: 'deploying', lastReconcileAt: new Date() });
    const deploySpy = jest.spyOn(stub, 'deploy');

    const out = await processor.reconcile('d-1');

    expect(deploySpy).not.toHaveBeenCalled();
    expect(out?.externalRef).toBeNull();
    expect(row()).toMatchObject({ state: 'deploying', externalRef: null });
    expect(service.audit).not.toHaveBeenCalled();
  });

  it('claims only its own row', async () => {
    deployments.seed(Object.assign(new ModelDeployment(), { ...row(), id: 'd-2', state: 'pending', lastReconcileAt: null }));
    await processor.reconcile('d-1');
    expect(deployments.get('d-2')).toMatchObject({ state: 'pending', lastReconcileAt: null });
  });

  it('deploys a row that names its model inline, without ever reading a version', async () => {
    await deployments.update('d-1', { modelVersionId: null, modelRef: 'hf://Qwen/Qwen3-0.6B@main', modelBase: 'qwen3-0.6b' });
    const deploySpy = jest.spyOn(stub, 'deploy');
    const out = await processor.reconcile('d-1');
    expect(versions.findOne).not.toHaveBeenCalled();
    expect(out?.state).toBe('ready');
    expect(deploySpy).toHaveBeenCalledWith(
      expect.objectContaining({ version: expect.objectContaining({ registryUri: 'hf://Qwen/Qwen3-0.6B@main', base: 'qwen3-0.6b' }) }),
      expect.anything(),
    );
  });

  it('fails a row that names no model at all rather than deploying nothing', async () => {
    await deployments.update('d-1', { modelVersionId: null, modelRef: null });
    versions.findOne.mockResolvedValue(null);
    const out = await processor.reconcile('d-1');
    expect(out?.state).toBe('failed');
    expect(out?.lastError).toMatch(/names no model/i);
    expect(row().state).toBe('failed');
  });

  it('scales when desired replicas differ from actual', async () => {
    await processor.reconcile('d-1');
    await deployments.update('d-1', { desired: { ...row().desired, replicas: 0 } });
    const out = await processor.reconcile('d-1');
    expect(out?.state).toBe('scaling');
    const actual = await stub.readEndpoint(row().externalRef!, { token: 'valid' });
    expect(actual.replicas).toBe(0);
    const again = await processor.reconcile('d-1');
    expect(again?.state).toBe('ready');
    expect(again?.actual?.ratePerHourCents).toBe(0);
  });

  it('scales to zero and audits when the budget is reached', async () => {
    await deployments.update('d-1', { budgetId: 'b-1' });
    budgets.seed({ id: 'b-1', organizationId: 'org-1', active: true, limitCents: 1 });
    const out = await processor.reconcile('d-1');
    expect(out?.desired.replicas).toBe(0);
    expect(row().desired.replicas).toBe(0);
    expect(service.audit).toHaveBeenCalledWith(expect.anything(), 'model_deployment_budget_stop', null, expect.objectContaining({ limitCents: 1 }));
    expect(notifications.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'model.deployment.budget_stop' }));
  });

  // A deployment carries whatever modelId its creator sent, so every card
  // the loop reads is organization-scoped: here the id names another
  // organization's card.
  it('never prices a catalog card that belongs to another organization', async () => {
    stub.costSnapshot = async () => ({
      spentCents: 5,
      ratePerHourCents: 10,
      observedAt: new Date(),
      perToken: { inPerMTok: 1, outPerMTok: 2, currency: 'USD' },
    });
    models = fakeRepo<Model>(() => new Model(), [card({ organizationId: 'org-2', pricing: null } as any)]);
    processor = new ModelDeploymentsProcessor({} as any, deployments as any, versions, models as any, budgets as any, registry, service, notifications);

    await processor.reconcile('d-1');

    expect(models.get('m-1')).toMatchObject({ organizationId: 'org-2', pricing: null, status: 'draft' });
  });

  it('never unroutes a catalog card that belongs to another organization', async () => {
    await processor.reconcile('d-1');
    // The same card id, now another organization's, live and routed.
    await models.update('m-1', { organizationId: 'org-2', status: 'active', endpointRef: { url: 'https://theirs', deploymentId: 'd-1' } });
    await deployments.update('d-1', { state: 'tearing_down' });

    const out = await processor.reconcile('d-1');

    expect(out?.state).toBe('torn_down');
    expect(models.get('m-1')).toMatchObject({ status: 'active', endpointRef: { url: 'https://theirs' } });
  });

  it('marks a deployment orphaned when the provider forgot it, and unroutes its card', async () => {
    await processor.reconcile('d-1');
    expect(models.get('m-1').status).toBe('active');
    stub.vanish(row().externalRef!.id);
    const out = await processor.reconcile('d-1');
    expect(out?.state).toBe('orphaned');
    expect(row().state).toBe('orphaned');
    expect(models.get('m-1')).toMatchObject({ status: 'inactive', endpointRef: null });
    expect(service.audit).toHaveBeenCalledWith(expect.anything(), 'model_deployment_orphan_teardown', null, expect.anything());
  });

  it('tears down on request, drops the handle, unroutes the card and leaves the version alone', async () => {
    await processor.reconcile('d-1');
    const ref = row().externalRef!;
    await deployments.update('d-1', { state: 'tearing_down' });
    const out = await processor.reconcile('d-1');
    expect(out?.state).toBe('torn_down');
    expect(out?.externalRef).toBeNull();
    expect(row()).toMatchObject({ state: 'torn_down', externalRef: null });
    expect(models.get('m-1')).toMatchObject({ status: 'inactive', endpointRef: null });
    expect((await stub.readEndpoint(ref, { token: 'valid' })).state).toBe('missing');
    expect(versions.findOne).toHaveBeenCalledTimes(1);
  });

  it('records a provider failure on the row instead of throwing', async () => {
    await deployments.update('d-1', { providerConfig: { token: 'valid', simulate: 'quota_exceeded' } });
    const out = await processor.reconcile('d-1');
    expect(out?.state).toBe('failed');
    expect(out?.lastError).toMatch(/quota exceeded/);
    expect(row().state).toBe('failed');
  });

  it('never writes secrets into actual', async () => {
    const leaky = new StubAdapter({ architectures: 'any' });
    leaky.readEndpoint = async () => ({ state: 'ready', url: 'u', replicas: 1, details: { apiToken: 'leak', note: 'ok' } });
    registry = new AdapterRegistry();
    registry.register(leaky);
    processor = new ModelDeploymentsProcessor({} as any, deployments as any, versions, models as any, budgets as any, registry, service, notifications);
    const out = await processor.reconcile('d-1');
    expect(JSON.stringify(out?.actual)).not.toContain('leak');
    expect(out?.actual?.details).toEqual({ note: 'ok' });
    expect(JSON.stringify(row().actual)).not.toContain('leak');
  });

  it('is disabled under test and by MODEL_RECONCILE_CRON=off', () => {
    expect(processor.isEnabled()).toBe(false);
    process.env.MODEL_RECONCILE_CRON = 'off';
    expect(processor.cron()).toBeUndefined();
    delete process.env.MODEL_RECONCILE_CRON;
    expect(processor.cron()).toBe('*/2 * * * *');
  });
});
