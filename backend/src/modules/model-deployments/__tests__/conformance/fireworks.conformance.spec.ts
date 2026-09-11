import { FireworksAdapter } from '../../adapters/fireworks.adapter';
import { liveRequested, runConformance } from './conformance.suite';

/**
 * Fixture mode: an in-memory stand-in for the Fireworks Gateway REST API
 * (api.fireworks.ai/v1/accounts/{account}: models, deployments, :scale,
 * billingUsage:query), faithful to the documented paths, states, gRPC
 * status names and error codes. Live mode (CONFORMANCE_LIVE=fireworks,
 * FIREWORKS_API_KEY + FIREWORKS_ACCOUNT in the local environment) runs the
 * same cases against a real account and never runs in CI.
 */
const ACCOUNT = 'almyty-test';

function fixtureHttp() {
  const models = new Map<string, any>();
  const deployments = new Map<string, any>();
  const authed = (config: any) => {
    if ((config?.headers?.Authorization ?? '') !== 'Bearer fw_valid') {
      throw Object.assign(new Error('401'), { response: { status: 401, data: { status: 'UNAUTHENTICATED', message: 'invalid API key' } } });
    }
  };
  const notFound = () => Object.assign(new Error('404'), { response: { status: 404, data: { status: 'NOT_FOUND', message: 'not found' } } });
  const modelId = (url: string) => url.match(/\/models\/([^/:?]+)$/)?.[1];
  const deploymentId = (url: string) => url.match(/\/deployments\/([^/:?]+)(?::scale)?$/)?.[1];
  return {
    models,
    deployments,
    http: {
      post: jest.fn(async (url: string, body: any, config: any) => {
        authed(config);
        if (url.endsWith(':query')) {
          // Metered GPU-seconds for the filtered deployment: one GPU-hour.
          return { data: { dedicatedCosts: [{ startTime: '2026-09-08T00:00:00Z', endTime: '2026-09-09T00:00:00Z', acceleratorSeconds: 3600, group: { deployment_name: body?.filter?.deployment_name?.values?.[0] } }] } };
        }
        if (url.endsWith('/deployments')) {
          if (body.acceleratorType === 'NVIDIA_B300_288GB') {
            throw Object.assign(new Error('429'), { response: { status: 429, data: { status: 'RESOURCE_EXHAUSTED', message: 'GPU quota exceeded for B300' } } });
          }
          const id = config?.params?.deploymentId;
          const dep = {
            name: `accounts/${ACCOUNT}/deployments/${id}`,
            baseModel: body.baseModel,
            displayName: body.displayName,
            state: 'CREATING',
            acceleratorType: body.acceleratorType ?? 'NVIDIA_H100_80GB',
            acceleratorCount: body.acceleratorCount ?? 1,
            minReplicaCount: body.minReplicaCount,
            maxReplicaCount: body.maxReplicaCount,
            desiredReplicaCount: body.minReplicaCount,
            replicaStats: { readyReplicaCount: 0 },
            placement: body.placement,
            request: body,
          };
          deployments.set(id, dep);
          return { data: dep };
        }
        throw notFound();
      }),
      get: jest.fn(async (url: string, config: any) => {
        authed(config);
        const model = modelId(url);
        if (model && url.includes('/models/')) {
          const m = models.get(model);
          if (!m) throw notFound();
          return { data: m };
        }
        const dep = deployments.get(deploymentId(url)!);
        if (!dep) throw notFound();
        // The fixture brings replicas up on the first read after creation.
        if (dep.state === 'CREATING') {
          dep.state = 'READY';
          dep.replicaStats = { readyReplicaCount: Math.max(Number(dep.minReplicaCount ?? 0), 1) };
        }
        return { data: dep };
      }),
      patch: jest.fn(async (url: string, body: any, config: any) => {
        authed(config);
        const dep = deployments.get(deploymentId(url)!);
        if (!dep) throw notFound();
        if (url.endsWith(':scale')) {
          dep.replicaStats = { readyReplicaCount: Number(body.replicaCount ?? 0) };
          dep.desiredReplicaCount = Number(body.replicaCount ?? 0);
        } else {
          dep.minReplicaCount = body.minReplicaCount;
          dep.maxReplicaCount = body.maxReplicaCount;
        }
        return { data: dep };
      }),
      delete: jest.fn(async (url: string, config: any) => {
        authed(config);
        if (!deployments.delete(deploymentId(url)!)) throw notFound();
        return { data: {} };
      }),
    } as any,
  };
}

