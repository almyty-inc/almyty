import { readFileSync } from 'fs';
import { join } from 'path';

import { ModelDeployment } from '../../../entities/model-deployment.entity';
import { Model } from '../../../entities/model.entity';
import { AuditAction } from '../../../entities/audit-log.entity';
import { AdapterRegistry } from '../adapters/adapter.registry';
import { StubAdapter } from '../adapters/stub.adapter';
import { ModelDeploymentsService } from '../model-deployments.service';
import { ModelDeploymentsProcessor } from '../model-deployments.processor';
import { defaultCardName, defaultVendorModelId, readModelSource } from '../model-source';
import { HfRevisionResolver, HubFetch } from '../../model-registry/hf-revision.resolver';

/**
 * A model hosted from the UI names no catalog card, and the reconcile loop
 * fills only the card on `deployment.modelId`. Before this, such a
 * deployment reached ready and nothing could ever call it. Now create()
 * makes the card in the same request, linked both ways.
 */

const SHA = '0123456789abcdef0123456789abcdef01234567';

function memRepo<T extends { id?: string }>(make: () => T, seed: T[] = []) {
  const rows: T[] = [...seed];
  const matches = (row: any, where: any) => Object.entries(where).every(([k, v]) => row[k] === v);
  let n = 0;
  return {
    rows,
    create: jest.fn((partial: any) => Object.assign(make(), partial)),
    save: jest.fn(async (row: any) => {
      if (!row.id) row.id = `card-${++n}`;
      const i = rows.findIndex((r) => r.id === row.id);
      if (i >= 0) rows[i] = row;
      else rows.push(row);
      return row;
    }),
    findOne: jest.fn(async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null),
    find: jest.fn(async ({ where }: any = {}) => rows.filter((r) => !where || matches(r, where))),
    delete: jest.fn(async (where: any) => {
      const i = rows.findIndex((r) => matches(r, where));
      if (i >= 0) rows.splice(i, 1);
      return { affected: i >= 0 ? 1 : 0 };
    }),
  };
}

