import { BadRequestException, NotFoundException } from '@nestjs/common';

import { ModelDeployment } from '../../../entities/model-deployment.entity';
import { AdapterRegistry } from '../adapters/adapter.registry';
import { StubAdapter } from '../adapters/stub.adapter';
import { ModelDeploymentsService, validateAgainstSchema } from '../model-deployments.service';

describe('validateAgainstSchema', () => {
  const schema = { type: 'object', properties: { token: { type: 'string' }, replicas: { type: 'integer' }, mode: { type: 'string', enum: ['a', 'b'] } }, required: ['token'] };

  it('reports missing required keys, wrong types and bad enum values together', () => {
    expect(validateAgainstSchema({ replicas: 'two', mode: 'z' }, schema)).toEqual(['token is required', 'replicas must be a number', 'mode must be one of a, b']);
    expect(validateAgainstSchema({ token: 't', replicas: 2, mode: 'a', extra: 1 }, schema)).toEqual([]);
  });
});

describe('ModelDeploymentsService', () => {
  let deployments: any;
  let versions: any;
  let credentials: any;
  let queue: any;
  let registry: AdapterRegistry;
  let service: ModelDeploymentsService;
  const envelope = { warmOrg: jest.fn(async () => undefined), encryptForOrg: jest.fn(async (_o: string, v: string) => `encrypted:kms:${v}`) } as any;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'unit-test-key-32-bytes-minimum-len';
    deployments = {
      create: jest.fn((row: any) => Object.assign(new ModelDeployment(), row)),
      save: jest.fn(async (row: any) => Object.assign(row, { id: row.id ?? 'd-1' })),
      findOne: jest.fn(async () => null),
      find: jest.fn(async () => []),
    };
    versions = { findOne: jest.fn(async () => ({ id: 'v-1', organizationId: 'org-1', name: 'qwen', base: 'qwen3-0.6b', registryUri: 's3://r/q@1', quantizations: [], manifestSha: 'x' })) };
    credentials = { findOne: jest.fn(async () => null) };
    queue = { add: jest.fn(async () => undefined) };
    registry = new AdapterRegistry();
    registry.register(new StubAdapter({ architectures: ['qwen3'] }));
    service = new ModelDeploymentsService(deployments, versions, credentials, queue, registry, envelope, { log: jest.fn(async () => null) } as any);
  });

  it('refuses an unknown adapter, a missing version, an unsupported architecture, a bad region and a bad config before saving anything', async () => {
    await expect(service.create('org-1', 'u', { modelVersionId: 'v-1', providerType: 'nope' })).rejects.toBeInstanceOf(BadRequestException);
    versions.findOne.mockResolvedValueOnce(null);
    await expect(service.create('org-1', 'u', { modelVersionId: 'v-x', providerType: 'stub', providerConfig: { token: 'valid' } })).rejects.toBeInstanceOf(NotFoundException);
    versions.findOne.mockResolvedValueOnce({ id: 'v-2', organizationId: 'org-1', base: 'mamba-2.8b', registryUri: 's3://r/m@1', quantizations: [], name: 'm', manifestSha: 'x' });
    await expect(service.create('org-1', 'u', { modelVersionId: 'v-2', providerType: 'stub', providerConfig: { token: 'valid' } })).rejects.toMatchObject({ response: { code: 'ADAPTER_UNSUPPORTED_ARCHITECTURE' } });
    await expect(service.create('org-1', 'u', { modelVersionId: 'v-1', providerType: 'stub', providerConfig: { token: 'valid' }, desired: { region: 'mars' } })).rejects.toMatchObject({ response: { code: 'ADAPTER_REGION_UNAVAILABLE' } });
    await expect(service.create('org-1', 'u', { modelVersionId: 'v-1', providerType: 'stub', providerConfig: {} })).rejects.toMatchObject({ response: { code: 'PROVIDER_CONFIG_INVALID' } });
    expect(deployments.save).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('saves desired state with secrets encrypted, defaults scale-to-zero, and enqueues a reconcile', async () => {
    const d = await service.create('org-1', 'u-1', { modelVersionId: 'v-1', providerType: 'stub', providerConfig: { token: 'valid', image: 'x' }, budgetId: null });
    expect(d.state).toBe('pending');
    expect(d.desired).toEqual({ replicas: 1, minScale: 0, maxScale: 1 });
    expect(d.providerConfig.token).toMatch(/^encrypted:/);
    expect(d.providerConfig.image).toBe('x');
    expect(d.createdBy).toBe('u-1');
    expect(queue.add).toHaveBeenCalledWith('reconcile', { deploymentId: 'd-1' }, expect.objectContaining({ removeOnComplete: true }));
  });

  it('teardown only flips state and enqueues; it never calls the adapter itself', async () => {
    const existing = Object.assign(new ModelDeployment(), { id: 'd-9', organizationId: 'org-1', state: 'ready', providerType: 'stub', modelVersionId: 'v-1', providerConfig: {} });
    deployments.findOne.mockResolvedValue(existing);
    const teardownSpy = jest.spyOn(registry.require('stub'), 'teardown');
    const d = await service.teardown('org-1', 'd-9', 'u-1');
    expect(d.state).toBe('tearing_down');
    expect(teardownSpy).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalled();
  });

  it('resolves adapter credentials from the vault entry plus inline secrets, decrypted', async () => {
    credentials.findOne.mockResolvedValue({ getDecryptedConfig: () => ({ token: 'from-vault', region: 'eu' }) });
    const d = Object.assign(new ModelDeployment(), { organizationId: 'org-1', providerConfig: { credentialId: 'c-1', hfApiKey: 'hf_plain', image: 'x' } });
    d.encryptSensitiveData();
    const creds = await service.credentialsFor(d);
    expect(creds).toEqual({ token: 'from-vault', region: 'eu', hfApiKey: 'hf_plain' });
    expect(credentials.findOne).toHaveBeenCalledWith({ where: { id: 'c-1', organizationId: 'org-1' } });
  });

  it('with the credential store wired, the vault entry resolves through it and a refused row refuses the deploy', async () => {
    const credentialRefs = {
      resolve: jest.fn().mockResolvedValue({ config: { token: 'from-store', region: 'eu' } }),
    };
    const withRefs = new ModelDeploymentsService(deployments, versions, credentials, queue, registry, envelope, { log: jest.fn(async () => null) } as any, undefined, credentialRefs as any);
    const d = Object.assign(new ModelDeployment(), { id: 'dep-1', organizationId: 'org-1', providerConfig: { credentialId: 'c-1', image: 'x' } });
    d.encryptSensitiveData();
    expect(await withRefs.credentialsFor(d)).toEqual({ token: 'from-store', region: 'eu' });
    expect(credentialRefs.resolve).toHaveBeenCalledWith('org-1', 'c-1', { context: { purpose: 'deploy', resourceType: 'model_deployment', resourceId: 'dep-1' } });
    expect(credentials.findOne).not.toHaveBeenCalled();

    credentialRefs.resolve.mockRejectedValueOnce(Object.assign(new Error('inactive'), { code: 'CREDENTIAL_INACTIVE' }));
    await expect(withRefs.credentialsFor(d)).rejects.toMatchObject({ code: 'CREDENTIAL_INACTIVE' });
  });
});
