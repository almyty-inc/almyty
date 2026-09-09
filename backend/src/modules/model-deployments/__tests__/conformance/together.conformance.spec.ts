import { TogetherAdapter } from '../../adapters/together.adapter';
import { liveRequested, runConformance } from './conformance.suite';

/**
 * Fixture mode: an in-memory stand-in for Together's v1 dedicated
 * endpoints API (api.together.xyz/v1: /models upload, /jobs, /endpoints,
 * /hardware), faithful to the documented paths, states and error codes.
 * Live mode (CONFORMANCE_LIVE=together, TOGETHER_API_KEY in the local
 * environment) runs the same cases against a real account and never runs
 * in CI.
 */
function fixtureHttp() {
  const endpoints = new Map<string, any>();
  const jobs = new Map<string, any>();
  const uploads: any[] = [];
  let seq = 0;
  const authed = (config: any) => {
    if ((config?.headers?.Authorization ?? '') !== 'Bearer tg_valid') {
      throw Object.assign(new Error('401'), { response: { status: 401, data: { error: { message: 'Invalid API key provided', type: 'invalid_request_error' } } } });
    }
  };
  const notFound = () => Object.assign(new Error('404'), { response: { status: 404, data: { error: { message: 'Not Found', type: 'not_found' } } } });
  const endpointId = (url: string) => url.match(/\/v1\/endpoints\/([^/]+)$/)?.[1];
  return {
    endpoints,
    jobs,
    uploads,
    http: {
      post: jest.fn(async (url: string, body: any, config: any) => {
        authed(config);
        if (url.endsWith('/v1/models')) {
          seq += 1;
          uploads.push(body);
          const jobId = `job-${seq}`;
          // One Running poll before Complete, so the adapter's polling loop is exercised.
          jobs.set(jobId, { status: 'Running', polls: 0 });
          return { data: { job_id: jobId, model_name: `almyty-test/${body.model_name}`, model_id: `model-${seq}`, model_source: body.model_source.startsWith('http') ? 's3' : 'huggingface' } };
        }
        if (url.endsWith('/v1/endpoints')) {
          if (body.hardware === '8x_nvidia_h200_140gb_sxm') {
            throw Object.assign(new Error('429'), { response: { status: 429, data: { error: { message: 'Insufficient capacity for requested hardware', type: 'rate_limit' } } } });
          }
          seq += 1;
          const ep = {
            object: 'endpoint',
            id: `endpoint-${seq}`,
            name: `almyty-test/${String(body.model).split('/').pop()}-${seq}`,
            display_name: body.display_name,
            model: body.model,
            hardware: body.hardware,
            type: 'dedicated',
            owner: 'almyty-test',
            state: 'PENDING',
            autoscaling: body.autoscaling,
            created_at: new Date().toISOString(),
            request: body,
          };
          endpoints.set(ep.id, ep);
          return { data: ep };
        }
        throw notFound();
      }),
      get: jest.fn(async (url: string, config: any) => {
        authed(config);
        if (url.endsWith('/v1/hardware')) {
          return {
            data: {
              object: 'list',
              data: [
                { object: 'hardware', id: '1x_nvidia_h100_80gb_sxm', pricing: { cents_per_minute: 6.65 }, specs: { gpu_type: 'h100-80gb', gpu_link: 'sxm', gpu_memory: 80, gpu_count: 1 }, availability: { status: 'available' } },
                { object: 'hardware', id: '1x_nvidia_a100_80gb_sxm', pricing: { cents_per_minute: 4.0 }, specs: { gpu_type: 'a100-80gb', gpu_link: 'sxm', gpu_memory: 80, gpu_count: 1 }, availability: { status: 'available' } },
              ],
            },
          };
        }
        const job = url.match(/\/v1\/jobs\/([^/]+)$/)?.[1];
        if (job) {
          const j = jobs.get(job);
          if (!j) throw notFound();
          j.polls += 1;
          if (j.polls >= 2) j.status = 'Complete';
          return { data: { type: 'model_upload', job_id: job, status: j.status } };
        }
        const ep = endpoints.get(endpointId(url)!);
        if (!ep) throw notFound();
        // The fixture starts on the first read after creation.
        if (ep.state === 'PENDING') ep.state = 'STARTED';
        return { data: ep };
      }),
      patch: jest.fn(async (url: string, body: any, config: any) => {
        authed(config);
        const ep = endpoints.get(endpointId(url)!);
        if (!ep) throw notFound();
        if (body.autoscaling) ep.autoscaling = body.autoscaling;
        if (body.state) ep.state = body.state;
        return { data: ep };
      }),
      delete: jest.fn(async (url: string, config: any) => {
        authed(config);
        if (!endpoints.delete(endpointId(url)!)) throw notFound();
        return { status: 204, data: '' };
      }),
    } as any,
  };
}