describe('a deployment with no card makes its own', () => {
  let deployments: ReturnType<typeof memRepo<ModelDeployment>>;
  let models: ReturnType<typeof memRepo<Model>>;
  let versions: any;
  let credentials: any;
  let queue: any;
  let registry: AdapterRegistry;
  let audit: { log: jest.Mock };
  let hubFetch: jest.Mock;
  let credentialRefs: { resolve: jest.Mock };
  let service: ModelDeploymentsService;
  const envelope = { warmOrg: jest.fn(async () => undefined), encryptForOrg: jest.fn(async (_o: string, v: string) => `encrypted:kms:${v}`) } as any;

  const build = (withResolver = true) =>
    new ModelDeploymentsService(
      deployments as any, versions, credentials, queue, registry, envelope, audit as any,
      undefined, credentialRefs as any, models as any, undefined,
      withResolver ? new HfRevisionResolver(hubFetch as unknown as HubFetch) : undefined,
    );

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'unit-test-key-32-bytes-minimum-len';
    delete process.env.HF_TOKEN;
    deployments = memRepo<ModelDeployment>(() => new ModelDeployment());
    models = memRepo<Model>(() => new Model());
    versions = { findOne: jest.fn(async () => ({ id: 'v-1', organizationId: 'org-1', name: 'qwen-tuned', base: 'qwen3-0.6b', registryUri: 's3://r/q@1' })) };
    credentials = { findOne: jest.fn(async () => null) };
    queue = { add: jest.fn(async () => undefined) };
    registry = new AdapterRegistry();
    registry.register(new StubAdapter({ architectures: 'any' }));
    audit = { log: jest.fn(async () => null) };
    hubFetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ sha: SHA }) }));
    credentialRefs = { resolve: jest.fn() };
    service = build();
  });

  it('creates a deploying card, linked both ways, when no modelId is given', async () => {
    const d = await service.create('org-1', 'u-1', {
      model: `hf://meta-llama/Llama-3.1-8B-Instruct@${SHA}`,
      providerType: 'stub',
      providerConfig: { token: 'valid' },
      desired: { region: 'eu', privacyTier: 'local' } as any,
    });
    expect(models.rows).toHaveLength(1);
    const card = models.rows[0];
    expect(d.modelId).toBe(card.id);
    expect(card.endpointRef).toEqual({ deploymentId: d.id, providerType: 'stub' });
    expect(card).toMatchObject({
      organizationId: 'org-1',
      name: 'Llama-3.1-8B-Instruct',
      vendorModelId: 'meta-llama/Llama-3.1-8B-Instruct',
      providerId: null,
      providerType: null,
      status: 'deploying',
      validationStatus: 'never',
      privacyTier: 'local',
      region: 'eu',
      modelVersionId: null,
      pricingSource: 'unpriced',
    });
    expect(card.metadata).toEqual({
      source: `hf://meta-llama/Llama-3.1-8B-Instruct@${SHA}`,
      modelRef: `hf://meta-llama/Llama-3.1-8B-Instruct@${SHA}`,
      revision: SHA,
    });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.MODEL_REGISTERED, resourceId: card.id }));
    expect(queue.add).toHaveBeenCalledWith('reconcile', { deploymentId: d.id }, expect.anything());
  });

  it('is not selectable, and so never a routing candidate, while it is deploying', async () => {
    await service.create('org-1', 'u-1', { model: `hf://Qwen/Qwen3-0.6B@${SHA}`, providerType: 'stub', providerConfig: { token: 'valid' } });
    const card = models.rows[0];
    expect(card.isSelectable()).toBe(false);
    // Even a card someone validated by hand stays out while deploying.
    card.validationStatus = 'passed';
    expect(card.isSelectable()).toBe(false);
  });

  it('fills no new card when an existing modelId is given', async () => {
    const existing = Object.assign(new Model(), { id: 'm-1', organizationId: 'org-1', name: 'mine' });
    models.rows.push(existing);
    const d = await service.create('org-1', 'u-1', { model: `hf://Qwen/Qwen3-0.6B@${SHA}`, providerType: 'stub', providerConfig: { token: 'valid' }, modelId: 'm-1' });
    expect(d.modelId).toBe('m-1');
    expect(models.rows).toHaveLength(1);
    expect(models.save).not.toHaveBeenCalled();
  });

  it('takes an explicit name and vendorModelId, and uses defaults from the reference otherwise', async () => {
    await service.create('org-1', 'u-1', {
      model: `hf://Qwen/Qwen3-0.6B@${SHA}`, providerType: 'stub', providerConfig: { token: 'valid' },
      name: 'Support bot model', vendorModelId: 'qwen-small',
    });
    expect(models.rows[0]).toMatchObject({ name: 'Support bot model', vendorModelId: 'qwen-small' });

    // A registered version names its card after the version.
    await service.create('org-1', 'u-1', { modelVersionId: 'v-1', providerType: 'stub', providerConfig: { token: 'valid' } });
    expect(models.rows[1]).toMatchObject({ name: 'qwen-tuned', vendorModelId: 'q', modelVersionId: 'v-1', base: 'qwen3-0.6b' });
    expect(models.rows[1].metadata).toEqual({ source: 's3://r/q@1', modelRef: 's3://r/q@1' });
  });

  it('suffixes a default name that is taken, and refuses an explicit one that is', async () => {
    models.rows.push(Object.assign(new Model(), { id: 'm-x', organizationId: 'org-1', name: 'Qwen3-0.6B' }));
    await service.create('org-1', 'u-1', { model: `hf://Qwen/Qwen3-0.6B@${SHA}`, providerType: 'stub', providerConfig: { token: 'valid' } });
    expect(models.rows[1].name).toBe('Qwen3-0.6B-2');

    const before = deployments.rows.length;
    await expect(
      service.create('org-1', 'u-1', { model: `hf://Qwen/Qwen3-0.6B@${SHA}`, providerType: 'stub', providerConfig: { token: 'valid' }, name: 'Qwen3-0.6B' }),
    ).rejects.toMatchObject({ response: { code: 'MODEL_EXISTS' } });
    expect(deployments.rows.length).toBe(before);
  });

  it('removes the card again when the deployment does not save, so no half-linked pair is left', async () => {
    deployments.save.mockRejectedValueOnce(new Error('db down'));
    await expect(
      service.create('org-1', 'u-1', { model: `hf://Qwen/Qwen3-0.6B@${SHA}`, providerType: 'stub', providerConfig: { token: 'valid' } }),
    ).rejects.toThrow('db down');
    expect(models.rows).toHaveLength(0);
    expect(models.delete).toHaveBeenCalled();
  });

  it('the reconcile loop fills that card at ready and retires it, kept, at teardown', async () => {
    const d = await service.create('org-1', 'u-1', { model: `hf://Qwen/Qwen3-0.6B@${SHA}`, providerType: 'stub', providerConfig: { token: 'valid', simulate: 'none' } });
    const row = deployments.rows[0];
    // The KMS unwrap hook is not loaded here; the loop reads a plain config.
    row.providerConfig = { token: 'valid', simulate: 'none' };
    (deployments as any).update = jest.fn(async (_c: any, patch: Record<string, any>) => { Object.assign(row, patch); return { affected: 1 }; });
    (deployments as any).createQueryBuilder = jest.fn(() => {
      const qb: any = { update: () => qb, set: (v: any) => { Object.assign(row, v); return qb; }, where: () => qb, andWhere: () => qb, execute: async () => ({ affected: 1 }) };
      return qb;
    });
    const processor = new ModelDeploymentsProcessor(
      { getRepeatableJobs: jest.fn(), add: jest.fn() } as any, deployments as any, versions, models as any,
      { findOne: jest.fn(async () => null) } as any, registry, { credentialsFor: jest.fn(async () => ({ token: 'valid' })), audit: jest.fn() } as any,
      { emit: jest.fn(async () => undefined) } as any,
    );

    await processor.reconcile(d.id);
    const card = models.rows[0];
    expect(row.lastError ?? null).toBeNull();
    expect(row.state).toBe('ready');
    expect(card.status).toBe('active');
    expect(card.endpointRef).toMatchObject({ deploymentId: d.id, providerType: 'stub', url: expect.any(String) });
    // Active and callable, but not selectable until a validation run passes.
    expect(card.isSelectable()).toBe(false);

    await service.teardown('org-1', d.id, 'u-1');
    await processor.reconcile(d.id);
    expect(models.rows).toHaveLength(1);
    expect(card.status).toBe('inactive');
    expect(card.endpointRef).toBeNull();
    expect(card.metadata).toMatchObject({ unroutableReason: expect.any(String), source: `hf://Qwen/Qwen3-0.6B@${SHA}` });
  });

  it('the module wires the resolver the service pins with, so pinning is not dead code', () => {
    const svc = readFileSync(join(__dirname, '..', 'model-deployments.service.ts'), 'utf-8');
    expect(svc).toMatch(/private readonly hubRevisions\?: HfRevisionResolver/);
    const registryModule = readFileSync(join(__dirname, '..', '..', 'model-registry', 'model-registry.module.ts'), 'utf-8');
    expect(registryModule).toMatch(/providers: \[[^\]]*HfRevisionResolver/);
    expect(registryModule).toMatch(/exports: \[[^\]]*HfRevisionResolver/);
    const deploymentsModule = readFileSync(join(__dirname, '..', 'model-deployments.module.ts'), 'utf-8');
    expect(deploymentsModule).toMatch(/imports: \[[\s\S]*ModelRegistryModule/);
  });
});

