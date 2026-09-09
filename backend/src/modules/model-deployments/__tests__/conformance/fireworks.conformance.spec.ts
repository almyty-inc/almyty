import { FireworksAdapter, ModelFileSource } from '../../adapters/fireworks.adapter';
import { liveRequested, runConformance } from './conformance.suite';

/**
 * Fixture mode: an in-memory stand-in for the Fireworks control plane
 * (api.fireworks.ai/v1/accounts/{account}: models with signed-URL upload
 * and validateUpload, deployments with :scale), faithful to the documented
 * paths, states and gRPC-style error codes, plus a fake byte source so no
 * registry is needed. Live mode (CONFORMANCE_LIVE=fireworks,
 * FIREWORKS_API_KEY + FIREWORKS_ACCOUNT in the local environment) runs
 * the same cases against a real account and never runs in CI.
 */
function fixtureHttp() {
  const models = new Map<string, any>();
  const deployments = new Map<string, any>();
  const puts: { url: string; headers: any; size: number }[] = [];
  const authed = (config: any) => {
    if ((config?.headers?.Authorization ?? '') !== 'Bearer fw_valid') {
      throw Object.assign(new Error('401'), { response: { status: 401, data: { code: 16, message: 'Unauthenticated', status: 'UNAUTHENTICATED' } } });
    }
  };
  const notFound = () => Object.assign(new Error('404'), { response: { status: 404, data: { code: 5, message: 'not found', status: 'NOT_FOUND' } } });
  const parse = (url: string) => {
    const m = url.match(/\/v1\/accounts\/([^/]+)\/(models|deployments)(?:\/([^/:]+))?(?::(getUploadEndpoint|validateUpload|scale))?$/);
    return { account: m?.[1], kind: m?.[2], id: m?.[3], verb: m?.[4] };
  };
  return {
    models,
    deployments,
    puts,
    http: {
      post: jest.fn(async (url: string, body: any, config: any) => {
        authed(config);
        const { account, kind, id, verb } = parse(url);
        if (kind === 'models' && !id) {
          if (models.has(body.modelId)) throw Object.assign(new Error('409'), { response: { status: 409, data: { code: 6, message: 'already exists', status: 'ALREADY_EXISTS' } } });
          const model = { name: `accounts/${account}/models/${body.modelId}`, ...body.model, state: 'UPLOADING', uploaded: new Set<string>(), files: body.model.baseModelDetails.huggingfaceFiles, createTime: new Date().toISOString() };
          models.set(body.modelId, model);
          return { data: model };
        }
        if (kind === 'models' && verb === 'getUploadEndpoint') {
          const model = models.get(id!);
          if (!model) throw notFound();
          const filenameToSignedUrls = Object.fromEntries(Object.keys(body.filenameToSize).map((f) => [f, `https://storage.googleapis.com/fw-uploads/${id}/${f}?X-Goog-Signature=sig`]));
          return { data: { filenameToSignedUrls } };
        }
        if (kind === 'deployments' && !id) {
          if (body.acceleratorType === 'NVIDIA_GB300') {
            throw Object.assign(new Error('429'), { response: { status: 429, data: { code: 8, message: 'GPU quota exceeded for NVIDIA_GB300 in GLOBAL', status: 'RESOURCE_EXHAUSTED' } } });
          }
          const modelId = String(body.baseModel).split('/').pop()!;
          if (models.get(modelId)?.state !== 'READY') {
            throw Object.assign(new Error('400'), { response: { status: 400, data: { code: 9, message: 'model is not READY', status: 'FAILED_PRECONDITION' } } });
          }
          const deploymentId = config.params.deploymentId;
          const d = { name: `accounts/${account}/deployments/${deploymentId}`, ...body, state: 'CREATING', replicaCount: 0, desiredReplicaCount: Math.max(body.minReplicaCount, 1), replicaStats: { readyReplicaCount: 0 }, region: body.placement?.region ?? body.placement?.multiRegion, createTime: new Date().toISOString() };
          deployments.set(deploymentId, d);
          return { data: d };
        }
        throw notFound();
      }),
      get: jest.fn(async (url: string, config: any) => {
        authed(config);
        const { kind, id, verb } = parse(url);
        if (kind === 'models') {
          const model = models.get(id!);
          if (!model) throw notFound();
          if (verb === 'validateUpload') {
            if (model.files.some((f: string) => !model.uploaded.has(f))) {
              throw Object.assign(new Error('400'), { response: { status: 400, data: { code: 9, message: 'files are still landing', status: 'FAILED_PRECONDITION' } } });
            }
            model.state = 'READY';
            return { data: {} };
          }
          return { data: model };
        }
        const d = deployments.get(id!);
        if (!d) throw notFound();
        // The fixture comes up on the first read after creation.
        if (d.state === 'CREATING') {
          d.state = 'READY';
          d.replicaCount = d.desiredReplicaCount;
          d.replicaStats = { readyReplicaCount: d.desiredReplicaCount };
        }
        return { data: d };
      }),
      put: jest.fn(async (url: string, body: any, config: any) => {
        const m = url.match(/fw-uploads\/([^/]+)\/(.+)\?/);
        const model = models.get(m![1]);
        if (!model) throw notFound();
        model.uploaded.add(m![2]);
        puts.push({ url, headers: config.headers, size: Buffer.isBuffer(body) ? body.length : -1 });
        return { status: 200, data: '' };
      }),
      patch: jest.fn(async (url: string, body: any, config: any) => {
        authed(config);
        const { id, verb } = parse(url);
        const d = deployments.get(id!);
        if (!d) throw notFound();
        if (verb === 'scale') {
          d.desiredReplicaCount = body.replicaCount;
          d.replicaCount = body.replicaCount;
          d.replicaStats = { readyReplicaCount: body.replicaCount };
          return { data: {} };
        }
        Object.assign(d, body);
        return { data: d };
      }),
      delete: jest.fn(async (url: string, config: any) => {
        authed(config);
        const { id } = parse(url);
        if (!deployments.delete(id!)) throw notFound();
        return { data: {} };
      }),
    } as any,
  };
}