const noSleep = async () => undefined;
const live = liveRequested('together');
const fixture = fixtureHttp();
const adapter = () => (live ? new TogetherAdapter() : new TogetherAdapter(fixture.http, noSleep));

runConformance(live ? 'together (LIVE)' : 'together (fixture)', {
  adapter,
  credentials: live ? { apiKey: process.env.TOGETHER_API_KEY } : { apiKey: 'tg_valid' },
  badCredentials: { apiKey: 'tg_expired' },
  tinyVersion: { id: 'v1', name: 'qwen3-0.6b', registryUri: 'hf://Qwen/Qwen3-0.6B@main', base: 'qwen3-0.6b', quantizations: [], manifestSha: 'sha' },
  providerConfig: { hardware: live ? '1x_nvidia_a100_80gb_sxm' : '1x_nvidia_h100_80gb_sxm', hourlyRateCents: 240 },
  quotaExceededConfig: live ? undefined : { hardware: '8x_nvidia_h200_140gb_sxm' },
  vanish: live ? undefined : (_adapter, ref) => { fixture.endpoints.delete(ref.endpointId); },
  chat: live ? undefined : async () => 'fixture reply',
  readyTimeoutMs: live ? 45 * 60_000 : 5_000,
});

describe('together request shape', () => {
  const s3Version = { id: 'v-1', name: 'q', registryUri: 's3://registry/models/q@etag', base: 'qwen3-0.6b', quantizations: [], manifestSha: 's' };

  it('uploads an S3 registry version from a presigned archive URL, then deploys the owner-prefixed model name', async () => {
    const f = fixtureHttp();
    const a = new TogetherAdapter(f.http, noSleep);
    const ref = await a.deploy(
      { deploymentId: 'abc-123', organizationId: 'org', version: s3Version, desired: { replicas: 1, minScale: 0, maxScale: 2, region: 'us-central-4b' }, providerConfig: { inactiveTimeoutMinutes: 30 } },
      { apiKey: 'tg_valid', registryArchiveUrlSecret: 'https://minio.local/registry/models/q.tar.gz?X-Amz-Signature=sig' },
    );
    const [uploadCall, createCall] = f.http.post.mock.calls;
    expect(uploadCall[0]).toBe('https://api.together.xyz/v1/models');
    expect(uploadCall[1]).toEqual({ model_name: 'almyty-q-v1', model_source: 'https://minio.local/registry/models/q.tar.gz?X-Amz-Signature=sig', model_type: 'model', description: 'almyty version v-1 (s)' });
    expect(uploadCall[2].headers.Authorization).toBe('Bearer tg_valid');
    expect(f.http.get.mock.calls.filter((c: any[]) => String(c[0]).includes('/v1/jobs/job-1'))).toHaveLength(2);
    expect(createCall[0]).toBe('https://api.together.xyz/v1/endpoints');
    expect(createCall[1]).toEqual({
      model: 'almyty-test/almyty-q-v1',
      hardware: '1x_nvidia_h100_80gb_sxm',
      display_name: 'almyty-abc123',
      autoscaling: { min_replicas: 0, max_replicas: 2 },
      state: 'STARTED',
      disable_speculative_decoding: false,
      inactive_timeout: 30,
      availability_zone: 'us-central-4b',
    });
    // The presigned URL is an upload input only; it never lands in the endpoint request.
    expect(JSON.stringify(createCall[1])).not.toContain('X-Amz-Signature');
    expect(ref.url).toBe('https://api.together.xyz/v1');
    expect(ref.name).toBe('almyty-test/almyty-q-v1-2');
  });

  it('refuses an S3 version without an archive URL before calling Together', async () => {
    const f = fixtureHttp();
    const a = new TogetherAdapter(f.http, noSleep);
    await expect(a.deploy({ deploymentId: 'd', organizationId: 'org', version: s3Version, desired: {}, providerConfig: {} }, { apiKey: 'tg_valid' })).rejects.toMatchObject({ code: 'ADAPTER_ERROR' });
    expect(f.http.post).not.toHaveBeenCalled();
  });

  it('uploads a hub version by repo id with the Hugging Face token, revision dropped', async () => {
    const f = fixtureHttp();
    const a = new TogetherAdapter(f.http, noSleep);
    await a.deploy(
      { deploymentId: 'd', organizationId: 'org', version: { id: 'v2', name: 'q', registryUri: 'hf://Qwen/Qwen3-0.6B@abc123', base: 'qwen3', quantizations: [], manifestSha: 's' }, desired: {}, providerConfig: {} },
      { apiKey: 'tg_valid', hfToken: 'hf_secret' },
    );
    expect(f.http.post.mock.calls[0][1]).toMatchObject({ model_source: 'Qwen/Qwen3-0.6B', hf_token: 'hf_secret', model_type: 'model' });
    expect(f.http.post.mock.calls[1][1].autoscaling).toEqual({ min_replicas: 0, max_replicas: 1 });
    expect(f.http.post.mock.calls[1][1].availability_zone).toBeUndefined();
  });

  it('deploys a together:// URI without uploading again', async () => {
    const f = fixtureHttp();
    const a = new TogetherAdapter(f.http, noSleep);
    await a.deploy(
      { deploymentId: 'd', organizationId: 'org', version: { id: 'v', name: 'q', registryUri: 'together://almyty-test/almyty-q-v1@model-9', base: 'q', quantizations: [], manifestSha: 's' }, desired: {}, providerConfig: {} },
      { apiKey: 'tg_valid' },
    );
    expect(f.http.post.mock.calls).toHaveLength(1);
    expect(f.http.post.mock.calls[0][1].model).toBe('almyty-test/almyty-q-v1');
  });

  it('fails the upload as a typed error when the job ends in Failed', async () => {
    const f = fixtureHttp();
    f.http.get.mockImplementationOnce(async () => ({ data: { job_id: 'job-1', status: 'Failed' } }));
    const a = new TogetherAdapter(f.http, noSleep);
    await expect(a.upload({ ...s3Version }, { apiKey: 'tg_valid', registryArchiveUrlSecret: 'https://x/y.tar.gz' })).rejects.toMatchObject({ code: 'ADAPTER_ERROR' });
  });

  it('stops for zero, restarts with a raised floor, and prices from /v1/hardware', async () => {
    const f = fixtureHttp();
    const a = new TogetherAdapter(f.http, noSleep);
    const ref = await a.deploy({ deploymentId: 'd', organizationId: 'org', version: { ...s3Version, registryUri: 'together://o/m@id' }, desired: { maxScale: 3 }, providerConfig: { hourlyRateCents: 1 } }, { apiKey: 'tg_valid' });
    expect((await a.costSnapshot(ref, { apiKey: 'tg_valid' })).ratePerHourCents).toBe(399);
    await a.scale(ref, 0, { apiKey: 'tg_valid' });
    expect(f.http.patch.mock.calls[0][1]).toEqual({ state: 'STOPPED' });
    expect((await a.readEndpoint(ref, { apiKey: 'tg_valid' })).state).toBe('stopped');
    expect((await a.costSnapshot(ref, { apiKey: 'tg_valid' })).ratePerHourCents).toBe(0);
    await a.scale(ref, 2, { apiKey: 'tg_valid' });
    expect(f.http.patch.mock.calls[1][1]).toEqual({ autoscaling: { min_replicas: 2, max_replicas: 3 }, state: 'STARTED' });
    expect((await a.readEndpoint(ref, { apiKey: 'tg_valid' })).replicas).toBe(2);
  });

  it('maps every documented endpoint state', async () => {
    const f = fixtureHttp();
    const a = new TogetherAdapter(f.http, noSleep);
    const ref = await a.deploy({ deploymentId: 'd', organizationId: 'org', version: { ...s3Version, registryUri: 'together://o/m@id' }, desired: {}, providerConfig: {} }, { apiKey: 'tg_valid' });
    const ep = f.endpoints.get(ref.endpointId);
    for (const [raw, expected] of Object.entries({ PENDING: 'deploying', STARTING: 'deploying', STARTED: 'ready', STOPPING: 'scaling', STOPPED: 'stopped', ERROR: 'failed' })) {
      ep.state = raw;
      const actual = await a.readEndpoint(ref, { apiKey: 'tg_valid' });
      // The fixture flips PENDING to STARTED on read, like an endpoint that came up.
      expect(actual.state).toBe(raw === 'PENDING' ? 'ready' : expected);
    }
  });
});
