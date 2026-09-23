import { readFileSync } from 'fs';
import { join } from 'path';

import { Model } from '../../../../entities/model.entity';
import { ModelDeployment } from '../../../../entities/model-deployment.entity';
import { AuditAction } from '../../../../entities/audit-log.entity';
import { AdapterRegistry } from '../../adapters/adapter.registry';
import {
  ActualState,
  AdapterCredentials,
  CostSnapshot,
  DeployRequest,
  EndpointRef,
  ModelProviderAdapter,
} from '../../adapters/adapter.interface';
import { ModelDeploymentsProcessor } from '../../model-deployments.processor';
import { ModelDeploymentsService } from '../../model-deployments.service';
import { ensureTestKey, fakeAudit, fakeEnvelope, fakeQueue, fakeRegistry, fakeRepo, newDeployment } from './fakes';

/**
 * Several platforms expose no replica control of their own, so their
 * adapter records the ceiling on the endpoint ref and readEndpoint reads
 * it back out: Modal's `maxContainers` (modal.adapter.ts), Bedrock
 * import's `maxCopies` (aws-bedrock-import.adapter.ts). This fake has
 * exactly that shape.
 *
 * Every existing deployment spec uses StubAdapter, whose scale() mutates
 * internal state the fake keeps in memory rather than the ref — which is
 * why the whole suite stayed green while the two real ref-ceiling
 * adapters could not scale at all.
 */
class RefCeilingAdapter implements ModelProviderAdapter {
  readonly key = 'ref-ceiling';
  readonly displayName = 'Ref ceiling';
  scaleCalls: number[] = [];

  capabilities() {
    return { architectures: 'any' as const, lora: 'none' as const, serverless: false, dedicated: true, scaleToZero: true, regions: [] as string[], registrySources: ['s3' as const] };
  }
  configSchema() {
    return { type: 'object', properties: {}, required: [] as string[] };
  }
  async deploy(request: DeployRequest, _c: AdapterCredentials): Promise<EndpointRef> {
    return { endpointName: request.deploymentId, url: 'https://endpoint.test/v1', maxContainers: request.desired.replicas ?? 1, createdAt: new Date().toISOString() };
  }
  async readEndpoint(ref: EndpointRef, _c: AdapterCredentials): Promise<ActualState> {
    const ceiling = Number(ref.maxContainers ?? 1);
    return ceiling === 0
      ? { state: 'stopped', url: ref.url, replicas: 0 }
      : { state: 'ready', url: ref.url, replicas: ceiling };
  }
  async scale(ref: EndpointRef, replicas: number, _c: AdapterCredentials): Promise<void> {
    this.scaleCalls.push(replicas);
    ref.maxContainers = replicas;
  }
  async teardown(): Promise<void> {
    /* nothing to delete in the fake */
  }
  async costSnapshot(ref: EndpointRef, _c: AdapterCredentials): Promise<CostSnapshot> {
    return { spentCents: 0, ratePerHourCents: Number(ref.maxContainers ?? 0) * 100, observedAt: new Date() };
  }
}

const ORG = 'org-ref-ceiling';
const VERSION = { id: 'v-1', organizationId: ORG, name: 'qwen3-0.6b', base: 'qwen3-0.6b', registryUri: 's3://registry/models/qwen3-0.6b@1', quantizations: [], manifestSha: 'sha' };
/**
 * `fakeRepo` hands out the stored object itself, so an adapter that
 * mutates `d.externalRef` mutates the row whether or not anything
 * persisted it — which is precisely why the suite could not see this bug.
 * A real repository materialises a fresh object per read. This wrapper
 * detaches the JSON columns on the way out, so a mutation the processor
 * does not write back is lost, the way it is against Postgres.
 */
function detachingRepo(inner: ReturnType<typeof fakeRepo<ModelDeployment>>) {
  const JSON_COLUMNS = ['externalRef', 'actual', 'desired', 'providerConfig'] as const;
  const detach = (row: any) => {
    if (!row) return row;
    const copy = Object.create(Object.getPrototypeOf(row));
    Object.assign(copy, row);
    for (const col of JSON_COLUMNS) {
      if (row[col] && typeof row[col] === 'object') copy[col] = JSON.parse(JSON.stringify(row[col]));
    }
    return copy;
  };
  return {
    ...inner,
    find: jest.fn(async (opts?: any) => (await inner.find(opts)).map(detach)),
    findOne: jest.fn(async (opts?: any) => detach(await inner.findOne(opts))),
  };
}

