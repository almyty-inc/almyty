import { BadRequestException, ConflictException } from '@nestjs/common';

import { ModelVersion } from '../../../entities/model-version.entity';
import { ModelVersionsService } from '../model-versions.service';

const manifest = {
  schemaVersion: 1 as const,
  base: 'qwen3-0.6b',
  tokenizer: 'hf://Qwen/Qwen3-0.6B@abc',
  license: 'Apache-2.0',
  created: '2026-09-08T09:00:00Z',
  files: [{ path: 'model.safetensors', sizeBytes: 1200 }, { path: 'tokenizer.json', sizeBytes: 34 }],
  quantizations: ['Q4_K_M'],
};

describe('ModelVersionsService', () => {
  let rows: ModelVersion[];
  let versions: any;
  let deployments: { count: jest.Mock };
  let registry: { describeVersion: jest.Mock };
  let audit: { log: jest.Mock };
  let svc: ModelVersionsService;

  beforeEach(() => {
    rows = [];
    versions = {
      create: jest.fn((p: any) => Object.assign(new ModelVersion(), p)),
      save: jest.fn(async (r: any) => { r.id = r.id ?? `v-${rows.length + 1}`; rows.push(r); return r; }),
      find: jest.fn(async () => rows),
      findOne: jest.fn(async ({ where }: any) => rows.find((r) => Object.entries(where).every(([k, v]) => (r as any)[k] === v)) ?? null),
      remove: jest.fn(async (r: any) => { rows.splice(rows.indexOf(r), 1); return r; }),
    };
    deployments = { count: jest.fn().mockResolvedValue(0) };
    registry = { describeVersion: jest.fn() };
    audit = { log: jest.fn().mockResolvedValue(null) };
    svc = new ModelVersionsService(versions, deployments as any, registry as any, audit as any);
  });

  it('registers an s3 version from its manifest: base, size, digest, quantizations, summary', async () => {
    registry.describeVersion.mockResolvedValue({ manifest, manifestSha: 'deadbeef', sizeBytes: 1234, parsed: { scheme: 's3' } });
    const v = await svc.register('org', { name: 'qwen tiny', registryUri: 's3://registry/models/qwen3@e3b0' }, 'u');
    expect(v).toMatchObject({ base: 'qwen3-0.6b', sizeBytes: '1234', manifestSha: 'deadbeef', quantizations: ['Q4_K_M'] });
    expect(v.metadata).toMatchObject({ scheme: 's3', manifest: { license: 'Apache-2.0', fileCount: 2, tokenizer: 'hf://Qwen/Qwen3-0.6B@abc' } });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ resourceId: 'v-1', userId: 'u', details: { registryUri: 's3://registry/models/qwen3@e3b0', hasManifest: true } }));
  });

  it('refuses an s3 version whose manifest cannot be read, and an unpinned or unknown URI', async () => {
    registry.describeVersion.mockRejectedValue(Object.assign(new Error('NoSuchKey'), { code: 'REGISTRY_NOT_FOUND' }));
    await expect(svc.register('org', { name: 'x', registryUri: 's3://registry/nothing@1' })).rejects.toMatchObject({ response: { code: 'REGISTRY_NOT_FOUND' } });
    await expect(svc.register('org', { name: 'x', registryUri: 's3://registry/nothing' })).rejects.toMatchObject({ response: { code: 'REGISTRY_URI_INVALID' } });
    await expect(svc.register('org', { name: 'x', registryUri: 'gs://b/x@1' })).rejects.toBeInstanceOf(BadRequestException);
    expect(rows).toHaveLength(0);
  });

  it('accepts an hf:// version without a manifest when base is given, and rejects it without', async () => {
    registry.describeVersion.mockRejectedValue(new Error('404'));
    await expect(svc.register('org', { name: 'hub', registryUri: 'hf://Qwen/Qwen3-0.6B@main' })).rejects.toMatchObject({ response: { code: 'VERSION_BASE_REQUIRED' } });
    const v = await svc.register('org', { name: 'hub', registryUri: 'hf://Qwen/Qwen3-0.6B@main', base: 'qwen3-0.6b', quantizations: ['Q8_0'] });
    expect(v).toMatchObject({ base: 'qwen3-0.6b', manifestSha: null, quantizations: ['Q8_0'] });
    expect(v.metadata).toMatchObject({ scheme: 'hf', manifest: null });
  });

  it('rejects a duplicate URI', async () => {
    registry.describeVersion.mockRejectedValue(new Error('404'));
    await svc.register('org', { name: 'a', registryUri: 'hf://x/y@1', base: 'b' });
    await expect(svc.register('org', { name: 'b', registryUri: 'hf://x/y@1', base: 'b' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('remove refuses while a deployment that is not torn down references the version', async () => {
    registry.describeVersion.mockRejectedValue(new Error('404'));
    const v = await svc.register('org', { name: 'a', registryUri: 'hf://x/y@1', base: 'b' });
    deployments.count.mockResolvedValueOnce(2);
    await expect(svc.remove('org', v.id)).rejects.toMatchObject({ response: { code: 'VERSION_IN_USE' } });
    deployments.count.mockResolvedValueOnce(0);
    await svc.remove('org', v.id, 'u');
    expect(rows).toHaveLength(0);
  });
});