const fixtureFiles = [
  { name: 'config.json', size: 12 },
  { name: 'model.safetensors', size: 40 },
  { name: 'tokenizer.json', size: 8 },
  { name: 'almyty-manifest.json', size: 5 },
];
const fixtureSource = (): ModelFileSource => ({
  list: async () => fixtureFiles,
  open: async (name) => Buffer.alloc(fixtureFiles.find((f) => f.name === name)!.size, 1),
});
const noSleep = async () => undefined;
const live = liveRequested('fireworks');
const fixture = fixtureHttp();
const adapter = () => (live ? new FireworksAdapter() : new FireworksAdapter(fixture.http, noSleep, fixtureSource));
const creds = live ? { apiKey: process.env.FIREWORKS_API_KEY } : { apiKey: 'fw_valid' };
const account = live ? process.env.FIREWORKS_ACCOUNT : 'almyty-test';

runConformance(live ? 'fireworks (LIVE)' : 'fireworks (fixture)', {
  adapter,
  credentials: creds,
  badCredentials: { apiKey: 'fw_expired' },
  tinyVersion: { id: 'v1', name: 'qwen3-0.6b', registryUri: 'hf://Qwen/Qwen3-0.6B@main', base: 'qwen3-0.6b', quantizations: [], manifestSha: 'sha' },
  providerConfig: { account, acceleratorType: 'NVIDIA_H100_80GB', region: 'GLOBAL' },
  quotaExceededConfig: live ? undefined : { account, acceleratorType: 'NVIDIA_GB300' },
  vanish: live ? undefined : (_adapter, ref) => { fixture.deployments.delete(ref.deploymentId); },
  chat: live ? undefined : async () => 'fixture reply',
  readyTimeoutMs: live ? 45 * 60_000 : 5_000,
});

