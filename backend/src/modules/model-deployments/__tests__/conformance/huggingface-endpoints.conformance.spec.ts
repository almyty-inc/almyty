import { HuggingFaceEndpointsAdapter } from '../../adapters/huggingface-endpoints.adapter';
import { liveRequested, runConformance } from './conformance.suite';

/**
 * Fixture mode: an in-memory stand-in for the Inference Endpoints API,
 * faithful to the documented paths, states and error codes. Live mode
 * (CONFORMANCE_LIVE=huggingface-endpoints, HF_TOKEN + HF_NAMESPACE in the
 * local environment) runs the same cases against a real account and is
 * never run in CI.
 */
function fixtureHttp() {
  const endpoints = new Map<string, any>();
  const authed = (config: any) => {
    const auth = config?.headers?.Authorization ?? '';
    if (auth !== 'Bearer hf_valid') {
      throw Object.assign(new Error('401'), { response: { status: 401, data: { error: 'Invalid credentials in Authorization header' } } });
    }
  };
  const parse = (url: string) => {
    const m = url.match(/\/v2\/endpoint\/([^/]+)(?:\/([^/]+))?(?:\/(pause|resume|scale-to-zero))?$/);
    return { namespace: m?.[1], name: m?.[2], action: m?.[3] };
  };
  const notFound = () => Object.assign(new Error('404'), { response: { status: 404, data: { error: 'not found' } } });
  return {
    endpoints,
    http: {
      post: jest.fn(async (url: string, body: any, config: any) => {
        authed(config);
        const { name, action } = parse(url);
        if (!name) {
          if (body?.compute?.instanceType === 'nvidia-h100-x8') {
            throw Object.assign(new Error('402'), { response: { status: 402, data: { error: 'Quota exceeded for instance type' } } });
          }
          const ep = { ...body, status: { state: 'initializing', url: `https://${body.name}.endpoints.huggingface.cloud`, readyReplica: 0, targetReplica: 1 } };
          endpoints.set(body.name, ep);
          return { data: ep };
        }
        const ep = endpoints.get(name);
        if (!ep) throw notFound();
        if (action === 'scale-to-zero') ep.status = { ...ep.status, state: 'scaledToZero', readyReplica: 0, targetReplica: 0 };
        if (action === 'resume') ep.status = { ...ep.status, state: 'running', readyReplica: ep.compute.scaling.minReplica || 1 };
        if (action === 'pause') ep.status = { ...ep.status, state: 'paused', readyReplica: 0 };
        return { data: ep };
      }),
      get: jest.fn(async (url: string, config: any) => {
        authed(config);
        const { name } = parse(url);
        const ep = endpoints.get(name!);
        if (!ep) throw notFound();
        // The fixture becomes ready on the first read after creation.
        if (ep.status.state === 'initializing') ep.status = { ...ep.status, state: 'running', readyReplica: 1 };
        return { data: ep };
      }),
      put: jest.fn(async (url: string, body: any, config: any) => {
        authed(config);
        const { name } = parse(url);
        const ep = endpoints.get(name!);
        if (!ep) throw notFound();
        ep.compute = { ...ep.compute, scaling: { ...ep.compute.scaling, ...body.compute.scaling } };
        ep.status = { ...ep.status, state: 'updating' };
        return { data: ep };
      }),
      delete: jest.fn(async (url: string, config: any) => {
        authed(config);
        const { name } = parse(url);
        if (!endpoints.delete(name!)) throw notFound();
        return { data: {} };
      }),
    } as any,
  };
}

const live = liveRequested('huggingface-endpoints');
const fixture = fixtureHttp();
const adapter = () => (live ? new HuggingFaceEndpointsAdapter() : new HuggingFaceEndpointsAdapter(fixture.http));

