import { Model } from '../../../../entities/model.entity';
import { ModelDeployment } from '../../../../entities/model-deployment.entity';
import { AuditAction } from '../../../../entities/audit-log.entity';
import { AdapterRegistry } from '../../adapters/adapter.registry';
import { StubAdapter } from '../../adapters/stub.adapter';
import { ModelDeploymentsProcessor } from '../../model-deployments.processor';
import { ModelDeploymentsService } from '../../model-deployments.service';
import { ensureTestKey, fakeAudit, fakeEnvelope, fakeQueue, fakeRegistry, fakeRepo, newDeployment } from './fakes';

/**
 * Gate (3), budget half: a deployment under a SpendBudget runs tick after
 * tick while the adapter's cost snapshot climbs; the tick that crosses the
 * limit scales it to zero, audits the stop with spent and limit, and
 * notifies the owner. Later ticks leave it at zero without repeating any
 * of that. The processor spec covers the single-tick case; this is the
 * scenario as the gate states it.
 */
const ORG = 'org-gate3';
const VERSION = { id: 'v-1', organizationId: ORG, name: 'qwen3-0.6b', base: 'qwen3-0.6b', registryUri: 's3://registry/models/qwen3-0.6b@1', quantizations: [], manifestSha: 'sha' };

describe('gate 3: a budget cap scales a deployment to zero and audits it', () => {
  let stub: StubAdapter;
  let deployments: ReturnType<typeof fakeRepo<ModelDeployment>>;
  let budgets: ReturnType<typeof fakeRepo<any>>;
  let audit: ReturnType<typeof fakeAudit>;
  let notifications: { emit: jest.Mock };
  let processor: ModelDeploymentsProcessor;
  let scale: jest.SpyInstance;
  let id: string;
  const budget = { id: 'b-1', organizationId: ORG, active: true, limitCents: 3 };

  beforeEach(async () => {
    ensureTestKey();
    // The stub charges one cent per running replica per snapshot, so spend is a tick counter.
    stub = new StubAdapter({ architectures: 'any', centsPerHour: 100 });
    scale = jest.spyOn(stub, 'scale');
    const registry = new AdapterRegistry();
    registry.register(stub);
    deployments = fakeRepo<ModelDeployment>(newDeployment);
    budgets = fakeRepo<any>(() => ({}), [{ ...budget }]);
    const models = fakeRepo<Model>(() => new Model(), [Object.assign(new Model(), { id: 'm-1', organizationId: ORG, pricingOverride: null, status: 'draft', endpointRef: null })]);
    const versions = fakeRepo<any>(() => ({}), [VERSION]);
    audit = fakeAudit();
    notifications = { emit: jest.fn(async () => undefined) };
    const queue = fakeQueue();
    const service = new ModelDeploymentsService(deployments as any, versions as any, fakeRepo<any>(() => ({})) as any, queue as any, registry, fakeEnvelope as any, audit as any, fakeRegistry() as any);
    processor = new ModelDeploymentsProcessor(queue as any, deployments as any, versions as any, models as any, budgets as any, registry, service, notifications as any);
    id = (await service.create(ORG, 'owner-1', { modelVersionId: VERSION.id, providerType: 'stub', providerConfig: { token: 'valid' }, budgetId: budget.id, modelId: 'm-1' })).id;
  });

  const budgetStops = () => audit.rows.filter((r) => r.action === AuditAction.MODEL_DEPLOYMENT_BUDGET_STOP);

  it('runs until the snapshot crosses the limit, then stops exactly once', async () => {
    // Ticks 1 and 2: under the limit, running.
    for (const expectedSpend of [1, 2]) {
      const d = (await processor.reconcile(id))!;
      expect(d.state).toBe('ready');
      expect(d.desired.replicas).toBe(1);
      expect(d.actual).toMatchObject({ spentCents: expectedSpend, ratePerHourCents: 100 });
    }
    expect(scale).not.toHaveBeenCalled();
    expect(budgetStops()).toHaveLength(0);
    expect(notifications.emit).not.toHaveBeenCalled();

    // Tick 3: spent reaches the limit.
    const stopped = (await processor.reconcile(id))!;
    expect(stopped.desired.replicas).toBe(0);
    expect(stopped.actual.spentCents).toBe(3);
    expect(scale).toHaveBeenCalledTimes(1);
    expect(scale).toHaveBeenCalledWith(stopped.externalRef, 0, expect.objectContaining({ token: 'valid' }));
    expect((await stub.readEndpoint(stopped.externalRef!, { token: 'valid' })).replicas).toBe(0);

    const stops = budgetStops();
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({
      organizationId: ORG,
      resourceId: id,
      resourceName: `stub:${VERSION.id}`,
      details: { providerType: 'stub', spentCents: 3, limitCents: 3, budgetId: 'b-1' },
    });
    expect(notifications.emit).toHaveBeenCalledTimes(1);
    expect(notifications.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'model.deployment.budget_stop',
      organizationId: ORG,
      userIds: ['owner-1'],
      body: expect.stringContaining('0.03 of its 0.03 budget'),
    }));

    // Tick 4: at zero, desired matches actual; nothing scales, nothing is re-audited, burn is 0.
    const idle = (await processor.reconcile(id))!;
    expect(idle.state).toBe('ready');
    expect(idle.desired.replicas).toBe(0);
    expect(idle.actual).toMatchObject({ state: 'stopped', replicas: 0, spentCents: 3, ratePerHourCents: 0 });
    expect(scale).toHaveBeenCalledTimes(1);
    expect(budgetStops()).toHaveLength(1);
    expect(notifications.emit).toHaveBeenCalledTimes(1);
    // The row was persisted with the stop, so a restart of the loop keeps it at zero.
    expect(deployments.get(id).desired.replicas).toBe(0);
  });

  it('ignores an inactive budget', async () => {
    budgets.get('b-1').active = false;
    for (let tick = 0; tick < 5; tick++) await processor.reconcile(id);
    const d = deployments.get(id);
    expect(d.desired.replicas).toBe(1);
    expect(d.actual.spentCents).toBe(5);
    expect(scale).not.toHaveBeenCalled();
    expect(budgetStops()).toHaveLength(0);
  });

  it('does not touch a budget that belongs to another organization', async () => {
    budgets.get('b-1').organizationId = 'someone-else';
    for (let tick = 0; tick < 5; tick++) await processor.reconcile(id);
    expect(deployments.get(id).desired.replicas).toBe(1);
    expect(scale).not.toHaveBeenCalled();
    expect(budgetStops()).toHaveLength(0);
  });
});