const live = liveRequested('fireworks');
const fixture = fixtureHttp();
const adapter = () => (live ? new FireworksAdapter() : new FireworksAdapter(fixture.http));

runConformance(live ? 'fireworks (LIVE)' : 'fireworks (fixture)', {
  adapter,
  credentials: live ? { apiKey: process.env.FIREWORKS_API_KEY } : { apiKey: 'fw_valid' },
  badCredentials: { apiKey: 'fw_expired' },
  tinyVersion: {
    id: 'v1',
    name: 'qwen3-0.6b',
    // Fireworks deploys a model that already lives in an account.
    registryUri: live ? (process.env.FIREWORKS_TEST_MODEL as string) : 'fireworks://accounts/fireworks/models/qwen3-0p6b',
    base: 'qwen3-0.6b',
    quantizations: [],
    manifestSha: 'sha',
  },
  providerConfig: { account: live ? process.env.FIREWORKS_ACCOUNT : ACCOUNT, acceleratorType: 'NVIDIA_H100_80GB', deploymentShape: 'minimal' },
  quotaExceededConfig: live ? undefined : { account: ACCOUNT, acceleratorType: 'NVIDIA_B300_288GB' },
  vanish: live ? undefined : (_adapter, ref) => { fixture.deployments.delete(ref.deploymentId); },
  chat: live ? undefined : async () => 'fixture reply',
  readyTimeoutMs: live ? 30 * 60_000 : 5_000,
});

