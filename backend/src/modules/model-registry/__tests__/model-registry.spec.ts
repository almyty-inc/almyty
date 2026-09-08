import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { InvalidRegistryUriError, parseRegistryUri } from '../registry-uri';
import { InvalidManifestError, manifestSha, validateManifest } from '../manifest';
import { MANIFEST_FILE, ModelRegistryService, RegistryObjectStore } from '../model-registry.service';

const manifest = () => ({
  schemaVersion: 1 as const,
  base: 'qwen3-0.6b',
  tokenizer: 'hf://Qwen/Qwen3-0.6B@abc',
  license: 'Apache-2.0',
  created: '2026-09-08T09:00:00Z',
  files: [{ path: 'model.safetensors', sizeBytes: 1200 }, { path: 'tokenizer.json', sizeBytes: 34 }],
});

describe('parseRegistryUri', () => {
  it('parses the three shapes and requires the pin', () => {
    expect(parseRegistryUri('s3://registry/models/qwen3@e3b0c442')).toMatchObject({ scheme: 's3', location: 'registry', prefix: 'models/qwen3', pin: 'e3b0c442' });
    expect(parseRegistryUri('hf://Qwen/Qwen3-0.6B@abc123')).toMatchObject({ scheme: 'hf', location: 'Qwen/Qwen3-0.6B', pin: 'abc123' });
    expect(parseRegistryUri('file:///var/models/qwen3@sha1')).toMatchObject({ scheme: 'file', location: '/var/models/qwen3', pin: 'sha1' });
    expect(() => parseRegistryUri('s3://registry/models/qwen3')).toThrow(InvalidRegistryUriError);
    expect(() => parseRegistryUri('gs://bucket/x@1')).toThrow(InvalidRegistryUriError);
    expect(() => parseRegistryUri('s3://registry/../x@1')).toThrow(InvalidRegistryUriError);
    expect(() => parseRegistryUri('file://relative/path@1')).toThrow(InvalidRegistryUriError);
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

  it('publishes a manifest and returns a pinned s3 URI it can read back', async () => {
    const service = new ModelRegistryService(undefined, store);
    const published = await service.publishManifest('registry', 'models/qwen3/', manifest());
    expect(published.registryUri).toBe('s3://registry/models/qwen3@etag-1');
    expect(published.sizeBytes).toBe(1234);
    const described = await service.describeVersion(published.registryUri);
    expect(described.manifest.base).toBe('qwen3-0.6b');
    expect(described.manifestSha).toBe(published.manifestSha);
    expect(described.parsed.scheme).toBe('s3');
  });

  it('reads a runner-local manifest through file://', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'almyty-registry-'));
    writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest()));
    const service = new ModelRegistryService(undefined, store);
    const m = await service.readManifest(`file://${dir}@local`);
    expect(m.license).toBe('Apache-2.0');
  });

  it('refuses a manifest that is not valid JSON or not a manifest', async () => {
    memory.set('registry/broken/' + MANIFEST_FILE, Buffer.from('{not json'));
    memory.set('registry/thin/' + MANIFEST_FILE, Buffer.from('{"schemaVersion":1}'));
    const service = new ModelRegistryService(undefined, store);
    await expect(service.readManifest('s3://registry/broken@x')).rejects.toMatchObject({ code: 'REGISTRY_MANIFEST_INVALID' });
    await expect(service.readManifest('s3://registry/thin@x')).rejects.toBeInstanceOf(InvalidManifestError);
  });

  it('says clearly when no registry is configured', () => {
    const saved = { ...process.env };
    for (const k of Object.keys(process.env)) if (/^(MODEL_REGISTRY_S3_|STORAGE_S3_)/.test(k)) delete process.env[k];
    const service = new ModelRegistryService(undefined, undefined);
    expect(service.isConfigured()).toBe(false);
    expect(() => (service as any).objectStore()).toThrow(/not configured/);
    process.env = saved;
  });
});
