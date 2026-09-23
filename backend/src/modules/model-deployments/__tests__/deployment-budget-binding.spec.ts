import { readFileSync } from 'fs';
import { join } from 'path';
import { NotFoundException } from '@nestjs/common';

import { Model } from '../../../entities/model.entity';
import { ModelDeployment } from '../../../entities/model-deployment.entity';
import { SpendBudget } from '../../../entities/spend-budget.entity';
import { AdapterRegistry } from '../adapters/adapter.registry';
import { StubAdapter } from '../adapters/stub.adapter';
import { ModelDeploymentsService } from '../model-deployments.service';
import { ensureTestKey, fakeAudit, fakeEnvelope, fakeQueue, fakeRegistry, fakeRepo, newDeployment } from './gates/fakes';

/**
 * A budgetId that does not resolve for this organization means the
 * deployment has no spend ceiling at all: `chargeBudget` looks the budget
 * up scoped to the deployment's own org, finds nothing and returns, with
 * no log, no audit row and no alert, while the UI still shows a budget
 * attached. `modelVersionId`, `modelId` and the version are all checked at
 * create two lines away; this field was not.
 */
const ORG = 'org-budget-check';
const VERSION = { id: 'v-1', organizationId: ORG, name: 'qwen3-0.6b', base: 'qwen3-0.6b', registryUri: 's3://registry/models/qwen3-0.6b@1', quantizations: [], manifestSha: 'sha' };

describe('POST /model-deployments refuses a budget it cannot resolve', () => {
  let service: ModelDeploymentsService;
  let budgets: ReturnType<typeof fakeRepo<any>>;

  beforeEach(() => {
    ensureTestKey();
    const registry = new AdapterRegistry();
    registry.register(new StubAdapter({ architectures: 'any' }));
    budgets = fakeRepo<any>(() => new SpendBudget(), [
      { id: 'mine', organizationId: ORG, active: true, limitCents: 500 },
      { id: 'theirs', organizationId: 'some-other-org', active: true, limitCents: 500 },
    ] as any);
    const models = fakeRepo<Model>(() => new Model(), [Object.assign(new Model(), { id: 'm-1', organizationId: ORG })]);
    service = new ModelDeploymentsService(
      fakeRepo<ModelDeployment>(newDeployment) as any,
      fakeRepo<any>(() => ({}), [VERSION]) as any,
      fakeRepo<any>(() => ({})) as any,
      fakeQueue() as any,
      registry,
      fakeEnvelope as any,
      fakeAudit() as any,
      fakeRegistry() as any,
      undefined,
      models as any,
      budgets as any,
    );
  });

  const create = (budgetId: string) =>
    service.create(ORG, 'user-1', { modelVersionId: VERSION.id, providerType: 'stub', providerConfig: { token: 'valid' }, budgetId });

  it('accepts a budget of its own organization', async () => {
    const d = await create('mine');
    expect(d.budgetId).toBe('mine');
  });

  it('refuses a budget belonging to another organization', async () => {
    await expect(create('theirs')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a budget id that does not exist', async () => {
    await expect(create('00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(NotFoundException);
  });
});

/**
 * Source-reading guard: the check has to be wired to a repository the
 * module actually provides, or it is an `if (undefined)` that never runs.
 */
describe('guard: the budget check is wired', () => {
  it('the service reads the budget scoped to the organization', () => {
    const source = readFileSync(join(__dirname, '..', 'model-deployments.service.ts'), 'utf8');
    const create = source.slice(source.indexOf('async create('), source.indexOf('async scale('));
    expect(create).toMatch(/this\.budgets\.findOne\(\{ where: \{ id: dto\.budgetId, organizationId \} \}\)/);
    expect(source).toMatch(/@InjectRepository\(SpendBudget\)[\s\S]{0,80}budgets\?: Repository<SpendBudget>/);
  });

  it('the module registers SpendBudget so the repository is injectable', () => {
    const module = readFileSync(join(__dirname, '..', 'model-deployments.module.ts'), 'utf8');
    expect(module).toMatch(/TypeOrmModule\.forFeature\(\[[^\]]*SpendBudget/);
  });
});
