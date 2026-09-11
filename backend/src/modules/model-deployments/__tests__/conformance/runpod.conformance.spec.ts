import { RunPodAdapter } from '../../adapters/runpod.adapter';
import { liveRequested, runConformance } from './conformance.suite';

/**
 * Fixture mode: an in-memory stand-in for the RunPod REST control plane
 * (rest.runpod.io/v1 templates and endpoints) and the data-plane health
 * route, faithful to the documented paths, bodies and status codes. Live
 * mode (CONFORMANCE_LIVE=runpod with RUNPOD_API_KEY in the local
 * environment) runs the same cases against a real account; never in CI.
 */
function fixtureHttp() {
  const templates = new Map<string, any>();
  const endpoints = new Map<string, any>();
  let seq = 0;
  const error = (status: number, message: string) => Object.assign(new Error(String(status)), { response: { status, data: { error: message } } });
  const authed = (config: any) => {
    if ((config?.headers?.Authorization ?? '') !== 'Bearer rp_valid') throw error(401, 'Unauthorized');
  };
  const rest = (url: string) => url.match(/^https:\/\/rest\.runpod\.io\/v1\/(templates|endpoints)(?:\/([^/]+))?$/);
  const health = (url: string) => url.match(/^https:\/\/api\.runpod\.ai\/v2\/([^/]+)\/health$/);
  const http = {
    post: jest.fn(async (url: string, body: any, config: any) => {
      authed(config);
      const m = rest(url);
      if (m?.[1] === 'templates' && !m[2]) {
        const id = `tpl-${++seq}`;
        templates.set(id, { id, ...body });
        return { data: { id } };
      }
      if (m?.[1] === 'endpoints' && !m[2]) {
        if (!templates.has(body.templateId)) throw error(400, 'Invalid template ID');
        if ((body.gpuTypeIds ?? []).includes('NVIDIA H200')) throw error(400, 'Insufficient GPU quota for NVIDIA H200');
        const id = `ep-${++seq}`;
        const ep = { id, ...body, workers: [], createdAt: new Date().toISOString() };
        endpoints.set(id, ep);
        return { data: ep };
      }
      throw error(404, 'not found');
    }),
    get: jest.fn(async (url: string, config: any) => {
      authed(config);
      const h = health(url);
      if (h) {
        const ep = endpoints.get(h[1]);
        if (!ep) throw error(404, 'endpoint not found');
        // Active workers are up on the first health read, like a real endpoint that finished booting.
        return { data: { jobs: { completed: 0, failed: 0, inProgress: 0, inQueue: 0, retried: 0 }, workers: { idle: ep.workersMin, running: 0 } } };
      }
      const m = rest(url);
      if (m?.[1] === 'endpoints' && m[2]) {
        const ep = endpoints.get(m[2]);
        if (!ep) throw error(404, 'Endpoint not found');
        return { data: ep };
      }
      throw error(404, 'not found');
    }),
    patch: jest.fn(async (url: string, body: any, config: any) => {
      authed(config);
      const m = rest(url);
      const ep = m?.[1] === 'endpoints' && m[2] ? endpoints.get(m[2]) : undefined;
      if (!ep) throw error(404, 'Endpoint not found');
      Object.assign(ep, body);
      return { data: ep };
    }),
    delete: jest.fn(async (url: string, config: any) => {
      authed(config);
      const m = rest(url);
      if (m?.[1] === 'endpoints' && m[2]) {
        if (!endpoints.delete(m[2])) throw error(400, 'Invalid endpoint ID.');
        return { status: 204, data: '' };
      }
      if (m?.[1] === 'templates' && m[2]) {
        if (!templates.delete(m[2])) throw error(400, 'Invalid template ID.');
        return { status: 204, data: '' };
      }
      throw error(404, 'not found');
    }),
  } as any;
  return { templates, endpoints, http };
}

const live = liveRequested('runpod');
const fixture = fixtureHttp();
const adapter = () => (live ? new RunPodAdapter() : new RunPodAdapter(fixture.http));
const tiny = { id: 'v1', name: 'qwen3-0.6b', registryUri: 'hf://Qwen/Qwen3-0.6B@main', base: 'qwen3-0.6b', quantizations: [], manifestSha: 'sha' };

runConformance(live ? 'runpod (LIVE)' : 'runpod (fixture)', {
  adapter,
  credentials: live ? { apiKey: process.env.RUNPOD_API_KEY } : { apiKey: 'rp_valid' },
  badCredentials: { apiKey: 'rp_expired' },
  tinyVersion: tiny,
  providerConfig: { gpuTypeId: 'NVIDIA RTX A5000', hourlyRateCents: 22 },
  quotaExceededConfig: live ? undefined : { gpuTypeId: 'NVIDIA H200' },
  vanish: live ? undefined : (_a, ref) => { fixture.endpoints.delete(ref.endpointId); },
  chat: live ? undefined : async () => 'fixture reply',
  readyTimeoutMs: live ? 15 * 60_000 : 5_000,
});

