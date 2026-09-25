import { Model } from '../../../entities/model.entity';
import { ModelDeployment } from '../../../entities/model-deployment.entity';
import { AdapterRegistry } from '../adapters/adapter.registry';
import { StubAdapter } from '../adapters/stub.adapter';
import { AUTO_VALIDATION_SOURCE, ModelDeploymentsProcessor } from '../model-deployments.processor';
import { ModelDeploymentsService } from '../model-deployments.service';
import { ensureTestKey, fakeAudit, fakeEnvelope, fakeQueue, fakeRegistry, fakeRepo, newDeployment } from './gates/fakes';

/**
 * A hosted model's card is selectable only after one validation run
 * passes. The reconcile tick that moves a deployment into ready runs it,
 * once per move, and nothing about the run can break the tick.
 */
const ORG = 'org-autoval';
const VERSION = { id: 'v-1', organizationId: ORG, name: 'qwen3-0.6b', base: 'qwen3-0.6b', registryUri: 's3://registry/models/qwen3-0.6b@1', quantizations: [], manifestSha: 'sha' };

describe('a hosted model is validated when it becomes ready', () => {
  let deployments: ReturnType<typeof fakeRepo<ModelDeployment>>;
  let models: ReturnType<typeof fakeRepo<Model>>;
  let catalog: { validate: jest.Mock };
  let processor: ModelDeploymentsProcessor;
  let id: string;

  async function setUp(card: Partial<Model> = {}, withCatalog = true) {
    ensureTestKey();
    const registry = new AdapterRegistry();
    registry.register(new StubAdapter({ architectures: 'any', centsPerHour: 100 }));
    deployments = fakeRepo<ModelDeployment>(newDeployment);
    models = fakeRepo<Model>(() => new Model(), [Object.assign(new Model(), { id: 'm-1', organizationId: ORG, pricingOverride: null, status: 'draft', endpointRef: null, validationStatus: 'pending', ...card })]);
    const versions = fakeRepo<any>(() => ({}), [VERSION]);
    const queue = fakeQueue();
    catalog = { validate: jest.fn(async () => ({ passed: true })) };
    const moduleRef = withCatalog ? { get: jest.fn(() => catalog) } : undefined;
    const service = new ModelDeploymentsService(deployments as any, versions as any, fakeRepo<any>(() => ({})) as any, queue as any, registry, fakeEnvelope as any, fakeAudit() as any, fakeRegistry() as any);
    processor = new ModelDeploymentsProcessor(queue as any, deployments as any, versions as any, models as any, fakeRepo<any>(() => ({})) as any, registry, service, undefined, undefined, moduleRef as any);
    id = (await service.create(ORG, 'owner-1', { modelVersionId: VERSION.id, providerType: 'stub', providerConfig: { token: 'valid' }, modelId: 'm-1' })).id;
  }

  it('runs the validation once, on the tick that made it ready, and not on later ready ticks', async () => {
    await setUp();
    const first = (await processor.reconcile(id))!;
    expect(first.state).toBe('ready');
    expect(models.get('m-1').endpointRef).toMatchObject({ deploymentId: id });
    expect(catalog.validate).toHaveBeenCalledTimes(1);
    expect(catalog.validate).toHaveBeenCalledWith(ORG, 'm-1', undefined, AUTO_VALIDATION_SOURCE);

    await processor.reconcile(id);
    await processor.reconcile(id);
    expect(catalog.validate).toHaveBeenCalledTimes(1);
  });

  it('validates again when the row comes back to ready from another state', async () => {
    await setUp();
    await processor.reconcile(id);
    await deployments.update({ id }, { state: 'degraded' });
    await processor.reconcile(id);
    expect(catalog.validate).toHaveBeenCalledTimes(2);
  });

  it('runs it once when two ticks see the same row become ready at the same time', async () => {
    await setUp();
    await processor.reconcile(id);
    catalog.validate.mockClear();
    await deployments.update({ id }, { state: 'deploying' });
    const [a, b] = await Promise.all([processor.reconcile(id), processor.reconcile(id)]);
    expect(a!.state).toBe('ready');
    expect(b!.state).toBe('ready');
    expect(catalog.validate).toHaveBeenCalledTimes(1);
  });

  it('leaves a card that already passed alone', async () => {
    await setUp({ validationStatus: 'passed' });
    await processor.reconcile(id);
    expect(catalog.validate).not.toHaveBeenCalled();
  });

  it('keeps the tick whole when the validation throws', async () => {
    await setUp();
    catalog.validate.mockRejectedValue(new Error('endpoint refused the call'));
    const d = (await processor.reconcile(id))!;
    expect(d.state).toBe('ready');
    expect(deployments.get(id).state).toBe('ready');
    // The budget snapshot after the card fill still ran and was written.
    expect(deployments.get(id).actual).toMatchObject({ spentCents: 1 });
    expect(d.lastError ?? null).toBeNull();
  });

  it('reconciles as before when no catalog is available', async () => {
    await setUp({}, false);
    const d = (await processor.reconcile(id))!;
    expect(d.state).toBe('ready');
    expect(catalog.validate).not.toHaveBeenCalled();
  });
});