describe('a Hugging Face source is pinned to its commit at create', () => {
  let deployments: ReturnType<typeof memRepo<ModelDeployment>>;
  let models: ReturnType<typeof memRepo<Model>>;
  let hubFetch: jest.Mock;
  let credentialRefs: { resolve: jest.Mock };
  let service: ModelDeploymentsService;
  const envelope = { warmOrg: jest.fn(async () => undefined), encryptForOrg: jest.fn(async (_o: string, v: string) => `encrypted:kms:${v}`) } as any;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'unit-test-key-32-bytes-minimum-len';
    delete process.env.HF_TOKEN;
    deployments = memRepo<ModelDeployment>(() => new ModelDeployment());
    models = memRepo<Model>(() => new Model());
    const registry = new AdapterRegistry();
    registry.register(new StubAdapter({ architectures: 'any' }));
    hubFetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ sha: SHA }) }));
    credentialRefs = { resolve: jest.fn() };
    service = new ModelDeploymentsService(
      deployments as any, { findOne: jest.fn() } as any, { findOne: jest.fn(async () => null) } as any, { add: jest.fn() } as any, registry, envelope,
      { log: jest.fn(async () => null) } as any, undefined, credentialRefs as any, models as any, undefined,
      new HfRevisionResolver(hubFetch as unknown as HubFetch),
    );
  });

  it('resolves an unpinned repository against main and stores the pinned reference', async () => {
    const d = await service.create('org-1', 'u-1', { model: 'hf://meta-llama/Llama-3.1-8B-Instruct', providerType: 'stub', providerConfig: { token: 'valid' } });
    expect(hubFetch).toHaveBeenCalledWith('https://huggingface.co/api/models/meta-llama/Llama-3.1-8B-Instruct/revision/main', expect.objectContaining({ headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' } }));
    expect(d.modelRef).toBe(`hf://meta-llama/Llama-3.1-8B-Instruct@${SHA}`);
    expect(models.rows[0].metadata).toEqual({
      source: 'hf://meta-llama/Llama-3.1-8B-Instruct',
      modelRef: `hf://meta-llama/Llama-3.1-8B-Instruct@${SHA}`,
      revision: SHA,
    });
  });

  it('resolves a branch or tag to its commit', async () => {
    const d = await service.create('org-1', 'u-1', { model: 'hf://Qwen/Qwen3-0.6B@v1.0', providerType: 'stub', providerConfig: { token: 'valid' } });
    expect(hubFetch.mock.calls[0][0]).toBe('https://huggingface.co/api/models/Qwen/Qwen3-0.6B/revision/v1.0');
    expect(d.modelRef).toBe(`hf://Qwen/Qwen3-0.6B@${SHA}`);
    expect(models.rows[0].metadata?.source).toBe('hf://Qwen/Qwen3-0.6B@v1.0');
  });

  it('leaves a commit sha alone and makes no call', async () => {
    const d = await service.create('org-1', 'u-1', { model: `hf://Qwen/Qwen3-0.6B@${SHA}`, providerType: 'stub', providerConfig: { token: 'valid' } });
    expect(hubFetch).not.toHaveBeenCalled();
    expect(d.modelRef).toBe(`hf://Qwen/Qwen3-0.6B@${SHA}`);
  });

  it('never tries to pin s3://, gs://, file:// or a provider reference', async () => {
    await service.create('org-1', 'u-1', { model: 's3://bucket/qwen@etag', providerType: 'stub', providerConfig: { token: 'valid' } });
    expect(hubFetch).not.toHaveBeenCalled();
  });

  it('refuses a repository the Hub does not know with MODEL_SOURCE_UNRESOLVED, saving nothing', async () => {
    hubFetch.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ error: 'Repository not found' }) });
    await expect(
      service.create('org-1', 'u-1', { model: 'hf://nobody/nothing', providerType: 'stub', providerConfig: { token: 'valid' } }),
    ).rejects.toMatchObject({ response: { code: 'MODEL_SOURCE_UNRESOLVED', message: expect.stringContaining('Could not find nobody/nothing on Hugging Face') } });
    hubFetch.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND huggingface.co'));
    await expect(
      service.create('org-1', 'u-1', { model: 'hf://nobody/nothing', providerType: 'stub', providerConfig: { token: 'valid' } }),
    ).rejects.toMatchObject({ response: { code: 'MODEL_SOURCE_UNRESOLVED', message: expect.stringContaining('ENOTFOUND') } });
    expect(deployments.rows).toHaveLength(0);
    expect(models.rows).toHaveLength(0);
  });

  it('sends the connected Hugging Face token, so a private repository resolves', async () => {
    credentialRefs.resolve.mockResolvedValue({ credential: { connectorKey: 'registry-huggingface' }, config: { apiKey: 'hf_connected' } });
    await service.create('org-1', 'u-1', { model: 'hf://acme/private-model', providerType: 'stub', providerConfig: {}, credentialId: '11111111-1111-1111-1111-111111111111' });
    expect(credentialRefs.resolve).toHaveBeenCalledWith('org-1', '11111111-1111-1111-1111-111111111111', expect.objectContaining({ principal: { id: 'u-1' } }));
    expect(hubFetch.mock.calls[0][1].headers).toEqual({ Accept: 'application/json', 'Accept-Encoding': 'identity', Authorization: 'Bearer hf_connected' });
  });

  it('prefers a hubToken, falls back to HF_TOKEN, and never sends another provider\'s key to the Hub', async () => {
    credentialRefs.resolve.mockResolvedValueOnce({ credential: { connectorKey: 'modal' }, config: { apiKey: 'modal-secret', hubToken: 'hf_hub' } });
    await service.create('org-1', 'u-1', { model: 'hf://acme/a', providerType: 'stub', providerConfig: {}, credentialId: '11111111-1111-1111-1111-111111111111' });
    expect(hubFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer hf_hub');

    credentialRefs.resolve.mockResolvedValueOnce({ credential: { connectorKey: 'modal' }, config: { apiKey: 'modal-secret' } });
    process.env.HF_TOKEN = 'hf_env';
    await service.create('org-1', 'u-1', { model: 'hf://acme/b', providerType: 'stub', providerConfig: {}, credentialId: '11111111-1111-1111-1111-111111111111' });
    expect(hubFetch.mock.calls[1][1].headers.Authorization).toBe('Bearer hf_env');
    delete process.env.HF_TOKEN;

    credentialRefs.resolve.mockResolvedValueOnce({ credential: { connectorKey: 'modal' }, config: { apiKey: 'modal-secret' } });
    await service.create('org-1', 'u-1', { model: 'hf://acme/c', providerType: 'stub', providerConfig: {}, credentialId: '11111111-1111-1111-1111-111111111111' });
    expect(hubFetch.mock.calls[2][1].headers.Authorization).toBeUndefined();
  });
});