describe('runpod request shape', () => {
  const request = {
    deploymentId: 'abc-123',
    organizationId: 'org',
    version: { id: 'v', name: 'q', registryUri: 'hf://Qwen/Qwen3-0.6B@abc123', base: 'qwen3-0.6b', quantizations: [], manifestSha: 's' },
    desired: { replicas: 1, minScale: 1, maxScale: 3, region: 'EU-RO-1', hardware: 'NVIDIA A40', quantization: 'awq' },
    providerConfig: { containerDiskInGb: 80, maxModelLen: 4096, idleTimeout: 30 },
  };
  const creds = { apiKey: 'rp_valid', hfToken: 'hf_x' };

  it('creates a serverless template that names a Hub repository and an endpoint with GPU type and worker bounds', async () => {
    const f = fixtureHttp();
    const a = new RunPodAdapter(f.http);
    const ref = await a.deploy(request, creds);
    const [templateCall, endpointCall] = f.http.post.mock.calls;
    expect(templateCall[0]).toBe('https://rest.runpod.io/v1/templates');
    expect(templateCall[1]).toEqual({
      name: 'almyty-abc123',
      imageName: 'runpod/worker-v1-vllm:stable-cuda12.1.0',
      isServerless: true,
      env: {
        OPENAI_SERVED_MODEL_NAME_OVERRIDE: 'q',
        QUANTIZATION: 'awq',
        MAX_MODEL_LEN: '4096',
        MODEL_NAME: 'Qwen/Qwen3-0.6B',
        MODEL_REVISION: 'abc123',
        HF_TOKEN: 'hf_x',
      },
      containerDiskInGb: 80,
      ports: [],
    });
    // RunPod pulls the weights from the Hub; nothing of ours goes with it.
    expect(JSON.stringify(templateCall[1])).not.toContain('AWS_');
    expect(JSON.stringify(templateCall[1])).not.toContain('ALMYTY_REGISTRY');
    expect(endpointCall[0]).toBe('https://rest.runpod.io/v1/endpoints');
    expect(endpointCall[1]).toEqual({
      name: 'almyty-abc123',
      templateId: ref.templateId,
      computeType: 'GPU',
      gpuTypeIds: ['NVIDIA A40'],
      gpuCount: 1,
      workersMin: 1,
      workersMax: 3,
      idleTimeout: 30,
      scalerType: 'QUEUE_DELAY',
      scalerValue: 4,
      flashboot: true,
      dataCenterIds: ['EU-RO-1'],
    });
    expect(ref.url).toBe(`https://api.runpod.ai/v2/${ref.endpointId}/openai/v1`);
    expect(JSON.stringify(ref)).not.toContain('hf_x');
  });

  it('defaults the revision to main and leaves the token out when there is none', async () => {
    const f = fixtureHttp();
    const a = new RunPodAdapter(f.http);
    await a.deploy({ ...request, version: { ...request.version, registryUri: 'hf://Qwen/Qwen3-0.6B' }, desired: {}, providerConfig: {} }, { apiKey: 'rp_valid' });
    expect(f.http.post.mock.calls[0][1].env).toEqual({ OPENAI_SERVED_MODEL_NAME_OVERRIDE: 'q', MODEL_NAME: 'Qwen/Qwen3-0.6B', MODEL_REVISION: 'main' });
    expect(f.http.post.mock.calls[1][1]).toMatchObject({ workersMin: 0, workersMax: 1 });
  });

  it('refuses a registry source the worker cannot read, before creating anything', async () => {
    const f = fixtureHttp();
    const a = new RunPodAdapter(f.http);
    await expect(
      a.deploy({ ...request, version: { ...request.version, registryUri: 's3://registry/models/q@etag' } }, creds),
    ).rejects.toMatchObject({ code: 'ADAPTER_UNSUPPORTED_SOURCE', message: expect.stringContaining('hf://org/repo') });
    expect(f.http.post).not.toHaveBeenCalled();
    expect(f.templates.size).toBe(0);
  });

  it('scales by patching worker bounds and tears down endpoint then template', async () => {
    const f = fixtureHttp();
    const a = new RunPodAdapter(f.http);
    const ref = await a.deploy(request, creds);
    expect(await a.readEndpoint(ref, creds)).toMatchObject({ state: 'ready', replicas: 1, hardware: 'NVIDIA A40', region: 'EU-RO-1' });
    expect((await a.costSnapshot(ref, creds)).ratePerHourCents).toBe(0);

    await a.scale(ref, 2, creds);
    expect(f.http.patch.mock.calls[0][1]).toEqual({ workersMin: 2, workersMax: 3 });
    await a.scale(ref, 0, creds);
    expect(f.http.patch.mock.calls[1][1]).toEqual({ workersMin: 0, workersMax: 0 });
    expect((await a.readEndpoint(ref, creds)).state).toBe('stopped');

    await a.teardown(ref, creds);
    const deletes = f.http.delete.mock.calls.map((c) => c[0]);
    expect(deletes).toEqual([`https://rest.runpod.io/v1/endpoints/${ref.endpointId}`, `https://rest.runpod.io/v1/templates/${ref.templateId}`]);
    expect(f.templates.size).toBe(0);
  });

  it('removes the template when endpoint creation fails', async () => {
    const f = fixtureHttp();
    const a = new RunPodAdapter(f.http);
    await expect(a.deploy({ ...request, providerConfig: { gpuTypeId: 'NVIDIA H200' }, desired: {} }, creds)).rejects.toMatchObject({ code: 'ADAPTER_QUOTA_EXCEEDED' });
    expect(f.templates.size).toBe(0);
  });
});
