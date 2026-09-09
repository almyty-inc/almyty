import { Credential, CredentialType } from '../../../entities/credential.entity';
import { S3ProbeClientFactory } from '../connection-validation.service';
import { ConnectionsResolverService } from '../connections-resolver.service';
import { buildHarness, fakeEnvelope, principal } from './test-support';

describe('registry-s3 connector', () => {
  const ORG = 'org-1';
  const admin = principal('u-admin', ORG, 'admin');

  function s3Fixture(valid: { accessKeyId: string; secretAccessKey: string; buckets: string[] }) {
    const calls: Array<{ op: string; bucket: string; prefix?: string; cfg: any }> = [];
    const factory: S3ProbeClientFactory = (cfg) => ({
      async headBucket(bucket) {
        calls.push({ op: 'HeadBucket', bucket, cfg });
        if (cfg.accessKeyId !== valid.accessKeyId || cfg.secretAccessKey !== valid.secretAccessKey) throw Object.assign(new Error('Forbidden'), { name: 'InvalidAccessKeyId', $metadata: { httpStatusCode: 403 } });
        if (!valid.buckets.includes(bucket)) throw Object.assign(new Error('Not Found'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
      },
      async listOne(bucket, prefix) {
        calls.push({ op: 'ListObjectsV2', bucket, prefix, cfg });
      },
    });
    return { factory, calls };
  }

  it('validates with HeadBucket + ListObjectsV2(MaxKeys=1), stores an s3_compatible row with both keys encrypted, labels bucket@endpoint', async () => {
    const s3 = s3Fixture({ accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI', buckets: ['weights'] });
    const h = buildHarness({ s3Factory: s3.factory });
    const done = await h.service.connect(admin, ORG, 'registry-s3', { input: { endpoint: 'https://r2.example.com', region: 'auto', bucket: 'weights', prefix: 'models/', accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI' } });
    if (done.pending !== false) throw new Error('expected a connection');
    expect(done.connection).toMatchObject({ kind: 'registry', accountLabel: 'weights@r2.example.com', health: { status: 'valid' } });
    expect(s3.calls.map((c) => c.op)).toEqual(['HeadBucket', 'ListObjectsV2']);
    expect(s3.calls[1]).toMatchObject({ bucket: 'weights', prefix: 'models/', cfg: { endpoint: 'https://r2.example.com', region: 'auto' } });

    const row = h.credentials.rows[0];
    expect(row.type).toBe(CredentialType.S3_COMPATIBLE);
    expect(row.type).toBe('s3_compatible');
    expect(row.config.accessKeyId).toMatch(/^encrypted:/);
    expect(row.config.secretAccessKey).toMatch(/^encrypted:/);
    expect(row.config).toMatchObject({ endpoint: 'https://r2.example.com', region: 'auto', bucket: 'weights', prefix: 'models/' });
    expect(JSON.stringify(done.connection)).not.toMatch(/AKIAEXAMPLE|wJalrXUtnFEMI/);

    // The model registry (gate 3 consumer) gets the plain keys back through the resolver.
    const resolver = new ConnectionsResolverService(h.service, h.catalog, h.audit);
    const resolved = await resolver.resolveForOrg(ORG, done.connection.id, { purpose: 'model_registry' });
    expect(resolved.config).toMatchObject({ endpoint: 'https://r2.example.com', region: 'auto', bucket: 'weights', prefix: 'models/', accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI' });
  });

  it('labels an AWS bucket by region when no endpoint is given', async () => {
    const s3 = s3Fixture({ accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 's', buckets: ['weights'] });
    const h = buildHarness({ s3Factory: s3.factory });
    const done = await h.service.connect(admin, ORG, 'registry-s3', { input: { region: 'eu-west-1', bucket: 'weights', accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 's' } });
    if (done.pending !== false) throw new Error('expected a connection');
    expect(done.connection.accountLabel).toBe('weights@eu-west-1');
  });

  it('wrong keys and missing buckets keep the row with failed health and a readable reason', async () => {
    const s3 = s3Fixture({ accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 's', buckets: ['weights'] });
    const h = buildHarness({ s3Factory: s3.factory });
    await expect(h.service.connect(admin, ORG, 'registry-s3', { input: { region: 'us-east-1', bucket: 'weights', accessKeyId: 'AKIAWRONG', secretAccessKey: 's' } }))
      .rejects.toMatchObject({ response: { code: 'CONNECTION_VALIDATION_FAILED', message: 'bucket access denied (InvalidAccessKeyId)' } });
    await expect(h.service.connect(admin, ORG, 'registry-s3', { input: { region: 'us-east-1', bucket: 'nothere', accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 's' } }))
      .rejects.toMatchObject({ response: { code: 'CONNECTION_VALIDATION_FAILED', message: 'bucket nothere was not found (NotFound)' } });
    expect(h.credentials.rows.map((r) => r.healthStatus)).toEqual(['failed', 'failed']);
    await expect(h.service.connect(admin, ORG, 'registry-s3', { input: { region: 'us-east-1', bucket: 'weights', accessKeyId: 'a', secretAccessKey: 's', endpoint: 'http://10.0.0.5:9000' } }))
      .rejects.toMatchObject({ response: { message: expect.stringContaining('endpoint refused') } });
  });

  it('reports a missing @aws-sdk/client-s3 as a failed validation instead of crashing', async () => {
    const h = buildHarness({ s3Factory: () => { throw new Error('@aws-sdk/client-s3 is not installed on this API; the S3 registry probe cannot run'); } });
    await expect(h.service.connect(admin, ORG, 'registry-s3', { input: { region: 'us-east-1', bucket: 'weights', accessKeyId: 'a', secretAccessKey: 's' } }))
      .rejects.toMatchObject({ response: { code: 'CONNECTION_VALIDATION_FAILED', message: expect.stringContaining('@aws-sdk/client-s3 is not installed') } });
  });
});

describe('Credential entity: s3_compatible keys at rest', () => {
  beforeAll(() => { process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'unit-test-key-32-bytes-minimum-len'; });

  it('encryptSensitiveData encrypts accessKeyId and secretAccessKey and getDecryptedConfig restores them', () => {
    const c = new Credential();
    c.organizationId = 'org-1';
    c.type = CredentialType.S3_COMPATIBLE;
    c.config = { endpoint: 'https://r2.example.com', region: 'auto', bucket: 'weights', prefix: 'models/', accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI' };
    c.encryptSensitiveData();
    expect(c.config.accessKeyId).toMatch(/^encrypted:gcm:/);
    expect(c.config.secretAccessKey).toMatch(/^encrypted:gcm:/);
    expect(c.config.bucket).toBe('weights');
    expect(c.config.endpoint).toBe('https://r2.example.com');
    expect(c.getDecryptedConfig()).toEqual({ endpoint: 'https://r2.example.com', region: 'auto', bucket: 'weights', prefix: 'models/', accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI' });
  });

  it('encryptSensitiveDataForOrg routes the same two keys (and Modal token pairs) through the org envelope', async () => {
    const c = new Credential();
    c.organizationId = 'org-1';
    c.config = { bucket: 'weights', accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI', tokenId: 'ak-1', tokenSecret: 'as-1' };
    await c.encryptSensitiveDataForOrg(fakeEnvelope);
    for (const k of ['accessKeyId', 'secretAccessKey', 'tokenId', 'tokenSecret']) expect(c.config[k]).toMatch(/^encrypted:kms:/);
    expect(c.config.bucket).toBe('weights');
  });
});
