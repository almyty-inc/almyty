import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { InvalidRegistryUriError, parseRegistryUri } from '../registry-uri';
import { InvalidManifestError, manifestSha, validateManifest } from '../manifest';
import { MANIFEST_FILE, ModelRegistryService, RegistryObjectStore } from '../model-registry.service';
import { Credential } from '../../../entities/credential.entity';

const manifest = () => ({
  schemaVersion: 1 as const,
  base: 'qwen3-0.6b',
  tokenizer: 'hf://Qwen/Qwen3-0.6B@abc',
  license: 'Apache-2.0',
  created: '2026-09-08T09:00:00Z',
  files: [{ path: 'model.safetensors', sizeBytes: 1200 }, { path: 'tokenizer.json', sizeBytes: 34 }],
});

describe('parseRegistryUri', () => {
  it('parses every artifact scheme and requires the pin on each', () => {
    expect(parseRegistryUri('s3://registry/models/qwen3@e3b0c442')).toMatchObject({ scheme: 's3', kind: 'artifact', location: 'registry', prefix: 'models/qwen3', pin: 'e3b0c442' });
    expect(parseRegistryUri('gs://bucket/models/qwen3@1725800000')).toMatchObject({ scheme: 'gs', kind: 'artifact', location: 'bucket', prefix: 'models/qwen3', pin: '1725800000' });
    expect(parseRegistryUri('hf://Qwen/Qwen3-0.6B@abc123')).toMatchObject({ scheme: 'hf', kind: 'artifact', location: 'Qwen/Qwen3-0.6B', pin: 'abc123' });
    expect(parseRegistryUri('file:///var/models/qwen3@sha1')).toMatchObject({ scheme: 'file', kind: 'artifact', location: '/var/models/qwen3', pin: 'sha1' });
    expect(() => parseRegistryUri('s3://registry/models/qwen3')).toThrow(InvalidRegistryUriError);
    expect(() => parseRegistryUri('gs://bucket/models/qwen3')).toThrow(InvalidRegistryUriError);
    expect(() => parseRegistryUri('s3://registry/../x@1')).toThrow(InvalidRegistryUriError);
    expect(() => parseRegistryUri('file://relative/path@1')).toThrow(InvalidRegistryUriError);
  });

  it('takes a model that already lives on a provider without a pin, because the platform versions it', () => {
    expect(parseRegistryUri('bedrock://arn:aws:bedrock:us-east-1:1:imported-model/abc')).toMatchObject({ scheme: 'bedrock', kind: 'provider', location: 'arn:aws:bedrock:us-east-1:1:imported-model/abc', pin: '' });
    expect(parseRegistryUri('fireworks://accounts/acme/models/qwen3')).toMatchObject({ scheme: 'fireworks', kind: 'provider', pin: '' });
    expect(parseRegistryUri('together://acme/qwen3-tuned')).toMatchObject({ scheme: 'together', kind: 'provider' });
    expect(parseRegistryUri('baseten://abcd1234')).toMatchObject({ scheme: 'baseten', kind: 'provider' });
    expect(parseRegistryUri('vertex://publishers/google/models/gemma-3')).toMatchObject({ scheme: 'vertex', kind: 'provider' });
    expect(parseRegistryUri('sagemaker://model-package/arn:aws:sagemaker:us-east-1:1:model-package/p/1')).toMatchObject({ scheme: 'sagemaker', kind: 'provider' });
    expect(parseRegistryUri('azureml://registries/azureml/models/Phi-4/labels/latest')).toMatchObject({ scheme: 'azureml', kind: 'provider' });
    // A pin is allowed where the platform uses one, and it is read off the tail.
    expect(parseRegistryUri('foundry://openai/gpt-4o@2024-11-20')).toMatchObject({ scheme: 'foundry', kind: 'provider', pin: '2024-11-20' });
    expect(() => parseRegistryUri('bedrock://')).toThrow(InvalidRegistryUriError);
    expect(() => parseRegistryUri('bedrock://../escape')).toThrow(InvalidRegistryUriError);
  });

  it('refuses a scheme nobody can run', () => {
    expect(() => parseRegistryUri('ftp://host/model@1')).toThrow(InvalidRegistryUriError);
    expect(() => parseRegistryUri('')).toThrow(InvalidRegistryUriError);
  });
});

