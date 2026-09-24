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

/**
 * Enough of TypeORM's FindOperator to evaluate the criteria this service
 * actually sends: `remove()` counts deployments with
 * `state: Not(In(['torn_down']))`, and a double that ignored the
 * operator would count a torn-down row as live (or, worse, count
 * nothing and prove nothing).
 */
function whereMatches(row: Record<string, any>, where: any): boolean {
  const valueMatches = (expected: any, actual: any): boolean => {
    if (expected && typeof expected === 'object' && '_type' in expected) {
      switch (expected._type) {
        case 'in':
          return (expected._value as any[]).includes(actual);
        case 'isNull':
          return actual === null || actual === undefined;
        case 'not':
          return !valueMatches(expected._value, actual);
        default:
          return expected._value === actual;
      }
    }
    return expected === actual;
  };
  return Object.entries(where ?? {}).every(([k, v]) => valueMatches(v, row[k]));
}

describe('ModelVersionsService', () => {
  let rows: ModelVersion[];
  let versions: any;
  let deployments: { count: jest.Mock };
  let deploymentRows: Array<Record<string, any>>;
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
    deploymentRows = [];
    deployments = {
      // Criteria-evaluating, so the org predicate and the
      // `Not(In(TERMINAL))` state filter in `remove()` are actually
      // exercised rather than assumed.
      count: jest.fn(async ({ where }: any) => deploymentRows.filter((d) => whereMatches(d, where)).length),
    };
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

  /**
   * The duplicate check sits before a manifest fetch that takes seconds,
   * so a double-click gets past it -- two rows for one registry URI,
   * after which the check itself returns an arbitrary one and the
   * in-use teardown guard counts deployments against a single copy.
   * The unique index is the real guard; this is it being honoured.
   */
  it('turns a unique-violation from a concurrent register back into VERSION_EXISTS', async () => {
    registry.describeVersion.mockRejectedValue(new Error('404'));
    await svc.register('org', { name: 'first', registryUri: 'hf://x/y@2', base: 'b' });

    // The row lands between the check and the insert, which is exactly
    // what the check cannot see.
    versions.findOne.mockResolvedValueOnce(null);
    versions.save.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }));

    await expect(
      svc.register('org', { name: 'second', registryUri: 'hf://x/y@2', base: 'b' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  /**
   * What holds a version alive is a *live* deployment *in this
   * organization*. Both halves of that were canned: `count` was a mock
   * returning whatever the test said next, so the criteria it was handed
   * — `organizationId` and `state: Not(In(['torn_down']))` — were never
   * looked at. Reduced to `{ modelVersionId }` alone, this suite stayed
   * green while a torn-down deployment, or another tenant's, would have
   * blocked the delete for good.
   */
  it('remove refuses while a live deployment in this org references the version', async () => {
    registry.describeVersion.mockRejectedValue(new Error('404'));
    const v = await svc.register('org', { name: 'a', registryUri: 'hf://x/y@1', base: 'b' });

    deploymentRows.push(
      { modelVersionId: v.id, organizationId: 'org', state: 'ready' },
      { modelVersionId: v.id, organizationId: 'org', state: 'deploying' },
    );
    await expect(svc.remove('org', v.id)).rejects.toMatchObject({
      response: { code: 'VERSION_IN_USE', message: expect.stringContaining('2 deployment') },
    });

    // Torn down, so it holds nothing. Neither does another tenant's row,
    // whatever state it is in.
    deploymentRows = [
      { modelVersionId: v.id, organizationId: 'org', state: 'torn_down' },
      { modelVersionId: v.id, organizationId: 'other-org', state: 'ready' },
    ];
    await svc.remove('org', v.id, 'u');
    expect(rows).toHaveLength(0);
  });
});