describe('card defaults from the reference', () => {
  const both = (ref: string) => {
    const source = readModelSource(ref);
    return { name: defaultCardName(source), vendorModelId: defaultVendorModelId(source) };
  };

  it('uses the repository for hf://, the platform id for a provider reference, the directory for storage', () => {
    expect(both(`hf://meta-llama/Llama-3.1-8B-Instruct@${SHA}`)).toEqual({ name: 'Llama-3.1-8B-Instruct', vendorModelId: 'meta-llama/Llama-3.1-8B-Instruct' });
    expect(both('together://acme/qwen3-tuned')).toEqual({ name: 'qwen3-tuned', vendorModelId: 'acme/qwen3-tuned' });
    expect(both('fireworks://accounts/acme/models/llama-ft')).toEqual({ name: 'llama-ft', vendorModelId: 'accounts/acme/models/llama-ft' });
    expect(both('s3://weights/org/qwen-7b@etag1')).toEqual({ name: 'qwen-7b', vendorModelId: 'qwen-7b' });
    expect(both('gs://weights@17')).toEqual({ name: 'weights', vendorModelId: 'weights' });
    expect(both('file:///srv/models/mistral-7b@abc')).toEqual({ name: 'mistral-7b', vendorModelId: 'mistral-7b' });
  });
});
