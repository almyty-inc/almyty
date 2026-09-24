import { ModelDeployment } from '../../../entities/model-deployment.entity';
import { AdapterRegistry } from '../adapters/adapter.registry';
import { StubAdapter } from '../adapters/stub.adapter';
import { ModelDeploymentsProcessor } from '../model-deployments.processor';
import { fakeRepo, newDeployment } from './gates/fakes';

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
    // The shared truthful repository double (gates/fakes): criteria are
    // evaluated and the conditional claim behaves like the UPDATE it
    // stands for. The hand-rolled double this replaces returned
    // `{ affected: 1 }` from a query builder that ignored every clause,
    // so `if (!claim.affected)` — the only thing stopping two replicas
    // from each deploying a paid endpoint — could be deleted outright
    // with this suite still green.
    deployments = fakeRepo<ModelDeployment>(newDeployment, [row]);
    versions = { findOne: jest.fn(async () => ({ id: 'v-1', name: 'qwen', base: 'qwen3-0.6b', registryUri: 's3://r/q@1', quantizations: [], manifestSha: 'x' })) };
    // Criteria-evaluating: every card read in the loop is org-scoped,
    // so a where that loses `organizationId` must answer differently.
    models = {
      findOne: jest.fn(async ({ where }: any) =>
        where.id === 'm-1' && (where.organizationId ?? 'org-1') === 'org-1'
          ? { id: 'm-1', organizationId: 'org-1', pricingOverride: null }
          : null,
      ),
      save: jest.fn(async (m: any) => m),
    };
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

  /**
   * The deploy claim, from the losing side.
   *
   * adapter.deploy() runs for minutes, and two readers — the 2-minute
   * sweep and a user pressing retry, or two API replicas — both see
   * externalRef null. The conditional UPDATE lets exactly one through;
   * the other matches no row and must stop there. It used to deploy
   * anyway and overwrite externalRef, leaving the first endpoint a paid
   * GPU no row points at: the orphan check only notices endpoints the
   * PROVIDER has forgotten, never one the database has.
   */
  it('leaves a deployment alone when another replica already holds the claim', async () => {
    row.state = 'deploying';
    row.lastReconcileAt = new Date(); // a live claim, well inside the lease
    const deploySpy = jest.spyOn(stub, 'deploy');

    const out = await processor.reconcile('d-1');

    expect(deploySpy).not.toHaveBeenCalled();
    expect(out?.externalRef).toBeNull();
    expect(out?.state).toBe('deploying');
    // Nothing moved, so nothing is audited as having moved.
    expect(service.audit).not.toHaveBeenCalled();
  });

  it('deploys a row that names its model inline, without ever reading a version', async () => {
    row.modelVersionId = null;
    row.modelRef = 'hf://Qwen/Qwen3-0.6B@main';
    row.modelBase = 'qwen3-0.6b';
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
    row.modelVersionId = null;
    row.modelRef = null;
    versions.findOne.mockResolvedValue(null);
    const out = await processor.reconcile('d-1');
    expect(out?.state).toBe('failed');
    expect(out?.lastError).toMatch(/names no model/i);
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

  it('never prices a catalog card that belongs to another organization', async () => {
    // A deployment carries whatever modelId its creator sent, so the card
    // read in chargeBudget has to be organization-scoped like the two in
    // fillCard/clearCard. Unscoped, one org's reconcile loop rewrote the
    // pricing on another org's card.
    stub.costSnapshot = async () => ({
      spentCents: 5,
      ratePerHourCents: 10,
      observedAt: new Date(),
      perToken: { inPerMTok: 1, outPerMTok: 2, currency: 'USD' },
    });
    models.findOne.mockImplementation(async ({ where }: any) =>
      where.organizationId === 'org-1' ? null : { id: 'm-1', organizationId: 'org-2', pricingOverride: null },
    );

    await processor.reconcile('d-1');

    expect(models.findOne).toHaveBeenCalledWith({ where: { id: 'm-1', organizationId: 'org-1' } });
    expect(models.save).not.toHaveBeenCalled();
  });

  it('never unroutes a catalog card that belongs to another organization', async () => {
    // `clearCard` had the same shape as the pricing read below and the
    // same exposure: a deployment carries whatever modelId its creator
    // sent, so the lookup is organization-scoped. Unscoped, a teardown
    // in one org flipped another org's card to inactive and dropped its
    // endpoint — and the repository double answered with the same card
    // whatever `where` it was handed, so the predicate could be deleted
    // outright with this suite green.
    await processor.reconcile('d-1');
    models.save.mockClear();
    models.findOne.mockImplementation(async ({ where }: any) =>
      where.organizationId === 'org-1'
        ? null
        : { id: 'm-1', organizationId: 'org-2', status: 'active', endpointRef: null, metadata: {} },
    );
    row.state = 'tearing_down';

    const out = await processor.reconcile('d-1');

    expect(out?.state).toBe('torn_down');
    expect(models.findOne).toHaveBeenCalledWith({ where: { id: 'm-1', organizationId: 'org-1' } });
    expect(models.save).not.toHaveBeenCalled();
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
