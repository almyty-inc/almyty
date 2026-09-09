import { Model } from '../../../../entities/model.entity';
import { ModelDeployment } from '../../../../entities/model-deployment.entity';
import { AuditAction } from '../../../../entities/audit-log.entity';
import { AdapterRegistry } from '../../adapters/adapter.registry';
import { StubAdapter } from '../../adapters/stub.adapter';
import { ModelDeploymentsProcessor } from '../../model-deployments.processor';
import { ModelDeploymentsService } from '../../model-deployments.service';
import { ensureTestKey, fakeAudit, fakeEnvelope, fakeQueue, fakeRegistry, fakeRepo, newDeployment } from './fakes';

/**
 * What a deployment must survive: a provider that times out once, a job
 * left in the queue after a teardown, an endpoint that vanishes, and the
 * catalog card that must stop being routable the moment the endpoint
 * stops serving. Every case is driven tick by tick, no timers.
 */
const ORG = 'org-life';
const VERSION = { id: 'v-1', organizationId: ORG, name: 'qwen3-0.6b', base: 'qwen3-0.6b', registryUri: 's3://registry/models/qwen3-0.6b@1', quantizations: [], manifestSha: 'sha' };

describe('deployment lifecycle hardening', () => {
  let stub: StubAdapter;
  let deployments: ReturnType<typeof fakeRepo<ModelDeployment>>;
  let models: ReturnType<typeof fakeRepo<Model>>;
  let audit: ReturnType<typeof fakeAudit>;
  let service: ModelDeploymentsService;
  let processor: ModelDeploymentsProcessor;
  let id: string;

  const card = () => models.get('m-1');

  beforeEach(async () => {
    ensureTestKey();
    stub = new StubAdapter({ architectures: 'any', centsPerHour: 60 });
    const registry = new AdapterRegistry();
    registry.register(stub);
    deployments = fakeRepo<ModelDeployment>(newDeployment);
    models = fakeRepo<Model>(() => new Model(), [Object.assign(new Model(), { id: 'm-1', organizationId: ORG, name: 'card', vendorModelId: 'qwen', status: 'active', validationStatus: 'passed', endpointRef: null, metadata: null, pricingOverride: null })]);
    const versions = fakeRepo<any>(() => ({}), [VERSION]);
    audit = fakeAudit();
    const queue = fakeQueue();
    service = new ModelDeploymentsService(deployments as any, versions as any, fakeRepo<any>(() => ({})) as any, queue as any, registry, fakeEnvelope as any, audit as any, fakeRegistry() as any);
    processor = new ModelDeploymentsProcessor(queue as any, deployments as any, versions as any, models as any, fakeRepo<any>(() => ({})) as any, registry, service, undefined as any);
    id = (await service.create(ORG, 'owner-1', { modelVersionId: VERSION.id, providerType: 'stub', providerConfig: { token: 'valid' }, modelId: 'm-1' })).id;
  });

  it('one timed-out read degrades but keeps watching; three in a row is a failure', async () => {
    const ready = (await processor.reconcile(id))!;
    expect(ready.state).toBe('ready');
    expect(card().status).toBe('active');
    expect(card().endpointRef).toMatchObject({ deploymentId: id });

    const read = jest.spyOn(stub, 'readEndpoint');
    read.mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    const blip = (await processor.reconcile(id))!;
    expect(blip.state).toBe('degraded');
    expect(blip.lastError).toContain('socket hang up');
    expect(blip.actual.consecutiveErrors).toBe(1);
    expect(blip.externalRef).toBeTruthy();
    // Degraded stays in the sweep, so a paid endpoint is still watched.
    expect((await processor.handleSweep()).reconciled).toBeGreaterThan(0);

    // A good read clears the counter and lights the card again.
    const recovered = (await processor.reconcile(id))!;
    expect(recovered.state).toBe('ready');
    expect(recovered.actual.consecutiveErrors).toBe(0);
    expect(card().status).toBe('active');
    expect(card().metadata?.unroutableSince).toBeUndefined();

    read.mockRejectedValue(Object.assign(new Error('gateway timeout'), { code: 'ETIMEDOUT' }));
    expect((await processor.reconcile(id))!.state).toBe('degraded');
    expect((await processor.reconcile(id))!.state).toBe('degraded');
    const failed = (await processor.reconcile(id))!;
    expect(failed.state).toBe('failed');
    read.mockRestore();
  });

  it('a failed deployment whose endpoint still exists keeps being swept, so its cost is still read', async () => {
    await processor.reconcile(id);
    const d = deployments.get(id);
    d.state = 'failed';
    d.lastError = 'earlier blip';
    await deployments.save(d);
    const spend = jest.spyOn(stub, 'costSnapshot');
    await processor.handleSweep();
    expect(spend).toHaveBeenCalled();
    // Recovered by the same sweep, because the endpoint is in fact fine.
    expect(deployments.get(id).state).toBe('ready');
    spend.mockRestore();
  });

  it('a stale job after teardown does not deploy the endpoint again', async () => {
    await processor.reconcile(id);
    await service.teardown(ORG, id, 'owner-1');
    const down = (await processor.reconcile(id))!;
    expect(down.state).toBe('torn_down');
    expect(down.externalRef).toBeNull();
    expect(card().status).toBe('inactive');
    expect(card().endpointRef).toBeNull();

    const deploy = jest.spyOn(stub, 'deploy');
    const again = (await processor.reconcile(id))!;
    expect(deploy).not.toHaveBeenCalled();
    expect(again.state).toBe('torn_down');
    expect(again.externalRef).toBeNull();
    deploy.mockRestore();
  });

  it('the orphan grace runs from the first missing read, not from the last save', async () => {
    const created = (await processor.reconcile(id))!;
    const ref = created.externalRef!;
    const d = deployments.get(id);
    d.state = 'deploying';
    await deployments.save(d);
    stub.vanish(ref.id);

    const first = (await processor.reconcile(id))!;
    expect(first.state).toBe('deploying');
    const missingSince = first.actual.missingSince;
    expect(missingSince).toEqual(expect.any(String));

    // Ticks keep saving the row; the window must not move with them.
    const second = (await processor.reconcile(id))!;
    expect(second.actual.missingSince).toBe(missingSince);

    // Past the grace, it is an orphan and the card is unrouted.
    const aged = deployments.get(id);
    aged.actual = { ...aged.actual, missingSince: new Date(Date.now() - 31 * 60 * 1000).toISOString() };
    await deployments.save(aged);
    const orphan = (await processor.reconcile(id))!;
    expect(orphan.state).toBe('orphaned');
    expect(audit.rows.some((r) => r.action === AuditAction.MODEL_DEPLOYMENT_ORPHAN_TEARDOWN)).toBe(true);
    expect(card().status).toBe('inactive');
    expect(card().endpointRef).toBeNull();
  });

  it('a stopped endpoint makes the card unroutable, and a ready one makes it routable again', async () => {
    await processor.reconcile(id);
    expect(card().status).toBe('active');

    const d = deployments.get(id);
    d.desired = { ...d.desired, replicas: 0 };
    await deployments.save(d);
    await processor.reconcile(id);
    const stopped = (await processor.reconcile(id))!;
    expect(stopped.actual.state).toBe('stopped');
    expect(card().status).toBe('inactive');
    expect(card().metadata?.unroutableReason).toContain('stopped');
    expect(card().isSelectable()).toBe(false);

    const back = deployments.get(id);
    back.desired = { ...back.desired, replicas: 1 };
    await deployments.save(back);
    await processor.reconcile(id);
    await processor.reconcile(id);
    expect(card().status).toBe('active');
    expect(card().metadata?.unroutableReason).toBeUndefined();
  });
});