describe('validateManifest', () => {
  it('accepts a complete manifest and digests it stably', () => {
    const m = validateManifest(manifest());
    expect(manifestSha(m)).toBe(manifestSha({ ...manifest(), files: manifest().files }));
    expect(manifestSha(m)).toHaveLength(64);
  });

  it('lists every problem at once', () => {
    const failure = (() => {
      try {
        validateManifest({ schemaVersion: 2, files: [{ path: '/abs.safetensors', sizeBytes: -1 }] });
      } catch (e) {
        return e as InvalidManifestError;
      }
    })();
    expect(failure).toBeInstanceOf(InvalidManifestError);
    expect(failure!.problems).toEqual(expect.arrayContaining([
      'missing base', 'missing tokenizer', 'missing license', 'missing created',
      'schemaVersion must be 1',
      'files[0].path must be relative and may not contain ..',
      'files[0].sizeBytes must be a non-negative number',
    ]));
  });
});

describe('ModelRegistryService', () => {
  const memory = new Map<string, Buffer>();
  const store: RegistryObjectStore = {
    async getObject(bucket, key) {
      const v = memory.get(`${bucket}/${key}`);
      if (!v) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      return v;
    },
    async putObject(bucket, key, body) {
      memory.set(`${bucket}/${key}`, body);
      return { etag: 'etag-1' };
    },
    async headObject(bucket, key) {
      const v = memory.get(`${bucket}/${key}`);
      return v ? { etag: 'etag-1', sizeBytes: v.length } : null;
    },
  };

  it('publishes a manifest into the organization bucket and returns a pinned s3 URI it can read back', async () => {
    const service = new ModelRegistryService(undefined, store);
    const published = await service.publishManifest('org-1', 'models/qwen3/', manifest());
    expect(published.registryUri).toBe('s3://registry/models/qwen3@etag-1');
    expect(published.sizeBytes).toBe(1234);
    const described = await service.describeVersion(published.registryUri, 'org-1');
    expect(described.manifest.base).toBe('qwen3-0.6b');
    expect(described.manifestSha).toBe(published.manifestSha);
    expect(described.parsed.scheme).toBe('s3');
  });

  it('reads a runner-local manifest through file://', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'almyty-registry-'));
    writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest()));
    const service = new ModelRegistryService(undefined, store);
    const m = await service.readManifest(`file://${dir}@local`, 'org-1');
    expect(m.license).toBe('Apache-2.0');
  });

  it('refuses a manifest that is not valid JSON or not a manifest', async () => {
    memory.set('registry/broken/' + MANIFEST_FILE, Buffer.from('{not json'));
    memory.set('registry/thin/' + MANIFEST_FILE, Buffer.from('{"schemaVersion":1}'));
    const service = new ModelRegistryService(undefined, store);
    await expect(service.readManifest('s3://registry/broken@x', 'org-1')).rejects.toMatchObject({ code: 'REGISTRY_MANIFEST_INVALID' });
    await expect(service.readManifest('s3://registry/thin@x', 'org-1')).rejects.toBeInstanceOf(InvalidManifestError);
  });

  it('resolves the store per organization: another org with no connection is refused, never served from a shared bucket', async () => {
    const service = new ModelRegistryService(undefined, (org) => (org === 'org-1' ? store : null));
    await expect(service.readManifest('s3://registry/models/qwen3@etag-1', 'org-2')).rejects.toMatchObject({ code: 'REGISTRY_NOT_CONNECTED' });
    expect(await service.isConnected('org-1')).toBe(true);
    expect(await service.isConnected('org-2')).toBe(false);
  });
});