describe('fireworks request shape', () => {
  const s3Version = { id: 'v-1', name: 'q', registryUri: 's3://registry/models/q@etag', base: 'qwen3-0.6b', quantizations: [], manifestSha: 'sha1' };
  const cfg = { account: 'almyty-test' };

  it('uploads an S3 registry version file by file to the signed URLs, validates, then deploys the model', async () => {
    const f = fixtureHttp();
    const a = new FireworksAdapter(f.http, noSleep, fixtureSource);
    const ref = await a.deploy(
      { deploymentId: 'abc-123', organizationId: 'org', version: s3Version, desired: { replicas: 1, minScale: 0, maxScale: 2, region: 'EU_FRANKFURT_1' }, providerConfig: { ...cfg, acceleratorCount: 2, precision: 'FP8', scaleToZeroWindow: '10m' } },
      { apiKey: 'fw_valid', registryAccessKeyId: 'AK', registrySecretAccessKey: 'SK' },
    );
    const posts = f.http.post.mock.calls;
    expect(posts[0][0]).toBe('https://api.fireworks.ai/v1/accounts/almyty-test/models');
    expect(posts[0][1]).toEqual({
      modelId: 'almyty-v-v1',
      model: { displayName: 'q', description: 'almyty version v-1', kind: 'HF_BASE_MODEL', baseModelDetails: { checkpointFormat: 'HUGGINGFACE', worldSize: 1, huggingfaceFiles: ['config.json', 'model.safetensors', 'tokenizer.json'] } },
    });
    expect(posts[0][2].headers.Authorization).toBe('Bearer fw_valid');
    expect(posts[1][0]).toBe('https://api.fireworks.ai/v1/accounts/almyty-test/models/almyty-v-v1:getUploadEndpoint');
    expect(posts[1][1]).toEqual({ filenameToSize: { 'config.json': 12, 'model.safetensors': 40, 'tokenizer.json': 8 }, enableResumableUpload: false });
    // Three files, streamed with the exact length range and no bearer token on the storage host.
    expect(f.puts.map((p) => [p.url.split('?')[0].split('/').pop(), p.size, p.headers['x-goog-content-length-range']])).toEqual([
      ['config.json', 12, '12,12'], ['model.safetensors', 40, '40,40'], ['tokenizer.json', 8, '8,8'],
    ]);
    expect(f.puts.every((p) => !p.headers.Authorization)).toBe(true);
    expect(f.http.get.mock.calls.some((c: any[]) => String(c[0]).endsWith('/models/almyty-v-v1:validateUpload'))).toBe(true);
    expect(posts[2][0]).toBe('https://api.fireworks.ai/v1/accounts/almyty-test/deployments');
    expect(posts[2][2].params).toEqual({ deploymentId: 'almyty-d-abc123' });
    expect(posts[2][1]).toEqual({
      baseModel: 'accounts/almyty-test/models/almyty-v-v1',
      displayName: 'almyty abc-123',
      minReplicaCount: 0,
      maxReplicaCount: 2,
      acceleratorType: 'NVIDIA_H100_80GB',
      acceleratorCount: 2,
      precision: 'FP8',
      autoscalingPolicy: { scaleToZeroWindow: '10m' },
      placement: { region: 'EU_FRANKFURT_1' },
    });
    expect(JSON.stringify(posts.map((c) => c[1]))).not.toContain('SK');
    expect(ref.url).toBe('https://api.fireworks.ai/inference/v1');
    expect(ref.name).toBe('accounts/almyty-test/deployments/almyty-d-abc123');
    expect(ref.singleRegion).toBe(true);
  });

  it('uploads a hub version with its Hugging Face URL and places it in a multi-region', async () => {
    const f = fixtureHttp();
    const a = new FireworksAdapter(f.http, noSleep, fixtureSource);
    await a.deploy(
      { deploymentId: 'd', organizationId: 'org', version: { id: 'v2', name: 'q', registryUri: 'hf://Qwen/Qwen3-0.6B@abc123', base: 'qwen3', quantizations: [], manifestSha: 's' }, desired: {}, providerConfig: { ...cfg, region: 'EUROPE' } },
      { apiKey: 'fw_valid', hfToken: 'hf_secret' },
    );
    const posts = f.http.post.mock.calls;
    expect(posts[0][1].model.huggingFaceUrl).toBe('https://huggingface.co/Qwen/Qwen3-0.6B');
    expect(posts[2][1].placement).toEqual({ multiRegion: 'EUROPE' });
    expect(posts[2][1].precision).toBeUndefined();
    expect(JSON.stringify(posts.map((c) => c[1]))).not.toContain('hf_secret');
  });

  it('reuses a READY model for the same version and deploys a fireworks:// URI without uploading', async () => {
    const f = fixtureHttp();
    const a = new FireworksAdapter(f.http, noSleep, fixtureSource);
    await a.upload(s3Version, { apiKey: 'fw_valid' }, cfg);
    const putsAfterFirst = f.puts.length;
    const again = await a.upload(s3Version, { apiKey: 'fw_valid' }, cfg);
    expect(again.registryUri).toBe('fireworks://accounts/almyty-test/models/almyty-v-v1@sha1');
    expect(f.puts.length).toBe(putsAfterFirst);
    await a.deploy({ deploymentId: 'd', organizationId: 'org', version: { ...s3Version, registryUri: again.registryUri }, desired: {}, providerConfig: cfg }, { apiKey: 'fw_valid' });
    expect(f.http.post.mock.calls.filter((c: any[]) => String(c[0]).endsWith('/models'))).toHaveLength(1);
  });

  it('keeps polling validateUpload through FAILED_PRECONDITION until the files land', async () => {
    const f = fixtureHttp();
    const a = new FireworksAdapter(f.http, noSleep, fixtureSource);
    const real = f.http.get.getMockImplementation()!;
    let validateCalls = 0;
    f.http.get.mockImplementation(async (url: string, config: any) => {
      // The first validation sees files still landing; the second sees them all.
      if (url.endsWith(':validateUpload') && validateCalls++ === 0) {
        throw Object.assign(new Error('400'), { response: { status: 400, data: { code: 9, message: 'files are still landing', status: 'FAILED_PRECONDITION' } } });
      }
      return real(url, config);
    });
    const result = await a.upload(s3Version, { apiKey: 'fw_valid' }, cfg);
    expect(validateCalls).toBe(2);
    expect(result.registryUri).toBe('fireworks://accounts/almyty-test/models/almyty-v-v1@sha1');
    expect(f.models.get('almyty-v-v1').state).toBe('READY');
  });

  it('scales by patching the floor then :scale, reports zero replicas as stopped, and prices per GPU hour', async () => {
    const f = fixtureHttp();
    const a = new FireworksAdapter(f.http, noSleep, fixtureSource);
    const ref = await a.deploy({ deploymentId: 'd', organizationId: 'org', version: s3Version, desired: { maxScale: 3, region: 'US_IOWA_1' }, providerConfig: { ...cfg, acceleratorType: 'NVIDIA_B200_180GB', acceleratorCount: 2 } }, { apiKey: 'fw_valid' });
    expect((await a.readEndpoint(ref, { apiKey: 'fw_valid' })).state).toBe('ready');
    // 1300 cents per GPU hour, two GPUs, single region premium 1.5, one replica.
    expect((await a.costSnapshot(ref, { apiKey: 'fw_valid' })).ratePerHourCents).toBe(3900);
    await a.scale(ref, 0, { apiKey: 'fw_valid' });
    expect(f.http.patch.mock.calls[0][0]).toBe('https://api.fireworks.ai/v1/accounts/almyty-test/deployments/almyty-d-d');
    expect(f.http.patch.mock.calls[0][1]).toEqual({ baseModel: 'accounts/almyty-test/models/almyty-v-v1', minReplicaCount: 0, maxReplicaCount: 3 });
    expect(f.http.patch.mock.calls[1][0]).toBe('https://api.fireworks.ai/v1/accounts/almyty-test/deployments/almyty-d-d:scale');
    expect(f.http.patch.mock.calls[1][1]).toEqual({ replicaCount: 0 });
    expect((await a.readEndpoint(ref, { apiKey: 'fw_valid' })).state).toBe('stopped');
    expect((await a.costSnapshot(ref, { apiKey: 'fw_valid' })).ratePerHourCents).toBe(0);
    await a.scale(ref, 2, { apiKey: 'fw_valid' });
    expect((await a.readEndpoint(ref, { apiKey: 'fw_valid' })).replicas).toBe(2);
    await a.teardown(ref, { apiKey: 'fw_valid' });
    expect(f.http.delete.mock.calls[0][1].params).toEqual({ ignoreChecks: true });
    await expect(a.teardown(ref, { apiKey: 'fw_valid' })).resolves.toBeUndefined();
  });

  it('maps every documented deployment state', async () => {
    const f = fixtureHttp();
    const a = new FireworksAdapter(f.http, noSleep, fixtureSource);
    const ref = await a.deploy({ deploymentId: 'd', organizationId: 'org', version: s3Version, desired: {}, providerConfig: cfg }, { apiKey: 'fw_valid' });
    const d = f.deployments.get(ref.deploymentId);
    for (const [raw, expected] of Object.entries({ CREATING: 'deploying', READY: 'ready', UPDATING: 'scaling', DELETING: 'stopped', DELETED: 'missing', FAILED: 'failed' })) {
      d.state = raw;
      const actual = await a.readEndpoint(ref, { apiKey: 'fw_valid' });
      // The fixture flips CREATING to READY on read, like a deployment that came up.
      expect(actual.state).toBe(raw === 'CREATING' ? 'ready' : expected);
    }
  });
});
