import { NebiusAdapter } from '../../adapters/nebius.adapter';
import { liveRequested, runConformance } from './conformance.suite';

/**
 * Fixture mode: an in-memory stand-in for the Nebius Token Factory
 * dedicated endpoint control plane, faithful to the documented request
 * bodies, the DeploymentStatus and DeploymentReadiness enums and the error
 * envelope. Live mode (CONFORMANCE_LIVE=nebius with NEBIUS_API_TOKEN in
 * the local environment) runs the same cases against a real workspace;
 * never in CI.
 */
function fixtureHttp() {
  const endpoints = new Map<string, any>();
  let seq = 0;
  const error = (status: number, detail: string) => Object.assign(new Error(String(status)), { response: { status, data: { detail } } });
  const authed = (config: any) => {
    if ((config?.headers?.Authorization ?? '') !== 'Bearer nb_valid') throw error(401, 'Invalid API key');
  };
  const route = (url: string) => url.match(/^https:\/\/api\.tokenfactory\.nebius\.com\/v0\/dedicated_endpoints(?:\/([^/]+))?$/);
  const http = {
    post: jest.fn(async (url: string, body: any, config: any) => {
      authed(config);
      const m = route(url);
      if (!m || m[1]) throw error(404, 'not found');
      if (String(body.model_name).includes('unsupported')) throw error(400, `unknown model ${body.model_name}`);
      if (String(body.gpu_type) === 'gpu-b300-sxm') throw error(429, 'no capacity for gpu-b300-sxm in this region');
      const id = `de-${++seq}`;
      const endpoint = {
        ...body,
        id,
        enabled: true,
        created_at: new Date().toISOString(),
        deployment: { status: 'starting', readiness: 'not_ready', ready_replicas: 0 },
      };
      endpoints.set(id, endpoint);
      return { status: 201, data: { endpoint } };
    }),
    get: jest.fn(async (url: string, config: any) => {
      authed(config);
      const m = route(url);
      const endpoint = m?.[1] ? endpoints.get(m[1]) : undefined;
      if (!endpoint) throw error(404, 'dedicated endpoint not found');
      // Provisioning completes on the first read, like an endpoint that
      // finished coming up.
      if (endpoint.enabled && endpoint.deployment.status === 'starting') {
        endpoint.deployment = { status: 'running', readiness: 'ready', ready_replicas: endpoint.scaling.min_replicas };
      }
      return { data: { endpoint } };
    }),
    patch: jest.fn(async (url: string, body: any, config: any) => {
      authed(config);
      const m = route(url);
      const endpoint = m?.[1] ? endpoints.get(m[1]) : undefined;
      if (!endpoint) throw error(404, 'dedicated endpoint not found');
      if (body.enabled === false) {
        endpoint.enabled = false;
        endpoint.deployment = { status: 'stopped', readiness: 'not_ready', ready_replicas: 0 };
      } else {
        if (body.enabled === true) endpoint.enabled = true;
        if (body.scaling) endpoint.scaling = body.scaling;
        if (body.custom_weights_id !== undefined) endpoint.custom_weights_id = body.custom_weights_id;
        endpoint.deployment = { status: 'running', readiness: 'ready', ready_replicas: endpoint.scaling.min_replicas };
      }
      return { data: { endpoint } };
    }),
    delete: jest.fn(async (url: string, config: any) => {
      authed(config);
      const m = route(url);
      if (!m?.[1] || !endpoints.delete(m[1])) throw error(404, 'dedicated endpoint not found');
      return { status: 204, data: '' };
    }),
  } as any;
  return { endpoints, http };
}

const live = liveRequested('nebius');
const fixture = fixtureHttp();
const adapter = () => (live ? new NebiusAdapter() : new NebiusAdapter(fixture.http));
const tiny = { id: 'v1', name: 'qwen3-0.6b', registryUri: 'hf://Qwen/Qwen3-0.6B@main', base: 'qwen3-0.6b', quantizations: [], manifestSha: 'sha' };

runConformance(live ? 'nebius (LIVE)' : 'nebius (fixture)', {
  adapter,
  credentials: live ? { apiToken: process.env.NEBIUS_API_TOKEN } : { apiToken: 'nb_valid' },
  badCredentials: { apiToken: 'nb_expired' },
  tinyVersion: tiny,
  providerConfig: {
    flavorName: live ? process.env.NEBIUS_FLAVOR ?? 'balanced' : 'balanced',
    region: live ? process.env.NEBIUS_REGION ?? 'us-central1' : 'us-central1',
    gpuType: 'gpu-l40s-d',
    hourlyRateCents: 190,
  },
  unsupportedArchitectureVersion: live ? undefined : { ...tiny, id: 'v2', registryUri: 'hf://acme/unsupported-model' },
  quotaExceededConfig: live ? undefined : { flavorName: 'balanced', region: 'us-central1', gpuType: 'gpu-b300-sxm' },
  vanish: live ? undefined : (_a, ref) => { fixture.endpoints.delete(ref.endpointId); },
  chat: live ? undefined : async () => 'fixture reply',
  readyTimeoutMs: live ? 30 * 60_000 : 5_000,
});

