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

  it('a teardown that fails once is retried, and never brings the endpoint back to life', async () => {
    await processor.reconcile(id);
    expect(card().status).toBe('active');
    await service.teardown(ORG, id, 'owner-1');

    const teardown = jest.spyOn(stub, 'teardown');
    teardown.mockRejectedValueOnce(Object.assign(new Error('provider 503'), { code: 'ADAPTER_ERROR' }));
    const stuck = (await processor.reconcile(id))!;
    // The intent survives the failure: still tearing down, still asked for.
    expect(stuck.state).toBe('tearing_down');
    expect((stuck.desired as any).teardownRequested).toBe(true);
    expect(stuck.lastError).toContain('provider 503');
    expect(stuck.externalRef).toBeTruthy();
    expect(card().status).toBe('inactive');

    const done = (await processor.reconcile(id))!;
    expect(teardown).toHaveBeenCalledTimes(2);
    expect(done.state).toBe('torn_down');
    expect(done.externalRef).toBeNull();
    expect((done.desired as any).teardownRequested).toBe(false);
    expect(card().status).toBe('inactive');
    expect(card().endpointRef).toBeNull();
    teardown.mockRestore();
  });

  /**
   * Two reconciles, one deploy.
   *
   * adapter.deploy() is a provider call that runs for minutes (Modal's
   * timeout is 30), and reconcile is reachable from the 2-minute sweep,
   * from a user pressing retry, and from every API replica at once.
   * Both readers saw `externalRef` null and both deployed; the second
   * save overwrote externalRef, leaving the first endpoint a paid GPU
   * resource no row points at. The orphan check cannot find those --
   * it only notices deployments the PROVIDER has forgotten, never one
   * the database has.
   */
  it('deploys once when two reconciles race the same row', async () => {
    let inFlight = 0;
    let concurrentPeak = 0;
    const realDeploy = stub.deploy.bind(stub);
    const deploy = jest.spyOn(stub, 'deploy').mockImplementation(async (...args: any[]) => {
      inFlight += 1;
      concurrentPeak = Math.max(concurrentPeak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return (realDeploy as any)(...args);
    });

    await Promise.all([processor.reconcile(id), processor.reconcile(id)]);

    expect(concurrentPeak).toBe(1);
    expect(deploy).toHaveBeenCalledTimes(1);
  });

  /**
   * A teardown committed mid-tick is not erased by that tick.
   *
   * The sweep loads the deployment ready, then spends seconds inside a
   * provider read. The user tears down in that window: `tearing_down`
   * plus `desired.teardownRequested` are committed and the API returns
   * 200. The read then fails, and `save(entity)` wrote back every
   * column that differed from the row -- including the tick's stale
   * `desired` -- so the teardown intent was erased, the next tick
   * reconciled the endpoint back to ready, and the GPU kept billing.
   */
  it('a teardown committed while a provider read is in flight survives the tick that missed it', async () => {
    await processor.reconcile(id);
    // Two requests get two entities, the way TypeORM hands each its own.
    deployments.findOne.mockImplementation(async (opts: any) => {
      const row: any = [...deployments.rows.values()].find(
        (r: any) => r.id === opts?.where?.id && (opts?.where?.organizationId === undefined || r.organizationId === opts.where.organizationId),
      );
      return row ? Object.assign(new ModelDeployment(), row) : null;
    });

    const read = jest.spyOn(stub, 'readEndpoint').mockImplementationOnce(async () => {
      await service.teardown(ORG, id, 'owner-1');
      throw Object.assign(new Error('provider 503'), { code: 'ADAPTER_ERROR' });
    });
    await processor.reconcile(id);
    read.mockRestore();

    const row = deployments.get(id);
    expect((row.desired as any).teardownRequested).toBe(true);

    // And the intent is acted on, so nothing keeps billing.
    const done = (await processor.reconcile(id))!;
    expect(done.state).toBe('torn_down');
    expect(done.externalRef).toBeNull();
    expect(deployments.get(id).state).toBe('torn_down');
  });

  /**
   * A claim is a lease. A pod that died inside adapter.deploy() left the
   * row `deploying` with a null externalRef, and `state != 'deploying'`
   * never matched again: nothing at the provider, nothing the orphan
   * check can see (it only notices endpoints the provider forgot), and
   * no tick able to retry.
   */
  it('reclaims a deploy claim abandoned by a dead pod', async () => {
    const crash = jest.spyOn(stub, 'deploy').mockRejectedValueOnce(Object.assign(new Error('pod killed'), { code: 'ADAPTER_ERROR' }));
    await processor.reconcile(id);
    crash.mockRestore();
    // What the dead pod left behind: claimed, no endpoint.
    const stuck = deployments.get(id);
    stuck.state = 'deploying';
    stuck.externalRef = null;
    stuck.lastReconcileAt = new Date();
    await deployments.save(stuck);

    const blocked = (await processor.reconcile(id))!;
    expect(blocked.externalRef).toBeNull();

    // Past the lease the claim is taken over and the deploy happens.
    const aged = deployments.get(id);
    aged.lastReconcileAt = new Date(Date.now() - 46 * 60 * 1000);
    await deployments.save(aged);
    const retried = (await processor.reconcile(id))!;
    expect(retried.externalRef).toBeTruthy();
    expect(retried.state).toBe('ready');
  });
});
