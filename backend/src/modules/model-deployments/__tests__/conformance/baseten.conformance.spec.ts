import { BasetenAdapter } from '../../adapters/baseten.adapter';
import { liveRequested, runConformance } from './conformance.suite';

/**
 * Fixture mode: an in-memory stand-in for the Baseten management API
 * (api.baseten.co/v1, verified against the hosted OpenAPI spec), faithful
 * to its paths, DeploymentStatusV1 values and error codes. Live mode
 * (CONFORMANCE_LIVE=baseten, BASETEN_API_KEY in the local environment)
 * runs the same cases against a real workspace and never runs in CI.
 */
function fixtureHttp() {
  const models = new Map<string, any>();
  const deployments = new Map<string, any>();
  const secrets = new Map<string, string>();
  let seq = 0;
  const authed = (config: any) => {
    const auth = config?.headers?.Authorization ?? '';
    if (auth !== 'Bearer bt_valid' && auth !== 'Api-Key bt_valid') {
      throw Object.assign(new Error('401'), { response: { status: 401, data: { error: 'Invalid API key' } } });
    }
  };
  const notFound = () => Object.assign(new Error('404'), { response: { status: 404, data: { error: 'Not found' } } });
  const parse = (url: string) => {
    const m = url.match(/\/v1\/models\/([^/]+)(?:\/deployments\/([^/]+))?(?:\/(autoscaling_settings|activate|deactivate))?$/);
    return { modelId: m?.[1], deploymentId: m?.[2], action: m?.[3] };
  };
  return {
    models,
    deployments,
    secrets,
    http: {
      post: jest.fn(async (url: string, body: any, config: any) => {
        authed(config);
        if (url.endsWith('/v1/secrets')) {
          secrets.set(body.name, body.value);
          return { data: { id: `sec-${body.name}`, name: body.name, created_at: new Date().toISOString(), team_name: 'default' } };
        }
        if (url.endsWith('/v1/llm_models')) {
          if (String(body?.resources?.accelerator).startsWith('H100:8')) {
            throw Object.assign(new Error('429'), { response: { status: 429, data: { error: 'GPU quota exceeded for H100:8' } } });
          }
          seq += 1;
          const modelId = `mdl${seq}`;
          const deploymentId = `dep${seq}`;
          models.set(modelId, { id: modelId, name: body.name, production_deployment_id: deploymentId });
          deployments.set(deploymentId, {
            id: deploymentId,
            model_id: modelId,
            name: 'deployment-1',
            is_production: true,
            is_development: false,
            status: 'DEPLOYING',
            active_replica_count: 0,
            autoscaling_settings: { ...body.autoscaling_settings, autoscaling_window: 60, concurrency_target: body.autoscaling_settings?.concurrency_target ?? 1, target_utilization_percentage: null },
            instance_type_name: `${body.resources.accelerator}x4x16`,
            environment: null,
            region: body.region ? { slug: body.region, display_name: body.region } : null,
            request: body,
          });
          return { data: { model_id: modelId, version_id: deploymentId, hostname: `model-${modelId}.api.baseten.co`, instance_type_name: `${body.resources.accelerator}x4x16` } };
        }
        const { deploymentId, action } = parse(url);
        const d = deployments.get(deploymentId!);
        if (!d) throw notFound();
        if (action === 'deactivate') {
          const noOp = d.status === 'INACTIVE';
          d.status = 'INACTIVE';
          d.active_replica_count = 0;
          return { data: { success: true, no_op: noOp } };
        }
        if (action === 'activate') {
          const noOp = d.status === 'ACTIVE';
          d.status = 'ACTIVE';
          d.active_replica_count = Math.max(d.autoscaling_settings.min_replica, 1);
          d.billed = 0.32;
          return { data: { success: true, no_op: noOp } };
        }
        throw notFound();
      }),
      get: jest.fn(async (url: string, config: any) => {
        authed(config);
        if (url.endsWith('/v1/instance_type_prices')) {
          return { data: { instance_types: [{ instance_type: { id: 'H100x4x16', name: 'H100x4x16', gpu_count: 1, gpu_type: 'H100' }, price: 0.16 }, { instance_type: { id: 'L4x4x16', name: 'L4x4x16', gpu_count: 1, gpu_type: 'L4' }, price: 0.01414 }] } };
        }
        if (url.endsWith('/v1/billing/usage_summary')) {
          const breakdown = [...deployments.values()].map((d) => ({
            billable_resource: { id: d.id, kind: 'deployment', name: d.name, model_id: d.model_id, model_name: models.get(d.model_id)?.name },
            // Spend accrues while ACTIVE and never comes back down, like a real invoice.
            subtotal: d.billed ?? 0,
            compute_cost: d.billed ?? 0,
            surcharge_cost: 0,
            minutes: d.billed ? 2 : 0,
            inference_requests: 0,
          }));
          return { data: { dedicated_usage: { subtotal: 0.32, credits_used: 0, total: 0.32, minutes: 2, breakdown } } };
        }
        const { deploymentId } = parse(url);
        const d = deployments.get(deploymentId!);
        if (!d) throw notFound();
        // The fixture comes up on the first read after creation, like a build that finished.
        if (d.status === 'DEPLOYING') {
          d.status = 'ACTIVE';
          d.active_replica_count = Math.max(d.autoscaling_settings.min_replica, 1);
          d.billed = 0.32;
        }
        return { data: d };
      }),
      patch: jest.fn(async (url: string, body: any, config: any) => {
        authed(config);
        const { deploymentId, action } = parse(url);
        const d = deployments.get(deploymentId!);
        if (!d || action !== 'autoscaling_settings') throw notFound();
        d.autoscaling_settings = { ...d.autoscaling_settings, ...body };
        if (d.status === 'ACTIVE') d.status = 'UPDATING';
        return { data: { status: 'ACCEPTED', message: 'Autoscaling settings update accepted' } };
      }),
      delete: jest.fn(async (url: string, config: any) => {
        authed(config);
        const { modelId, deploymentId } = parse(url);
        if (deploymentId) {
          if (!deployments.delete(deploymentId)) throw notFound();
          return { data: { id: deploymentId, deleted: true, model_id: modelId } };
        }
        if (!models.delete(modelId!)) throw notFound();
        for (const [id, d] of deployments) if (d.model_id === modelId) deployments.delete(id);
        return { data: { id: modelId, deleted: true } };
      }),
    } as any,
  };
}