describe('a scale that the adapter records on the endpoint ref is persisted', () => {
  let adapter: RefCeilingAdapter;
  let store: ReturnType<typeof fakeRepo<ModelDeployment>>;
  let deployments: any;
  let models: ReturnType<typeof fakeRepo<Model>>;
  let budgets: ReturnType<typeof fakeRepo<any>>;
  let audit: ReturnType<typeof fakeAudit>;
  let processor: ModelDeploymentsProcessor;
  let service: ModelDeploymentsService;
  let id: string;

  beforeEach(async () => {
    ensureTestKey();
    adapter = new RefCeilingAdapter();
    const registry = new AdapterRegistry();
    registry.register(adapter);
    store = fakeRepo<ModelDeployment>(newDeployment);
    deployments = detachingRepo(store) as any;
    models = fakeRepo<Model>(() => new Model(), [
      Object.assign(new Model(), { id: 'm-1', organizationId: ORG, pricingOverride: null, status: 'draft', endpointRef: null, metadata: null }),
    ]);
    budgets = fakeRepo<any>(() => ({}), [{ id: 'b-1', organizationId: ORG, active: true, limitCents: 1 }]);
    const versions = fakeRepo<any>(() => ({}), [VERSION]);
    audit = fakeAudit();
    const queue = fakeQueue();
    service = new ModelDeploymentsService(deployments as any, versions as any, fakeRepo<any>(() => ({})) as any, queue as any, registry, fakeEnvelope as any, audit as any, fakeRegistry() as any);
    processor = new ModelDeploymentsProcessor(queue as any, deployments as any, versions as any, models as any, budgets as any, registry, service, { emit: jest.fn(async () => undefined) } as any);
    id = (await service.create(ORG, 'owner-1', { modelVersionId: VERSION.id, providerType: adapter.key, modelId: 'm-1', budgetId: 'b-1' })).id;
    await processor.reconcile(id); // deploy
    await processor.reconcile(id); // reaches ready and fills the card
  });

  it('converges on a scale to zero instead of spinning in `scaling` forever', async () => {
    expect(store.get(id).state).toBe('ready');
    expect(models.get('m-1').status).toBe('active');

    await service.scale(ORG, id, 0, 'owner-1');

    // Tick 1: the loop asks the adapter to scale and moves to `scaling`.
    const scaling = (await processor.reconcile(id))!;
    expect(scaling.state).toBe('scaling');
    expect(adapter.scaleCalls).toEqual([0]);
    // The ref the adapter wrote to has to be on the row, or the next read
    // sees the old ceiling and the loop never ends.
    expect(store.get(id).externalRef).toMatchObject({ maxContainers: 0 });

    // Tick 2: the endpoint reads back as stopped, so the deployment settles
    // and the card stops being routable.
    const settled = (await processor.reconcile(id))!;
    expect(settled.state).toBe('ready');
    expect(settled.actual).toMatchObject({ state: 'stopped', replicas: 0 });
    expect(adapter.scaleCalls).toEqual([0]);
    expect(models.get('m-1').status).toBe('inactive');

    // Tick 3: nothing left to do. Before the fix every tick from here on
    // scaled again, returned early, and left the card active.
    await processor.reconcile(id);
    expect(adapter.scaleCalls).toEqual([0]);
    expect(store.get(id).state).toBe('ready');
  });

  it('keeps the budget cap honest: the stop it audits actually stops the endpoint', async () => {
    // limitCents is 1 and the fake charges nothing, so drive the cap by
    // hand through the same path the processor uses.
    budgets.get('b-1').limitCents = 0;
    await processor.reconcile(id);
    expect(audit.rows.some((r) => r.action === AuditAction.MODEL_DEPLOYMENT_BUDGET_STOP)).toBe(true);
    expect(store.get(id).desired.replicas).toBe(0);
    // The scale-to-zero the audit row claims must be on the row too.
    expect(store.get(id).externalRef).toMatchObject({ maxContainers: 0 });

    await processor.reconcile(id);
    expect((await adapter.readEndpoint(store.get(id).externalRef!, {})).replicas).toBe(0);
    expect(models.get('m-1').status).toBe('inactive');
  });
});

/**
 * Source-reading guard. The behaviour above passes against any
 * implementation that happens to persist the ref; this asserts the call
 * site, because an unwired control is exactly what a behavioural test
 * cannot see.
 */
describe('guard: the processor writes externalRef back after every adapter.scale', () => {
  const source = readFileSync(join(__dirname, '..', '..', 'model-deployments.processor.ts'), 'utf8');

  it('persists the ref in the replica-diff branch', () => {
    const branch = source.slice(source.indexOf('const wantReplicas'), source.indexOf('const next: ModelDeploymentState'));
    expect(branch).toContain('adapter.scale(');
    expect(branch).toMatch(/writeObserved\(d, \{[^}]*externalRef: d\.externalRef/);
  });

  it('persists the ref when the budget cap scales to zero', () => {
    const branch = source.slice(source.indexOf('private async chargeBudget'));
    expect(branch).toContain('adapter.scale(d.externalRef, 0, creds)');
    expect(branch).toMatch(/writeObserved\(d, \{[^}]*externalRef: d\.externalRef/);
  });
});

/**
 * Source-reading guard for the failed-row sweep: the ref-less filter has
 * to be in the query, not applied to the rows the query already took.
 * Filtering after the fact starved the window — a ref-less row is never
 * reconciled, so its lastReconcileAt never moves and it sits at the head
 * of the ASC order for good.
 */
describe('guard: the failed-row sweep filters in SQL', () => {
  const source = readFileSync(join(__dirname, '..', '..', 'model-deployments.processor.ts'), 'utf8');
  const sweep = source.slice(source.indexOf('async handleSweep'), source.indexOf('@Process(MODEL_RECONCILE_JOB)'));

  it('names externalRef in the where clause', () => {
    expect(sweep).toMatch(/state: 'failed'[^}]*externalRef: Not\(IsNull\(\)\)/);
  });

  it('does not filter the taken rows in JavaScript', () => {
    expect(sweep).not.toContain('.filter((d) => Boolean(d.externalRef))');
  });
});

describe('the failed-row sweep asks the database for rows that still have an endpoint', () => {
  it('passes externalRef: Not(IsNull()) to find', async () => {
    const deployments = { find: jest.fn(async () => []) };
    const processor = new ModelDeploymentsProcessor(
      fakeQueue() as any,
      deployments as any,
      {} as any,
      {} as any,
      {} as any,
      new AdapterRegistry(),
      {} as any,
      undefined as any,
    );
    await processor.handleSweep();
    const failedQuery = (deployments.find.mock.calls as any[])[1][0];
    expect(failedQuery.where.state).toBe('failed');
    expect(failedQuery.where.externalRef).toBeDefined();
    // TypeORM's Not(IsNull()) operator, not a plain value.
    expect(failedQuery.where.externalRef._type).toBe('not');
  });
});