runConformance(live ? 'huggingface-endpoints (LIVE)' : 'huggingface-endpoints (fixture)', {
  adapter,
  credentials: live ? { token: process.env.HF_TOKEN } : { token: 'hf_valid' },
  badCredentials: { token: 'hf_expired' },
  tinyVersion: { id: 'v1', name: 'qwen3-0.6b', registryUri: 'hf://Qwen/Qwen3-0.6B@main', base: 'qwen3-0.6b', quantizations: [], manifestSha: 'sha' },
  providerConfig: { token: live ? process.env.HF_TOKEN : 'hf_valid', namespace: live ? process.env.HF_NAMESPACE : 'almyty-test', instanceType: 'nvidia-t4', hourlyRateCents: 60 },
  quotaExceededConfig: live ? undefined : { token: 'hf_valid', namespace: 'almyty-test', instanceType: 'nvidia-h100-x8' },
  vanish: live ? undefined : (_adapter, ref) => { fixture.endpoints.delete(ref.name); },
  chat: live ? undefined : async () => 'fixture reply',
  readyTimeoutMs: live ? 15 * 60_000 : 5_000,
});

describe('huggingface-endpoints request shape', () => {
  it('serves an S3 registry version through the vLLM image with the registry in env and its keys as secrets', async () => {
    const f = fixtureHttp();
    const a = new HuggingFaceEndpointsAdapter(f.http);
    await a.deploy(
      {
        deploymentId: 'abc-123',
        organizationId: 'org',
        version: { id: 'v', name: 'q', registryUri: 's3://registry/models/q@etag', base: 'qwen3-0.6b', quantizations: [], manifestSha: 's' },
        desired: { replicas: 1, minScale: 0, maxScale: 2, region: 'eu-west-1' },
        providerConfig: { namespace: 'ns', registryEndpoint: 'https://minio.local' },
      },
      { token: 'hf_valid', registryAccessKeyId: 'AK', registrySecretAccessKey: 'SK' },
    );
    const body = f.http.post.mock.calls[0][1];
    expect(f.http.post.mock.calls[0][0]).toBe('https://api.endpoints.huggingface.cloud/v2/endpoint/ns');
    expect(body.name).toBe('almyty-abc123');
    expect(body.provider).toEqual({ vendor: 'aws', region: 'eu-west-1' });
    expect(body.compute.scaling).toEqual({ minReplica: 0, maxReplica: 2, scaleToZeroTimeout: 15 });
    expect(body.model.framework).toBe('custom');
    expect(body.model.image.custom.env).toMatchObject({ ALMYTY_REGISTRY_URI: 's3://registry/models/q@etag', AWS_ENDPOINT_URL: 'https://minio.local' });
    expect(body.model.image.custom.secrets).toEqual({ AWS_ACCESS_KEY_ID: 'AK', AWS_SECRET_ACCESS_KEY: 'SK' });
    // Nothing secret in the request outside the secrets block.
    expect(JSON.stringify(body.model.image.custom.env)).not.toContain('SK');
  });

  it('serves a hub version by repository and revision, with no registry secrets', async () => {
    const f = fixtureHttp();
    const a = new HuggingFaceEndpointsAdapter(f.http);
    await a.deploy(
      { deploymentId: 'd', organizationId: 'org', version: { id: 'v', name: 'q', registryUri: 'hf://Qwen/Qwen3-0.6B@abc123', base: 'qwen3', quantizations: [], manifestSha: 's' }, desired: {}, providerConfig: { namespace: 'ns' } },
      { token: 'hf_valid' },
    );
    const body = f.http.post.mock.calls[0][1];
    expect(body.model.repository).toBe('Qwen/Qwen3-0.6B');
    expect(body.model.revision).toBe('abc123');
    expect(body.model.image.custom.secrets).toEqual({});
  });

  it('maps every documented state', async () => {
    const f = fixtureHttp();
    const a = new HuggingFaceEndpointsAdapter(f.http);
    const ref = await a.deploy({ deploymentId: 'd', organizationId: 'org', version: { id: 'v', name: 'q', registryUri: 'hf://Qwen/Qwen3-0.6B@x', base: 'q', quantizations: [], manifestSha: 's' }, desired: {}, providerConfig: { namespace: 'ns' } }, { token: 'hf_valid' });
    const ep = f.endpoints.get(ref.name);
    for (const [raw, expected] of Object.entries({ pending: 'deploying', initializing: 'deploying', updating: 'scaling', updateFailed: 'failed', running: 'ready', paused: 'stopped', scaledToZero: 'stopped', failed: 'failed' })) {
      ep.status.state = raw;
      const actual = await a.readEndpoint(ref, { token: 'hf_valid' });
      // The fixture flips initializing to running on read, like a real endpoint that came up.
      expect(actual.state).toBe(raw === 'initializing' ? 'ready' : expected);
    }
  });
});
