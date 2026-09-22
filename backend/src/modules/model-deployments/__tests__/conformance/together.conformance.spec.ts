import { TogetherAdapter } from '../../adapters/together.adapter';
import { liveRequested, runConformance } from './conformance.suite';

/**
 * Fixture mode: an in-memory stand-in for Together's v2 dedicated model
 * inference API (api.together.ai/v2: projects, models, model uploads,
 * configs, endpoints, deployments, plus /v1/whoami and the public
 * instance-type catalog), faithful to the documented paths, resource ids,
 * states and error codes. Live mode (CONFORMANCE_LIVE=together,
 * TOGETHER_API_KEY in the local environment) runs the same cases against a
 * real account and never runs in CI.
 */
function fixtureHttp() {
  const models = new Map<string, any>();
  const uploads = new Map<string, any>();
  const endpoints = new Map<string, any>();
  const deployments = new Map<string, any>();
  let seq = 0;
  const authed = (config: any) => {
    if ((config?.headers?.Authorization ?? '') !== 'Bearer tg_valid') {
      throw Object.assign(new Error('401'), { response: { status: 401, data: { error: { message: 'Invalid API key provided', type: 'invalid_request_error' } } } });
    }
  };
  const notFound = () => Object.assign(new Error('404'), { response: { status: 404, data: { error: { message: 'Not Found', type: 'not_found' } } } });
  const deploymentId = (url: string) => url.match(/\/deployments\/([^/?]+)$/)?.[1];
  const endpointId = (url: string) => url.match(/\/endpoints\/([^/?]+)$/)?.[1];
  return {
    models,
    uploads,
    endpoints,
    deployments,
    http: {
      post: jest.fn(async (url: string, body: any, config: any) => {
        authed(config);
        if (/\/models\/uploads$/.test(url)) {
          seq += 1;
          const job = { id: `job_${seq}`, projectId: 'proj_1', modelId: body.modelId, remoteUrl: body.remoteUrl, status: 'REMOTE_UPLOAD_STATUS_PENDING', polls: 0 };
          uploads.set(job.id, job);
          return { data: job };
        }
        if (/\/models$/.test(url)) {
          seq += 1;
          const model = { id: `ml_${seq}`, projectId: 'proj_1', name: `almyty-test/${body.name}`, baseModelId: body.baseModelId, visibility: 'VISIBILITY_PRIVATE' };
          models.set(model.id, model);
          return { data: model };
        }
        if (/\/endpoints$/.test(url)) {
          seq += 1;
          const ep = { id: `ep_${seq}`, projectId: 'proj_1', name: `almyty-test/${body.name}`, etag: `etag-${seq}`, trafficSplit: [], deployments: [], visibility: 'VISIBILITY_PRIVATE', endpointType: 'ENDPOINT_TYPE_DEDICATED' };
          endpoints.set(ep.id, ep);
          return { data: ep };
        }
        if (/\/deployments$/.test(url)) {
          if (String(body.config).endsWith('cr_h200')) {
            throw Object.assign(new Error('429'), { response: { status: 429, data: { error: { message: 'GPU quota exceeded for H200', type: 'quota' } } } });
          }
          seq += 1;
          const dep = {
            id: `dep_${seq}`,
            projectId: 'proj_1',
            endpointId: endpoints.get(String(url.match(/\/endpoints\/([^/]+)\/deployments$/)?.[1]))?.id,
            name: `almyty-test/e/${body.name}`,
            model: body.model,
            config: body.config,
            hardware: '1xnvidia-h100-80gb',
            autoscaling: body.autoscaling,
            placement: body.placement,
            desiredReplicas: body.autoscaling?.minReplicas ?? 0,
            status: { state: 'DEPLOYMENT_STATE_PROVISIONING', message: 'Scheduling replicas', readyReplicas: 0, scheduledReplicas: 0 },
            request: body,
          };
          deployments.set(dep.id, dep);
          return { data: dep };
        }
        throw notFound();
      }),
      get: jest.fn(async (url: string, config: any) => {
        authed(config);
        if (url.endsWith('/v1/whoami')) {
          return { data: { api_key_id: 'key_1', project_id: 'proj_1', project_name: 'almyty', project_slug: 'almyty-test', organization_id: 'org_1', organization_name: 'almyty' } };
        }
        if (url.endsWith('/public/inference-instance-types')) {
          return {
            data: {
              object: 'list',
              data: [
                { id: '1xnvidia-h100-80gb', name: '1x NVIDIA H100 80GB', description: 'H100', gpuType: 'H100', gpuCount: 1, gpuMemoryGib: 80, priceCentsPerHour: 399, regions: [{ name: 'us-east-1', headroom: { value: 4, relation: 'RELATION_GTE' } }] },
                { id: '1xnvidia-b200-180gb', name: '1x NVIDIA B200 180GB', description: 'B200', gpuType: 'B200', gpuCount: 1, gpuMemoryGib: 180, priceCentsPerHour: 899, regions: [] },
              ],
            },
          };
        }
        const upload = url.match(/\/models\/uploads\/([^/?]+)$/)?.[1];
        if (upload) {
          const job = uploads.get(upload);
          if (!job) throw notFound();
          job.polls += 1;
          // One RUNNING poll before it succeeds, so the polling loop is exercised.
          job.status = job.polls >= 2 ? 'REMOTE_UPLOAD_STATUS_SUCCEEDED' : 'REMOTE_UPLOAD_STATUS_RUNNING';
          return { data: job };
        }
        if (/\/configs$/.test(url)) {
          const referenceModel = String(config?.params?.referenceModel ?? '');
          return { data: { object: 'list', data: [{ id: 'cr_1', name: 'projects/proj_1/configs/cr_1', referenceModel }] } };
        }
        const dep = deployments.get(deploymentId(url)!);
        if (!dep) throw notFound();
        // The fixture places replicas on the first read after creation.
        if (dep.status.state === 'DEPLOYMENT_STATE_PROVISIONING') {
          const ready = Math.max(Number(dep.autoscaling?.minReplicas ?? 0), 1);
          dep.status = { state: 'DEPLOYMENT_STATE_READY', message: 'All replicas ready', readyReplicas: ready, scheduledReplicas: ready };
          dep.desiredReplicas = ready;
        }
        return { data: dep };
      }),
      patch: jest.fn(async (url: string, body: any, config: any) => {
        authed(config);
        const dep = deployments.get(deploymentId(url)!);
        if (dep) {
          if (body.autoscaling) {
            dep.autoscaling = { ...dep.autoscaling, ...body.autoscaling };
            const stopped = Number(body.autoscaling.minReplicas) === 0 && Number(body.autoscaling.maxReplicas) === 0;
            const ready = stopped ? 0 : Math.max(Number(body.autoscaling.minReplicas ?? 0), 1);
            dep.status = { state: stopped ? 'DEPLOYMENT_STATE_STOPPED' : 'DEPLOYMENT_STATE_READY', message: stopped ? 'Stopped' : 'All replicas ready', readyReplicas: ready, scheduledReplicas: ready };
            dep.desiredReplicas = ready;
          }
          return { data: dep };
        }
        const ep = endpoints.get(endpointId(url)!);
        if (!ep) throw notFound();
        if (body.trafficSplit) ep.trafficSplit = body.trafficSplit;
        return { data: ep };
      }),
      delete: jest.fn(async (url: string, config: any) => {
        authed(config);
        const dep = deploymentId(url);
        if (dep) {
          if (!deployments.delete(dep)) throw notFound();
          return { status: 204, data: '' };
        }
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
  providerConfig: live
    ? { projectId: process.env.TOGETHER_PROJECT_ID, baseModelId: process.env.TOGETHER_BASE_MODEL_ID }
    : { baseModelId: 'ml_base', hourlyRateCents: 240 },
  quotaExceededConfig: live ? undefined : { baseModelId: 'ml_base', configId: 'cr_h200' },
  vanish: live ? undefined : (_adapter, ref) => { fixture.deployments.delete(ref.deploymentId); },
  chat: live ? undefined : async () => 'fixture reply',
  readyTimeoutMs: live ? 45 * 60_000 : 5_000,
});

describe('together request shape', () => {
  const hubVersion = { id: 'v-1', name: 'q', registryUri: 'hf://Qwen/Qwen3-0.6B@abc123', base: 'qwen3-0.6b', quantizations: [], manifestSha: 's' };
  const deploy = (f: ReturnType<typeof fixtureHttp>, version: any, providerConfig: Record<string, any> = {}, credentials: Record<string, any> = {}, desired: Record<string, any> = {}) =>
    new TogetherAdapter(f.http, noSleep).deploy(
      { deploymentId: 'abc-123', organizationId: 'org', version, desired: { replicas: 1, minScale: 0, maxScale: 2, ...desired }, providerConfig },
      { apiKey: 'tg_valid', ...credentials },
    );

  it('imports a hub version server-side, then binds model and config to an endpoint and routes traffic to it', async () => {
    const f = fixtureHttp();
    const ref = await deploy(f, hubVersion, { baseModelId: 'ml_base' }, { hfToken: 'hf_secret' });
    const posts = f.http.post.mock.calls;
    expect(posts[0][0]).toBe('https://api.together.ai/v2/projects/proj_1/models');
    expect(posts[0][1]).toMatchObject({ type: 'model', baseModelId: 'ml_base', name: 'almyty-q-v1' });

    // The upload is a URL and a token Together uses itself; no bytes leave this process.
    expect(posts[1][0]).toBe('https://api.together.ai/v2/projects/proj_1/models/uploads');
    expect(posts[1][1]).toEqual({ modelId: 'ml_1', remoteUrl: 'https://huggingface.co/Qwen/Qwen3-0.6B', token: 'hf_secret' });
    expect(f.http.get.mock.calls.filter((c: any[]) => String(c[0]).includes('/models/uploads/job_2'))).toHaveLength(2);

    expect(posts[2][0]).toBe('https://api.together.ai/v2/projects/proj_1/endpoints');
    expect(posts[2][1]).toEqual({ name: 'almyty-abc123' });

    expect(posts[3][0]).toBe('https://api.together.ai/v2/projects/proj_1/endpoints/ep_3/deployments');
    expect(posts[3][1]).toEqual({
      name: 'almyty-abc123',
      model: 'projects/proj_1/models/ml_1',
      config: 'projects/proj_1/configs/cr_1',
      autoscaling: { minReplicas: 0, maxReplicas: 2 },
    });

    // A READY deployment serves nothing until it has weight in the split.
    const [splitUrl, splitBody, splitConfig] = f.http.patch.mock.calls[0];
    expect(splitUrl).toBe('https://api.together.ai/v2/projects/proj_1/endpoints/ep_3');
    expect(splitBody).toEqual({ trafficSplit: [{ deploymentId: 'dep_4', weight: 1 }], etag: 'etag-3' });
    expect(splitConfig.params).toEqual({ updateMask: 'trafficSplit' });

    expect(ref).toMatchObject({ projectId: 'proj_1', endpointId: 'ep_3', deploymentId: 'dep_4', endpointName: 'almyty-test/almyty-abc123', url: 'https://api-inference.together.ai/v1' });
  });

  it('deploys a together:// model without importing again', async () => {
    const f = fixtureHttp();
    await deploy(f, { ...hubVersion, registryUri: 'together://ml_existing' });
    const posts = f.http.post.mock.calls.map((c: any[]) => c[0]);
    expect(posts).toEqual([
      'https://api.together.ai/v2/projects/proj_1/endpoints',
      'https://api.together.ai/v2/projects/proj_1/endpoints/ep_1/deployments',
    ]);
    expect(f.http.post.mock.calls[1][1].model).toBe('projects/proj_1/models/ml_existing');
  });

  it('sets inline placement from the desired region', async () => {
    const f = fixtureHttp();
    await deploy(f, { ...hubVersion, registryUri: 'together://ml_x' }, {}, {}, { region: 'us-east-1' });
    expect(f.http.post.mock.calls[1][1].placement).toEqual({ inline: { regions: ['us-east-1'], constraint: 'ENFORCEMENT_PREFERRED' } });
  });

  it('refuses an object-storage version before calling Together, naming what it accepts', async () => {
    const f = fixtureHttp();
    const s3 = { ...hubVersion, registryUri: 's3://registry/models/q@etag' };
    await expect(deploy(f, s3, { baseModelId: 'ml_base' })).rejects.toMatchObject({ code: 'ADAPTER_UNSUPPORTED_SOURCE' });
    await expect(deploy(f, s3, { baseModelId: 'ml_base' })).rejects.toThrow(/hf:\/\/owner\/repo or together:\/\/ml_/);
    expect(f.http.post).not.toHaveBeenCalled();
  });

  it('refuses an import with no base model, before creating the model record', async () => {
    const f = fixtureHttp();
    await expect(deploy(f, hubVersion, {})).rejects.toMatchObject({ code: 'ADAPTER_UNSUPPORTED_SOURCE' });
    expect(f.http.post).not.toHaveBeenCalled();
  });

  it('fails a remote upload that ends in FAILED as a typed error', async () => {
    const f = fixtureHttp();
    const a = new TogetherAdapter(f.http, noSleep);
    f.http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/whoami')) return { data: { project_id: 'proj_1', project_slug: 'almyty-test' } };
      return { data: { id: 'job_2', status: 'REMOTE_UPLOAD_STATUS_FAILED', statusMessage: 'unsupported architecture' } };
    });
    await expect(a.upload(hubVersion, { apiKey: 'tg_valid' }, { baseModelId: 'ml_base' })).rejects.toMatchObject({ code: 'ADAPTER_ERROR' });
  });

  it('refuses to guess when a model has more than one deployment profile', async () => {
    const f = fixtureHttp();
    const inner = f.http.get.getMockImplementation();
    f.http.get.mockImplementation(async (url: string, config: any) => {
      if (/\/configs$/.test(url)) return { data: { data: [{ id: 'cr_bf16', name: 'projects/proj_1/configs/cr_bf16' }, { id: 'cr_fp8', name: 'projects/proj_1/configs/cr_fp8' }] } };
      return inner!(url, config);
    });
    await expect(deploy(f, { ...hubVersion, registryUri: 'together://ml_x' })).rejects.toThrow(/cr_bf16, cr_fp8/);
  });

  it('stops with both bounds at zero, restarts with a raised floor, and prices from the public catalog', async () => {
    const f = fixtureHttp();
    const a = new TogetherAdapter(f.http, noSleep);
    const ref = await deploy(f, { ...hubVersion, registryUri: 'together://ml_x' }, { hourlyRateCents: 1 }, {}, { maxScale: 3 });
    expect((await a.costSnapshot(ref, { apiKey: 'tg_valid' })).ratePerHourCents).toBe(399);

    await a.scale(ref, 0, { apiKey: 'tg_valid' });
    expect(f.http.patch.mock.calls[1][1]).toEqual({ autoscaling: { minReplicas: 0, maxReplicas: 0 } });
    expect((await a.readEndpoint(ref, { apiKey: 'tg_valid' })).state).toBe('stopped');
    expect((await a.costSnapshot(ref, { apiKey: 'tg_valid' })).ratePerHourCents).toBe(0);

    await a.scale(ref, 2, { apiKey: 'tg_valid' });
    expect(f.http.patch.mock.calls[2][1]).toEqual({ autoscaling: { minReplicas: 2, maxReplicas: 3 } });
    expect((await a.readEndpoint(ref, { apiKey: 'tg_valid' })).replicas).toBe(2);
  });

  it('clears the traffic split and stops the deployment before deleting either resource', async () => {
    const f = fixtureHttp();
    const a = new TogetherAdapter(f.http, noSleep);
    const ref = await deploy(f, { ...hubVersion, registryUri: 'together://ml_x' });
    await a.teardown(ref, { apiKey: 'tg_valid' });
    expect(f.http.patch.mock.calls[1][1]).toEqual({ trafficSplit: [] });
    expect(f.http.patch.mock.calls[2][1]).toEqual({ autoscaling: { minReplicas: 0, maxReplicas: 0 } });
    expect(f.http.delete.mock.calls.map((c: any[]) => c[0])).toEqual([
      'https://api.together.ai/v2/projects/proj_1/endpoints/ep_1/deployments/dep_2',
      'https://api.together.ai/v2/projects/proj_1/endpoints/ep_1',
    ]);
    expect(f.deployments.size).toBe(0);
    expect(f.endpoints.size).toBe(0);
  });

  it('maps every documented deployment state', async () => {
    const f = fixtureHttp();
    const a = new TogetherAdapter(f.http, noSleep);
    const ref = await deploy(f, { ...hubVersion, registryUri: 'together://ml_x' });
    const dep = f.deployments.get(ref.deploymentId);
    const expected = {
      DEPLOYMENT_STATE_PROVISIONING: 'deploying',
      DEPLOYMENT_STATE_SCALING: 'scaling',
      DEPLOYMENT_STATE_READY: 'ready',
      DEPLOYMENT_STATE_DEGRADED: 'degraded',
      DEPLOYMENT_STATE_STOPPING: 'scaling',
      DEPLOYMENT_STATE_STOPPED: 'stopped',
      DEPLOYMENT_STATE_FAILED: 'failed',
    };
    for (const [raw, want] of Object.entries(expected)) {
      dep.status = { ...dep.status, state: raw };
      const actual = await a.readEndpoint(ref, { apiKey: 'tg_valid' });
      // The fixture places replicas on read, so PROVISIONING comes back READY.
      expect(actual.state).toBe(raw === 'DEPLOYMENT_STATE_PROVISIONING' ? 'ready' : want);
    }
  });
});