const live = liveRequested('baseten');
const fixture = fixtureHttp();
const adapter = () => (live ? new BasetenAdapter() : new BasetenAdapter(fixture.http));

runConformance(live ? 'baseten (LIVE)' : 'baseten (fixture)', {
  adapter,
  credentials: live ? { apiKey: process.env.BASETEN_API_KEY } : { apiKey: 'bt_valid' },
  badCredentials: { apiKey: 'bt_expired' },
  tinyVersion: { id: 'v1', name: 'qwen3-0.6b', registryUri: 'hf://Qwen/Qwen3-0.6B@main', base: 'qwen3-0.6b', quantizations: [], manifestSha: 'sha' },
  providerConfig: { accelerator: live ? 'L4' : 'H100', hourlyRateCents: 100 },
  quotaExceededConfig: live ? undefined : { accelerator: 'H100:8' },
  vanish: live ? undefined : (_adapter, ref) => { fixture.deployments.delete(ref.deploymentId); },
  chat: live ? undefined : async () => 'fixture reply',
  readyTimeoutMs: live ? 30 * 60_000 : 5_000,
});

describe('baseten request shape', () => {
  const s3Version = { id: 'v', name: 'q', registryUri: 's3://registry/models/q@etag', base: 'qwen3-0.6b', quantizations: [], manifestSha: 's' };

  it('mounts a hub version through BDN with the customer token in a workspace secret, not in the body', async () => {
    const f = fixtureHttp();
    const a = new BasetenAdapter(f.http);
    const ref = await a.deploy(
      {
        deploymentId: 'abc-123',
        organizationId: 'org',
        version: { id: 'v', name: 'q', registryUri: 'hf://Qwen/Qwen3-0.6B@abc123', base: 'qwen3', quantizations: [], manifestSha: 's' },
        desired: { replicas: 1, minScale: 0, maxScale: 2, region: 'eu-central-1', hardware: 'H100:2' },
        providerConfig: {},
      },
      { apiKey: 'bt_valid', hfToken: 'hf_secret' },
    );
    const [secretCall, createCall] = f.http.post.mock.calls;
    expect(secretCall[0]).toBe('https://api.baseten.co/v1/secrets');
    expect(secretCall[1]).toEqual({ name: 'hf_access_token', value: 'hf_secret' });
    expect(createCall[0]).toBe('https://api.baseten.co/v1/llm_models');
    expect(createCall[2].headers.Authorization).toBe('Bearer bt_valid');
    const body = createCall[1];
    expect(body.name).toBe('almyty-abc123');
    expect(body.resources).toEqual({ accelerator: 'H100:2', use_gpu: true });
    expect(body.region).toBe('eu-central-1');
    // Baseten mirrors the repo itself; the per-source auth block names the secret, never the token.
    expect(body.weights).toEqual([
      { source: 'hf://Qwen/Qwen3-0.6B@abc123', mount_location: '/models/almyty', auth: { auth_method: 'CUSTOM_SECRET', auth_secret_name: 'hf_access_token' } },
    ]);
    expect(body.llm_config).toEqual({
      engine_backend: 'vllm',
      checkpoint_name: '/models/almyty',
      model_name: '/models/almyty',
      model_path: '/models/almyty',
      model_path_for_tokenizer: '/models/almyty',
      served_model_name: 'q',
      tensor_parallel_size: 2,
    });
    expect(body.autoscaling_settings).toEqual({ min_replica: 0, max_replica: 2, scale_down_delay: 120 });
    expect(body).not.toHaveProperty('environment_variables');
    expect(JSON.stringify(body)).not.toContain('hf_secret');
    expect(ref.url).toBe('https://model-mdl1.api.baseten.co/deployment/dep1/sync/v1');
  });

  it('serves a public hub repo with no secret and no auth block', async () => {
    const f = fixtureHttp();
    const a = new BasetenAdapter(f.http);
    await a.deploy(
      { deploymentId: 'd', organizationId: 'org', version: { id: 'v', name: 'q', registryUri: 'hf://Qwen/Qwen3-0.6B@abc123', base: 'qwen3', quantizations: [], manifestSha: 's' }, desired: {}, providerConfig: {} },
      { apiKey: 'bt_valid' },
    );
    expect(f.http.post.mock.calls).toHaveLength(1);
    expect(f.http.post.mock.calls[0][1].weights).toEqual([{ source: 'hf://Qwen/Qwen3-0.6B@abc123', mount_location: '/models/almyty' }]);
    expect(f.secrets.size).toBe(0);
  });

  it('mounts an object-storage version by bucket path, with the read keys in the documented aws_credentials secret', async () => {
    const f = fixtureHttp();
    const a = new BasetenAdapter(f.http);
    await a.deploy(
      {
        deploymentId: 'd',
        organizationId: 'org',
        version: s3Version,
        desired: {},
        providerConfig: { registryRegion: 'eu-central-1', registryAccessKeyId: 'AK' },
      },
      { apiKey: 'bt_valid', registryAccessKeyId: 'AK', registrySecretAccessKey: 'SK' },
    );
    const [secretCall, createCall] = f.http.post.mock.calls;
    // Exactly the key names Baseten documents; access_key_id without the aws_ prefix fails auth.
    expect(secretCall[1]).toEqual({ name: 'aws_credentials', value: JSON.stringify({ aws_access_key_id: 'AK', aws_secret_access_key: 'SK', aws_region: 'eu-central-1' }) });
    // The registry's @etag pin is not part of the bucket path.
    expect(createCall[1].weights).toEqual([
      { source: 's3://registry/models/q', mount_location: '/models/almyty', auth: { auth_method: 'CUSTOM_SECRET', auth_secret_name: 'aws_credentials' } },
    ]);
    expect(JSON.stringify(createCall[1])).not.toContain('SK');
  });

  it('refuses a source BDN cannot mirror, before calling Baseten', async () => {
    const f = fixtureHttp();
    const a = new BasetenAdapter(f.http);
    await expect(
      a.deploy({ deploymentId: 'd', organizationId: 'org', version: { ...s3Version, registryUri: 'file:///srv/models/q' }, desired: {}, providerConfig: {} }, { apiKey: 'bt_valid' }),
    ).rejects.toMatchObject({ code: 'ADAPTER_UNSUPPORTED_SOURCE' });
    expect(f.http.post).not.toHaveBeenCalled();
  });

  it('scales through autoscaling_settings plus activate, and deactivates for zero', async () => {
    const f = fixtureHttp();
    const a = new BasetenAdapter(f.http);
    const ref = await a.deploy({ deploymentId: 'd', organizationId: 'org', version: s3Version, desired: { maxScale: 3 }, providerConfig: {} }, { apiKey: 'bt_valid' });
    await a.scale(ref, 2, { apiKey: 'bt_valid' });
    expect(f.http.patch.mock.calls[0][0]).toBe('https://api.baseten.co/v1/models/mdl1/deployments/dep1/autoscaling_settings');
    expect(f.http.patch.mock.calls[0][1]).toEqual({ min_replica: 2, max_replica: 3 });
    expect(f.http.post.mock.calls.at(-1)![0]).toBe('https://api.baseten.co/v1/models/mdl1/deployments/dep1/activate');
    await a.scale(ref, 0, { apiKey: 'bt_valid' });
    expect(f.http.post.mock.calls.at(-1)![0]).toBe('https://api.baseten.co/v1/models/mdl1/deployments/dep1/deactivate');
    expect((await a.readEndpoint(ref, { apiKey: 'bt_valid' })).state).toBe('stopped');
  });

  it('prices from instance_type_prices and reads spend from the billing summary', async () => {
    const f = fixtureHttp();
    const a = new BasetenAdapter(f.http);
    const ref = await a.deploy({ deploymentId: 'd', organizationId: 'org', version: s3Version, desired: {}, providerConfig: { hourlyRateCents: 1 } }, { apiKey: 'bt_valid' });
    const snap = await a.costSnapshot(ref, { apiKey: 'bt_valid' });
    // 0.16 USD/min for H100x4x16 is 960 cents/hour; the billing breakdown reports 0.32 USD.
    expect(snap.ratePerHourCents).toBe(960);
    expect(snap.spentCents).toBe(32);
    const usageCall = f.http.get.mock.calls.find((c: any[]) => String(c[0]).endsWith('/v1/billing/usage_summary'))!;
    expect(usageCall[1].params).toEqual({ start_date: expect.any(String), end_date: expect.any(String) });
  });

  it('tears down the deployment and its model, tolerating an already deleted pair', async () => {
    const f = fixtureHttp();
    const a = new BasetenAdapter(f.http);
    const ref = await a.deploy({ deploymentId: 'd', organizationId: 'org', version: s3Version, desired: {}, providerConfig: {} }, { apiKey: 'bt_valid' });
    await a.teardown(ref, { apiKey: 'bt_valid' });
    expect(f.http.delete.mock.calls.map((c: any[]) => c[0])).toEqual(['https://api.baseten.co/v1/models/mdl1/deployments/dep1', 'https://api.baseten.co/v1/models/mdl1']);
    expect(f.models.size).toBe(0);
    await expect(a.teardown(ref, { apiKey: 'bt_valid' })).resolves.toBeUndefined();
  });

  it('maps every documented DeploymentStatusV1 value', async () => {
    const f = fixtureHttp();
    const a = new BasetenAdapter(f.http);
    const ref = await a.deploy({ deploymentId: 'd', organizationId: 'org', version: s3Version, desired: {}, providerConfig: {} }, { apiKey: 'bt_valid' });
    const d = f.deployments.get(ref.deploymentId);
    const expected: Record<string, string> = {
      BUILDING: 'deploying', DEPLOYING: 'deploying', LOADING_MODEL: 'deploying', WAKING_UP: 'deploying',
      ACTIVE: 'ready', UNHEALTHY: 'degraded', UPDATING: 'scaling', DEACTIVATING: 'scaling',
      INACTIVE: 'stopped', SCALED_TO_ZERO: 'stopped', BUILD_STOPPED: 'stopped',
      DEPLOY_FAILED: 'failed', BUILD_FAILED: 'failed', FAILED: 'failed',
    };
    for (const [raw, state] of Object.entries(expected)) {
      d.status = raw;
      const actual = await a.readEndpoint(ref, { apiKey: 'bt_valid' });
      // The fixture flips DEPLOYING to ACTIVE on read, like a build that came up.
      expect(actual.state).toBe(raw === 'DEPLOYING' ? 'ready' : state);
    }
  });
});