describe('nebius request shape', () => {
  const request = {
    deploymentId: 'abc-123',
    organizationId: 'org',
    version: tiny,
    desired: { replicas: 1, minScale: 1, maxScale: 3, region: 'eu-north1', hardware: 'gpu-h200-sxm' },
    providerConfig: { flavorName: 'high-throughput', gpuCount: 2, hourlyRateCents: 190 },
  };
  const creds = { apiToken: 'nb_valid' };

  it('creates a dedicated endpoint from a model template with a routing key of its own', async () => {
    const f = fixtureHttp();
    const a = new NebiusAdapter(f.http);
    const ref = await a.deploy(request, creds);
    const [url, body] = f.http.post.mock.calls[0];
    expect(url).toBe('https://api.tokenfactory.nebius.com/v0/dedicated_endpoints');
    expect(body).toEqual({
      name: 'almyty-abc123',
      description: 'almyty deployment abc-123',
      model_name: 'Qwen/Qwen3-0.6B',
      flavor_name: 'high-throughput',
      gpu_type: 'gpu-h200-sxm',
      gpu_count: 2,
      region: 'eu-north1',
      scaling: { min_replicas: 1, max_replicas: 3 },
      routing_key: 'dedicated/almyty-abc123',
    });
    expect(ref).toMatchObject({ endpointId: expect.stringContaining('de-'), routingKey: 'dedicated/almyty-abc123', url: 'https://api.tokenfactory.eu-north1.nebius.com/v1' });
    // No VM, no disk, no cloud-init, no service-account key exchange.
    expect(JSON.stringify(body)).not.toContain('cloud');
    expect(JSON.stringify(ref)).not.toContain('privateKey');
  });

  it('attaches custom weights Nebius already holds, and never uploads any', async () => {
    const f = fixtureHttp();
    const a = new NebiusAdapter(f.http);
    await a.deploy({ ...request, providerConfig: { ...request.providerConfig, customWeightsId: 'cw-42' } }, creds);
    expect(f.http.post.mock.calls[0][1].custom_weights_id).toBe('cw-42');
  });

  it('refuses a registry source Token Factory cannot read, naming what it accepts', async () => {
    const f = fixtureHttp();
    const a = new NebiusAdapter(f.http);
    await expect(
      a.deploy({ ...request, version: { ...tiny, registryUri: 's3://registry/models/q@etag' } }, creds),
    ).rejects.toMatchObject({ code: 'ADAPTER_UNSUPPORTED_SOURCE', message: expect.stringContaining('hf://org/repo') });
    expect(f.http.post).not.toHaveBeenCalled();
  });

  it('routes on readiness, disables to stop, and reports the routing key as the model', async () => {
    const f = fixtureHttp();
    const a = new NebiusAdapter(f.http);
    const ref = await a.deploy(request, creds);
    const starting = f.endpoints.get(ref.endpointId);
    starting.deployment = { status: 'running', readiness: 'not_ready', ready_replicas: 0 };
    const notReady = await a.readEndpoint(ref, creds);
    expect(notReady.state).toBe('deploying');
    expect(notReady.message).toContain('not ready');

    starting.deployment = { status: 'running', readiness: 'ready', ready_replicas: 1 };
    const ready = await a.readEndpoint(ref, creds);
    expect(ready.state).toBe('ready');
    expect(ready.url).toBe('https://api.tokenfactory.eu-north1.nebius.com/v1');
    expect(ready.openAiBase).toBe(ready.url);
    expect(ready.details?.routingKey).toBe('dedicated/almyty-abc123');
    expect((await a.costSnapshot(ref, creds)).ratePerHourCents).toBe(380);

    await a.scale(ref, 2, creds);
    expect(f.http.patch.mock.calls[0][1]).toEqual({ enabled: true, scaling: { min_replicas: 2, max_replicas: 3 } });

    await a.scale(ref, 0, creds);
    expect(f.http.patch.mock.calls[1][1]).toEqual({ enabled: false });
    const stopped = await a.readEndpoint(ref, creds);
    expect(stopped.state).toBe('stopped');
    expect((await a.costSnapshot(ref, creds)).ratePerHourCents).toBe(0);

    await a.teardown(ref, creds);
    expect((await a.readEndpoint(ref, creds)).state).toBe('missing');
  });

  it('honours a data plane host override for a region whose host differs', async () => {
    const f = fixtureHttp();
    const a = new NebiusAdapter(f.http);
    const ref = await a.deploy({ ...request, providerConfig: { ...request.providerConfig, dataPlaneHost: 'https://api.tokenfactory.tf-uk1.nebius.com/' } }, creds);
    expect(ref.url).toBe('https://api.tokenfactory.tf-uk1.nebius.com/v1');
    expect((await a.readEndpoint(ref, creds)).url).toBe('https://api.tokenfactory.tf-uk1.nebius.com/v1');
  });

  it('maps an unknown model and a capacity refusal to their own error codes', async () => {
    const f = fixtureHttp();
    const a = new NebiusAdapter(f.http);
    await expect(a.deploy({ ...request, version: { ...tiny, registryUri: 'hf://acme/unsupported-model' } }, creds)).rejects.toMatchObject({
      code: 'ADAPTER_UNSUPPORTED_ARCHITECTURE',
    });
    await expect(a.deploy({ ...request, desired: { ...request.desired, hardware: 'gpu-b300-sxm' } }, creds)).rejects.toMatchObject({
      code: 'ADAPTER_QUOTA_EXCEEDED',
    });
  });
});