describe('ModelRegistryService connections', () => {
  const credentialRow = (config: Record<string, any>, over: Partial<any> = {}) => {
    const c = new Credential();
    Object.assign(c, { id: 'cred-1', organizationId: 'org-1', type: 's3_compatible', isActive: true, config, ...over });
    return c;
  };

  it('reads the connection from the org credential and hands adapters the registry keys', async () => {
    const row = credentialRow({ endpoint: 'https://s3.example', region: 'eu-central-1', bucket: 'acme-models', prefix: 'llm', accessKeyId: 'AK', secretAccessKey: 'SK' });
    const credentials = { findOne: jest.fn().mockResolvedValue(row), create: jest.fn(), save: jest.fn() };
    const service = new ModelRegistryService(undefined, undefined, credentials as any, { count: jest.fn() } as any, undefined);
    const conn = await service.connectionFor('org-1');
    expect(conn).toMatchObject({ credentialId: 'cred-1', bucket: 'acme-models', prefix: 'llm', region: 'eu-central-1', endpoint: 'https://s3.example' });
    expect(credentials.findOne).toHaveBeenCalledWith({ where: { organizationId: 'org-1', type: 's3_compatible', isActive: true } });
    expect(await service.adapterCredentialsFor('org-1')).toEqual({ registryAccessKeyId: 'AK', registrySecretAccessKey: 'SK', registryEndpoint: 'https://s3.example', registryRegion: 'eu-central-1', registryBucket: 'acme-models' });
  });

  it('refuses with REGISTRY_NOT_CONNECTED when the org has no active registry credential', async () => {
    const credentials = { findOne: jest.fn().mockResolvedValue(null) };
    const service = new ModelRegistryService(undefined, undefined, credentials as any, { count: jest.fn() } as any, undefined);
    await expect(service.connectionFor('org-1')).rejects.toMatchObject({ code: 'REGISTRY_NOT_CONNECTED' });
    await expect(service.readManifest('s3://b/k@1', 'org-1')).rejects.toMatchObject({ code: 'REGISTRY_NOT_CONNECTED' });
  });

  describe('single-tenant seed from the environment', () => {
    const env = { MODEL_REGISTRY_S3_BUCKET: 'selfhost', MODEL_REGISTRY_S3_ACCESS_KEY: 'AK', MODEL_REGISTRY_S3_SECRET_KEY: 'SK', MODEL_REGISTRY_S3_REGION: 'us-west-2' };
    let saved: Record<string, string | undefined>;
    beforeEach(() => { saved = { ...process.env }; Object.assign(process.env, env); });
    afterEach(() => { process.env = saved as any; });

    it('creates one org-scoped connection when exactly one organization exists and has none', async () => {
      const encrypt = jest.spyOn(Credential.prototype, 'encryptSensitiveData');
      const credentials = { findOne: jest.fn().mockResolvedValue(null), create: jest.fn((p: any) => Object.assign(new Credential(), p)), save: jest.fn(async (c: any) => ({ ...c, id: 'seeded' })) };
      const organizations = { count: jest.fn().mockResolvedValue(1), findOne: jest.fn().mockResolvedValue({ id: 'only-org' }) };
      const service = new ModelRegistryService(undefined, undefined, credentials as any, organizations as any, undefined);
      const result = await service.seedSingleTenantFromEnv();
      expect(result?.id).toBe('seeded');
      const created = credentials.create.mock.calls[0][0];
      expect(created).toMatchObject({ organizationId: 'only-org', type: 's3_compatible', isActive: true });
      expect(created.config).toMatchObject({ bucket: 'selfhost', region: 'us-west-2', accessKeyId: 'AK' });
      expect(encrypt).toHaveBeenCalledTimes(1);
      encrypt.mockRestore();
    });

    it('does nothing with two organizations, an existing connection, or no env keys', async () => {
      const credentials = { findOne: jest.fn().mockResolvedValue(null), create: jest.fn(), save: jest.fn() };
      const organizations = { count: jest.fn().mockResolvedValue(2), findOne: jest.fn() };
      const service = new ModelRegistryService(undefined, undefined, credentials as any, organizations as any, undefined);
      expect(await service.seedSingleTenantFromEnv()).toBeNull();
      organizations.count.mockResolvedValue(1);
      organizations.findOne.mockResolvedValue({ id: 'only-org' });
      credentials.findOne.mockResolvedValue(credentialRow({ bucket: 'x' }));
      expect(await service.seedSingleTenantFromEnv()).toBeNull();
      delete process.env.MODEL_REGISTRY_S3_ACCESS_KEY;
      credentials.findOne.mockResolvedValue(null);
      expect(await service.seedSingleTenantFromEnv()).toBeNull();
      expect(credentials.save).not.toHaveBeenCalled();
    });
  });
});
