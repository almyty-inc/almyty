import { AzureFoundryAdapter } from '../../adapters/azure-foundry.adapter';
import { liveRequested, runConformance } from './conformance.suite';

/**
 * Fixture mode: an in-memory stand-in for the ARM online endpoints API
 * (api-version 2024-10-01) and the Entra client-credentials token
 * endpoint, faithful to the documented paths, bodies, provisioning states
 * and error envelopes. Live mode (CONFORMANCE_LIVE=azure-foundry with
 * AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET,
 * AZURE_SUBSCRIPTION_ID, AZURE_RESOURCE_GROUP, AZURE_ML_WORKSPACE in the
 * local environment) runs the same cases against a real workspace and is
 * never run in CI.
 */
const ARM_PREFIX = /^https:\/\/management\.azure\.com\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.MachineLearningServices\/workspaces\/[^/]+\/(.+)\?api-version=2024-10-01$/;

function fixtureHttp() {
  const endpoints = new Map<string, any>();
  const deployments = new Map<string, any>();
  const armError = (status: number, code: string, message: string) => Object.assign(new Error(String(status)), { response: { status, data: { error: { code, message } } } });
  const authed = (config: any) => {
    if ((config?.headers?.Authorization ?? '') !== 'Bearer arm-valid') throw armError(401, 'InvalidAuthenticationToken', 'The access token is invalid.');
  };
  const parse = (url: string) => {
    const path = url.match(ARM_PREFIX)?.[1] ?? '';
    const m = path.match(/^onlineEndpoints\/([^/]+)(?:\/deployments\/([^/]+))?(?:\/(listKeys))?$/);
    return { path, endpoint: m?.[1], deployment: m?.[2], action: m?.[3] };
  };
  const http = {
    post: jest.fn(async (url: string, body: any, config: any) => {
      if (url.startsWith('https://login.microsoftonline.com/')) {
        const form = new URLSearchParams(String(body));
        if (form.get('grant_type') !== 'client_credentials' || form.get('scope') !== 'https://management.azure.com/.default') {
          throw Object.assign(new Error('400'), { response: { status: 400, data: { error: 'invalid_request', error_description: 'bad grant' } } });
        }
        if (form.get('client_secret') !== 'sp-valid') {
          throw Object.assign(new Error('401'), { response: { status: 401, data: { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' } } });
        }
        return { data: { token_type: 'Bearer', expires_in: 3599, access_token: 'arm-valid' } };
      }
      authed(config);
      const { endpoint, action } = parse(url);
      if (action === 'listKeys' && endpoints.has(endpoint!)) return { data: { primaryKey: 'pk', secondaryKey: 'sk' } };
      throw armError(404, 'ResourceNotFound', 'not found');
    }),
    put: jest.fn(async (url: string, body: any, config: any) => {
      authed(config);
      const { path, endpoint, deployment } = parse(url);
      if (path.startsWith('environments/') || path.startsWith('models/')) {
        return { data: { id: `/subscriptions/sub/resourceGroups/rg/providers/Microsoft.MachineLearningServices/workspaces/ws/${path}`, name: path.split('/').pop(), properties: { ...body.properties, provisioningState: 'Succeeded' } } };
      }
      if (endpoint && !deployment) {
        const existing = endpoints.get(endpoint);
        if (body.properties?.traffic && Object.keys(body.properties.traffic).some((d) => !deployments.has(`${endpoint}/${d}`))) {
          throw armError(400, 'InvalidTraffic', 'Traffic references a deployment that does not exist.');
        }
        const ep = {
          id: `/subscriptions/sub/resourceGroups/rg/providers/Microsoft.MachineLearningServices/workspaces/ws/onlineEndpoints/${endpoint}`,
          name: endpoint,
          location: body.location,
          properties: {
            ...(existing?.properties ?? {}),
            ...body.properties,
            scoringUri: `https://${endpoint}.${body.location}.inference.ml.azure.com/score`,
            provisioningState: 'Succeeded',
          },
        };
        endpoints.set(endpoint, ep);
        return { data: ep };
      }
      if (endpoint && deployment) {
        if (!endpoints.has(endpoint)) throw armError(404, 'ResourceNotFound', 'endpoint not found');
        if (body.properties?.instanceType === 'Standard_ND96asr_v4') {
          throw armError(400, 'OutOfQuota', 'Not enough quota available for Standard_ND96asr_v4 in this region.');
        }
        const dep = { name: deployment, location: body.location, sku: body.sku, properties: { ...body.properties, provisioningState: 'Creating' } };
        deployments.set(`${endpoint}/${deployment}`, dep);
        return { data: dep };
      }
      throw armError(404, 'ResourceNotFound', 'not found');
    }),
    get: jest.fn(async (url: string, config: any) => {
      authed(config);
      const { endpoint, deployment } = parse(url);
      if (endpoint && !deployment) {
        const ep = endpoints.get(endpoint);
        if (!ep) throw armError(404, 'ResourceNotFound', 'endpoint not found');
        return { data: ep };
      }
      const dep = deployments.get(`${endpoint}/${deployment}`);
      if (!dep) throw armError(404, 'ResourceNotFound', 'deployment not found');
      // The fixture finishes provisioning on the first read after creation.
      if (dep.properties.provisioningState === 'Creating' || dep.properties.provisioningState === 'Updating') dep.properties.provisioningState = 'Succeeded';
      return { data: dep };
    }),
    patch: jest.fn(async (url: string, body: any, config: any) => {
      authed(config);
      const { endpoint, deployment } = parse(url);
      const dep = deployments.get(`${endpoint}/${deployment}`);
      if (!dep) throw armError(404, 'ResourceNotFound', 'deployment not found');
      dep.sku = { ...dep.sku, ...body.sku };
      dep.properties.provisioningState = 'Updating';
      return { data: dep };
    }),
    delete: jest.fn(async (url: string, config: any) => {
      authed(config);
      const { endpoint, deployment } = parse(url);
      if (deployment) {
        if (!deployments.delete(`${endpoint}/${deployment}`)) throw armError(404, 'ResourceNotFound', 'deployment not found');
        return { status: 202, data: {} };
      }
      if (!endpoints.delete(endpoint!)) throw armError(404, 'ResourceNotFound', 'endpoint not found');
      for (const key of [...deployments.keys()]) if (key.startsWith(`${endpoint}/`)) deployments.delete(key);
      return { status: 202, data: {} };
    }),
  } as any;
  return { endpoints, deployments, http };
}

const live = liveRequested('azure-foundry');
const fixture = fixtureHttp();
const adapter = () => (live ? new AzureFoundryAdapter() : new AzureFoundryAdapter(fixture.http));
const env = process.env;
const baseConfig = live
  ? { subscriptionId: env.AZURE_SUBSCRIPTION_ID, resourceGroup: env.AZURE_RESOURCE_GROUP, workspace: env.AZURE_ML_WORKSPACE, tenantId: env.AZURE_TENANT_ID, clientId: env.AZURE_CLIENT_ID, location: env.AZURE_LOCATION ?? 'eastus' }
  : { subscriptionId: 'sub', resourceGroup: 'rg', workspace: 'ws', tenantId: 'tenant', clientId: 'client', location: 'eastus' };

runConformance(live ? 'azure-foundry (LIVE)' : 'azure-foundry (fixture)', {
  adapter,
  credentials: live ? { clientSecret: env.AZURE_CLIENT_SECRET } : { clientSecret: 'sp-valid' },
  badCredentials: { clientSecret: 'sp-expired' },
  tinyVersion: { id: 'v1', name: 'qwen3-0.6b', registryUri: 'hf://Qwen/Qwen3-0.6B@main', base: 'qwen3-0.6b', quantizations: [], manifestSha: 'sha' },
  providerConfig: { ...baseConfig, instanceType: live ? env.AZURE_INSTANCE_TYPE ?? 'Standard_NC4as_T4_v3' : 'Standard_NC4as_T4_v3', hourlyRateCents: 53 },
  quotaExceededConfig: live ? undefined : { ...baseConfig, instanceType: 'Standard_ND96asr_v4' },
  vanish: live ? undefined : (_adapter, ref) => { fixture.endpoints.delete(ref.endpointName); },
  chat: live ? undefined : async () => 'fixture reply',
  readyTimeoutMs: live ? 30 * 60_000 : 5_000,
});

describe('azure-foundry request shape', () => {
  const s3Request = {
    deploymentId: 'abc-123',
    organizationId: 'org',
    version: { id: 'v', name: 'q', registryUri: 's3://registry/models/q@etag', base: 'qwen3-0.6b', quantizations: [], manifestSha: 's' },
    desired: { replicas: 2, minScale: 0, maxScale: 2, region: 'westeurope', hardware: 'Standard_NC24ads_A100_v4' },
    providerConfig: { subscriptionId: 'sub', resourceGroup: 'rg', workspace: 'ws', tenantId: 'tenant', clientId: 'client', registryEndpoint: 'https://minio.local', maxModelLen: 8192 },
  };
  const creds = { clientSecret: 'sp-valid', registryAccessKeyId: 'AK', registrySecretAccessKey: 'SK' };

  it('serves an S3 registry version: environment, key-auth endpoint, managed deployment with the registry in env', async () => {
    const f = fixtureHttp();
    const a = new AzureFoundryAdapter(f.http);
    const ref = await a.deploy(s3Request, creds);

    const token = f.http.post.mock.calls[0];
    expect(token[0]).toBe('https://login.microsoftonline.com/tenant/oauth2/v2.0/token');
    expect(new URLSearchParams(token[1]).get('client_id')).toBe('client');

    const ws = 'https://management.azure.com/subscriptions/sub/resourceGroups/rg/providers/Microsoft.MachineLearningServices/workspaces/ws';
    const [envCall, endpointCall, deploymentCall] = f.http.put.mock.calls;
    expect(envCall[0]).toBe(`${ws}/environments/almyty-abc123/versions/1?api-version=2024-10-01`);
    expect(envCall[1].properties.image).toBe('vllm/vllm-openai:latest');
    expect(envCall[1].properties.inferenceConfig).toEqual({
      livenessRoute: { path: '/health', port: 8000 },
      readinessRoute: { path: '/health', port: 8000 },
      scoringRoute: { path: '/v1/chat/completions', port: 8000 },
    });

    expect(endpointCall[0]).toBe(`${ws}/onlineEndpoints/almyty-abc123?api-version=2024-10-01`);
    expect(endpointCall[1]).toEqual({ location: 'westeurope', identity: { type: 'SystemAssigned' }, properties: { authMode: 'Key' } });

    expect(deploymentCall[0]).toBe(`${ws}/onlineEndpoints/almyty-abc123/deployments/almyty?api-version=2024-10-01`);
    const body = deploymentCall[1];
    expect(body.location).toBe('westeurope');
    expect(body.sku).toEqual({ name: 'Default', capacity: 2 });
    expect(body.properties.endpointComputeType).toBe('Managed');
    expect(body.properties.instanceType).toBe('Standard_NC24ads_A100_v4');
    expect(body.properties.environmentId).toContain('/environments/almyty-abc123/versions/1');
    expect(body.properties.scaleSettings).toEqual({ scaleType: 'Default' });
    expect(body.properties.requestSettings).toEqual({ requestTimeout: 'PT90S', maxConcurrentRequestsPerInstance: 8 });
    expect(body.properties.environmentVariables).toEqual({
      SERVED_MODEL_NAME: 'q',
      MAX_MODEL_LEN: '8192',
      ALMYTY_REGISTRY_URI: 's3://registry/models/q@etag',
      MODEL_ID: '/data/model',
      AWS_ENDPOINT_URL: 'https://minio.local',
      AWS_ACCESS_KEY_ID: 'AK',
      AWS_SECRET_ACCESS_KEY: 'SK',
    });
    expect(body.properties.model).toBeUndefined();
    // No model asset is registered for an S3 source and no secret is kept on the ref.
    expect(f.http.put.mock.calls.some((c) => c[0].includes('/models/'))).toBe(false);
    expect(JSON.stringify(ref)).not.toContain('SK');
    expect(ref.url).toBe('https://almyty-abc123.westeurope.inference.ml.azure.com/score');
  });

  it('registers a blob model asset for an azureml:// version and mounts it', async () => {
    const f = fixtureHttp();
    const a = new AzureFoundryAdapter(f.http);
    await a.deploy(
      { ...s3Request, version: { ...s3Request.version, registryUri: 'azureml://subscriptions/sub/resourcegroups/rg/workspaces/ws/datastores/blob/paths/q@v1' } },
      { accessToken: 'arm-valid' },
    );
    expect(f.http.post).not.toHaveBeenCalled();
    const model = f.http.put.mock.calls.find((c) => c[0].includes('/models/'))!;
    expect(model[1]).toEqual({ properties: { modelType: 'custom_model', modelUri: 'azureml://subscriptions/sub/resourcegroups/rg/workspaces/ws/datastores/blob/paths/q' } });
    const dep = f.http.put.mock.calls.find((c) => c[0].includes('/deployments/'))![1];
    expect(dep.properties.model).toContain('/models/almyty-abc123/versions/1');
    expect(dep.properties.modelMountPath).toBe('/var/azureml-app/model');
    expect(dep.properties.environmentVariables.MODEL_ID).toBe('/var/azureml-app/model/almyty-abc123/1');
  });

  it('routes traffic once the deployment succeeds, scales by sku.capacity, and scales to zero by deleting the deployment', async () => {
    const f = fixtureHttp();
    const a = new AzureFoundryAdapter(f.http);
    const ref = await a.deploy(s3Request, creds);
    const first = await a.readEndpoint(ref, creds);
    expect(first.state).toBe('deploying');
    expect(f.endpoints.get('almyty-abc123').properties.traffic).toEqual({ almyty: 100 });
    const second = await a.readEndpoint(ref, creds);
    expect(second.state).toBe('ready');
    expect(second.replicas).toBe(2);

    await a.scale(ref, 3, creds);
    const patch = f.http.patch.mock.calls[0];
    expect(patch[1]).toEqual({ sku: { name: 'Default', capacity: 3 } });
    expect((await a.readEndpoint(ref, creds)).replicas).toBe(3);

    await a.scale(ref, 0, creds);
    expect(f.deployments.has('almyty-abc123/almyty')).toBe(false);
    const stopped = await a.readEndpoint(ref, creds);
    expect(stopped.state).toBe('stopped');
    expect((await a.costSnapshot(ref, creds)).ratePerHourCents).toBe(0);

    await a.scale(ref, 1, creds);
    const recreated = f.deployments.get('almyty-abc123/almyty');
    expect(recreated.sku.capacity).toBe(1);
    expect(recreated.properties.environmentVariables.AWS_SECRET_ACCESS_KEY).toBe('SK');
  });

  it('maps every documented provisioning state', async () => {
    const f = fixtureHttp();
    const a = new AzureFoundryAdapter(f.http);
    const ref = await a.deploy(s3Request, creds);
    await a.readEndpoint(ref, creds);
    const dep = f.deployments.get('almyty-abc123/almyty');
    for (const [raw, expected] of Object.entries({ Creating: 'ready', Updating: 'ready', Scaling: 'scaling', Succeeded: 'ready', Failed: 'failed', Canceled: 'failed', Deleting: 'stopped' })) {
      dep.properties.provisioningState = raw;
      // The fixture flips Creating and Updating to Succeeded on read, like a deployment that finished.
      expect((await a.readEndpoint(ref, creds)).state).toBe(expected);
    }
  });

  it('caches the service principal token across calls and treats a rejected secret as an auth error', async () => {
    const f = fixtureHttp();
    const a = new AzureFoundryAdapter(f.http);
    const ref = await a.deploy(s3Request, creds);
    await a.readEndpoint(ref, creds);
    expect(f.http.post.mock.calls.filter((c) => c[0].startsWith('https://login.microsoftonline.com/')).length).toBe(1);
    await expect(a.readEndpoint(ref, { clientSecret: 'nope' })).rejects.toMatchObject({ code: 'ADAPTER_AUTH' });
  });
});