describe('fireworks request shape', () => {
  const version = (registryUri: string) => ({ id: 'v-1', name: 'q', registryUri, base: 'qwen3-0.6b', quantizations: [], manifestSha: 's' });
  const deploy = (f: ReturnType<typeof fixtureHttp>, registryUri: string, providerConfig: Record<string, any> = {}, desired: Record<string, any> = {}) =>
    new FireworksAdapter(f.http).deploy(
      { deploymentId: 'abc-123', organizationId: 'org', version: version(registryUri), desired: { replicas: 1, minScale: 0, maxScale: 2, ...desired }, providerConfig: { account: ACCOUNT, ...providerConfig } },
      { apiKey: 'fw_valid' },
    );

  it('deploys a model that already lives in the account, on a validated shape', async () => {
    const f = fixtureHttp();
    const ref = await deploy(f, 'fireworks://accounts/fireworks/models/qwen3-0p6b', { deploymentShape: 'throughput', region: 'US' });
    const [url, body, config] = f.http.post.mock.calls[0];
    expect(url).toBe(`https://api.fireworks.ai/v1/accounts/${ACCOUNT}/deployments`);
    expect(config.params).toEqual({ deploymentId: 'almyty-d-abc123' });
    expect(body).toEqual({
      baseModel: 'accounts/fireworks/models/qwen3-0p6b',
      displayName: 'almyty abc-123',
      minReplicaCount: 0,
      maxReplicaCount: 2,
      deploymentShape: 'throughput',
      autoscalingPolicy: { scaleToZeroWindow: '1h' },
      placement: { multiRegion: 'US' },
    });
    expect(ref).toMatchObject({ account: ACCOUNT, deploymentId: 'almyty-d-abc123', singleRegion: false, url: 'https://api.fireworks.ai/inference/v1' });
  });

  it('marks a single-region placement, which carries the 1.5x premium', async () => {
    const f = fixtureHttp();
    const ref = await deploy(f, 'fireworks://accounts/x/models/y', {}, { region: 'US_IOWA_1' });
    expect(f.http.post.mock.calls[0][1].placement).toEqual({ region: 'US_IOWA_1' });
    expect(ref.singleRegion).toBe(true);
    // 3600 metered GPU-seconds of an H100 at 800 cents, times the single-region premium.
    expect((await new FireworksAdapter(f.http).costSnapshot(ref, { apiKey: 'fw_valid' })).spentCents).toBe(1200);
  });

  it('refuses a hub version outright: Fireworks has no Hugging Face import for inference', async () => {
    const f = fixtureHttp();
    await expect(deploy(f, 'hf://Qwen/Qwen3-0.6B@main')).rejects.toMatchObject({ code: 'ADAPTER_UNSUPPORTED_SOURCE' });
    await expect(deploy(f, 'hf://Qwen/Qwen3-0.6B@main')).rejects.toThrow(/no Hugging Face import for inference/);
    expect(f.http.post).not.toHaveBeenCalled();
    expect(f.http.get).not.toHaveBeenCalled();
  });

  it('points the operator at the documented object-storage import when the model is not in the account yet', async () => {
    const f = fixtureHttp();
    await expect(deploy(f, 's3://registry/models/q@etag')).rejects.toMatchObject({ code: 'ADAPTER_UNSUPPORTED_SOURCE' });
    // Fireworks reads the bucket itself; almyty never streams the checkpoint.
    await expect(deploy(f, 's3://registry/models/q@etag')).rejects.toThrow(
      /firectl model create almyty-v-v1 s3:\/\/registry\/models\/q --role-arn/,
    );
    await expect(deploy(f, 's3://registry/models/q@etag')).rejects.toThrow(/almyty does not stream weights/);
    expect(f.http.post).not.toHaveBeenCalled();
  });

  it('deploys an object-storage version once the operator has imported it', async () => {
    const f = fixtureHttp();
    f.models.set('almyty-v-v1', { name: `accounts/${ACCOUNT}/models/almyty-v-v1`, state: 'READY', kind: 'HF_BASE_MODEL' });
    const ref = await deploy(f, 's3://registry/models/q@etag');
    expect(f.http.post.mock.calls[0][1].baseModel).toBe(`accounts/${ACCOUNT}/models/almyty-v-v1`);
    expect(ref.baseModel).toBe(`accounts/${ACCOUNT}/models/almyty-v-v1`);
  });

  it('refuses to deploy an imported model that is still UPLOADING', async () => {
    const f = fixtureHttp();
    f.models.set('almyty-v-v1', { name: `accounts/${ACCOUNT}/models/almyty-v-v1`, state: 'UPLOADING' });
    await expect(deploy(f, 's3://registry/models/q@etag')).rejects.toMatchObject({ code: 'ADAPTER_ERROR' });
    expect(f.http.post).not.toHaveBeenCalled();
  });

  it('scales the floor and the live count, and reads scaled-to-zero as stopped', async () => {
    const f = fixtureHttp();
    const a = new FireworksAdapter(f.http);
    const ref = await deploy(f, 'fireworks://accounts/x/models/y');
    expect((await a.readEndpoint(ref, { apiKey: 'fw_valid' })).state).toBe('ready');
    expect((await a.costSnapshot(ref, { apiKey: 'fw_valid' })).ratePerHourCents).toBe(800);

    await a.scale(ref, 0, { apiKey: 'fw_valid' });
    expect(f.http.patch.mock.calls[0][1]).toEqual({ baseModel: 'accounts/x/models/y', minReplicaCount: 0, maxReplicaCount: 2 });
    expect(f.http.patch.mock.calls[1][1]).toEqual({ replicaCount: 0 });
    const stopped = await a.readEndpoint(ref, { apiKey: 'fw_valid' });
    expect(stopped.state).toBe('stopped');
    expect((await a.costSnapshot(ref, { apiKey: 'fw_valid' })).ratePerHourCents).toBe(0);
  });

  it('falls back to rate times uptime when billing is not readable', async () => {
    const f = fixtureHttp();
    const a = new FireworksAdapter(f.http);
    const ref = await deploy(f, 'fireworks://accounts/x/models/y');
    f.http.post.mockImplementation(async (url: string) => {
      if (url.endsWith(':query')) throw Object.assign(new Error('403'), { response: { status: 403, data: { status: 'PERMISSION_DENIED' } } });
      throw new Error('unexpected');
    });
    const snapshot = await a.costSnapshot(ref, { apiKey: 'fw_valid' });
    expect(snapshot.spentCents).toBeGreaterThanOrEqual(0);
    expect(snapshot.ratePerHourCents).toBe(800);
  });

  it('maps every documented deployment state', async () => {
    const f = fixtureHttp();
    const a = new FireworksAdapter(f.http);
    const ref = await deploy(f, 'fireworks://accounts/x/models/y');
    const dep = f.deployments.get(ref.deploymentId);
    for (const [raw, want] of Object.entries({ CREATING: 'deploying', READY: 'ready', UPDATING: 'scaling', DELETING: 'stopped', DELETED: 'missing', FAILED: 'failed' })) {
      dep.state = raw;
      dep.replicaStats = { readyReplicaCount: 1 };
      const actual = await a.readEndpoint(ref, { apiKey: 'fw_valid' });
      // The fixture brings CREATING up on read, like a deployment that came ready.
      expect(actual.state).toBe(raw === 'CREATING' ? 'ready' : want);
    }
  });
});
