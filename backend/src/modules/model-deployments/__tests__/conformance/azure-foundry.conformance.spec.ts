import { AzureFoundryAdapter } from '../../adapters/azure-foundry.adapter';
import { liveRequested, runConformance } from './conformance.suite';

/**
 * Fixture mode: an in-memory stand-in for the two ARM surfaces the
 * adapter drives - Microsoft.CognitiveServices accounts and their
 * serverless deployments, and Microsoft.MachineLearningServices managed
 * online endpoints (both api-version 2024-10-01) - plus the Entra
 * client-credentials token endpoint, faithful to the documented paths,
 * bodies, provisioning states and error envelopes. Live mode
 * (CONFORMANCE_LIVE=azure-foundry with AZURE_TENANT_ID, AZURE_CLIENT_ID,
 * AZURE_CLIENT_SECRET, AZURE_SUBSCRIPTION_ID, AZURE_RESOURCE_GROUP,
 * AZURE_ML_WORKSPACE and AZURE_FOUNDRY_ACCOUNT in the local environment)
 * runs the same cases against a real subscription; never in CI.
 */
const ML_PREFIX = /^https:\/\/management\.azure\.com\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.MachineLearningServices\/workspaces\/[^/]+\/(.+)\?api-version=2024-10-01$/;
const AI_PREFIX = /^https:\/\/management\.azure\.com\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.CognitiveServices\/accounts\/([^/?]+)(?:\/deployments\/([^/?]+))?\?api-version=2024-10-01$/;

function fixtureHttp() {
  const endpoints = new Map<string, any>();
  const deployments = new Map<string, any>();
  const accounts = new Map<string, any>([
    ['fdry', { name: 'fdry', location: 'eastus', properties: { endpoint: 'https://fdry.openai.azure.com/' } }],
  ]);
  const aiDeployments = new Map<string, any>();
  const armError = (status: number, code: string, message: string) => Object.assign(new Error(String(status)), { response: { status, data: { error: { code, message } } } });
  const authed = (config: any) => {
    if ((config?.headers?.Authorization ?? '') !== 'Bearer arm-valid') throw armError(401, 'InvalidAuthenticationToken', 'The access token is invalid.');
  };
  const parse = (url: string) => {
    const ai = url.match(AI_PREFIX);
    if (ai) return { provider: 'ai' as const, path: '', account: ai[1], deployment: ai[2], endpoint: undefined, action: undefined };
    const path = url.match(ML_PREFIX)?.[1] ?? '';
    const m = path.match(/^onlineEndpoints\/([^/]+)(?:\/deployments\/([^/]+))?(?:\/(listKeys))?$/);
    return { provider: 'ml' as const, path, endpoint: m?.[1], deployment: m?.[2], action: m?.[3], account: undefined };
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
      const parsed = parse(url);
      if (parsed.provider === 'ai') {
        if (!accounts.has(parsed.account!)) throw armError(404, 'ResourceNotFound', 'account not found');
        if (!parsed.deployment) throw armError(400, 'InvalidRequest', 'deployment name required');
        if (String(body.properties?.model?.name ?? '').includes('quota')) {
          throw armError(429, 'InsufficientQuota', 'Insufficient quota for the requested deployment type.');
        }
        const dep = {
          id: `/subscriptions/sub/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/${parsed.account}/deployments/${parsed.deployment}`,
          name: parsed.deployment,
          sku: body.sku,
          tags: body.tags,
          properties: { ...body.properties, provisioningState: 'Accepted', capabilities: { chatCompletion: 'true' } },
        };
        aiDeployments.set(`${parsed.account}/${parsed.deployment}`, dep);
        return { data: dep };
      }
      const { path, endpoint, deployment } = parsed;
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
      const parsed = parse(url);
      if (parsed.provider === 'ai') {
        const account = accounts.get(parsed.account!);
        if (!account) throw armError(404, 'ResourceNotFound', 'account not found');
        if (!parsed.deployment) return { data: account };
        const dep = aiDeployments.get(`${parsed.account}/${parsed.deployment}`);
        if (!dep) throw armError(404, 'ResourceNotFound', 'deployment not found');
        // The fixture finishes provisioning on the first read after creation.
        if (dep.properties.provisioningState === 'Accepted' || dep.properties.provisioningState === 'Creating') dep.properties.provisioningState = 'Succeeded';
        return { data: dep };
      }
      const { endpoint, deployment } = parsed;
      if (endpoint && !deployment) {
        const ep = endpoints.get(endpoint);
        if (!ep) throw armError(404, 'ResourceNotFound', 'endpoint not found');
        return { data: ep };
      }
      const dep = deployments.get(`${endpoint}/${deployment}`);
      if (!dep) throw armError(404, 'ResourceNotFound', 'deployment not found');
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
      const parsed = parse(url);
      if (parsed.provider === 'ai') {
        if (!aiDeployments.delete(`${parsed.account}/${parsed.deployment}`)) throw armError(404, 'ResourceNotFound', 'deployment not found');
        return { status: 202, data: {} };
      }
      const { endpoint, deployment } = parsed;
      if (deployment) {
        if (!deployments.delete(`${endpoint}/${deployment}`)) throw armError(404, 'ResourceNotFound', 'deployment not found');
        return { status: 202, data: {} };
      }
      if (!endpoints.delete(endpoint!)) throw armError(404, 'ResourceNotFound', 'endpoint not found');
      for (const key of [...deployments.keys()]) if (key.startsWith(`${endpoint}/`)) deployments.delete(key);
      return { status: 202, data: {} };
    }),
  } as any;
  return { endpoints, deployments, accounts, aiDeployments, http };
}

const live = liveRequested('azure-foundry');
const fixture = fixtureHttp();
const adapter = () => (live ? new AzureFoundryAdapter() : new AzureFoundryAdapter(fixture.http));
const env = process.env;
const baseConfig = live
  ? { subscriptionId: env.AZURE_SUBSCRIPTION_ID, resourceGroup: env.AZURE_RESOURCE_GROUP, workspace: env.AZURE_ML_WORKSPACE, account: env.AZURE_FOUNDRY_ACCOUNT, tenantId: env.AZURE_TENANT_ID, clientId: env.AZURE_CLIENT_ID, location: env.AZURE_LOCATION ?? 'eastus' }
  : { subscriptionId: 'sub', resourceGroup: 'rg', workspace: 'ws', account: 'fdry', tenantId: 'tenant', clientId: 'client', location: 'eastus' };

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

const creds = { clientSecret: 'sp-valid' };
const AI = 'https://management.azure.com/subscriptions/sub/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/fdry';
const WS = 'https://management.azure.com/subscriptions/sub/resourceGroups/rg/providers/Microsoft.MachineLearningServices/workspaces/ws';

describe('azure-foundry catalog route (serverless API deployment)', () => {
  const catalogRequest = (registryUri = 'foundry://OpenAI/gpt-4o@2024-11-20', providerConfig: Record<string, any> = {}) => ({
    deploymentId: 'abc-123',
    organizationId: 'org',
    version: { id: 'v', name: 'gpt-4o', registryUri, base: 'gpt-4o', quantizations: [], manifestSha: 's' },
    desired: { replicas: 1, region: 'westeurope' },
    providerConfig: { subscriptionId: 'sub', resourceGroup: 'rg', account: 'fdry', tenantId: 'tenant', clientId: 'client', capacity: 50, inPerMTok: 2.5, outPerMTok: 10, ...providerConfig },
  });

  it('creates one Cognitive Services deployment naming the catalog model, with no workspace, container or instance', async () => {
    const f = fixtureHttp();
    const a = new AzureFoundryAdapter(f.http);
    const ref = await a.deploy(catalogRequest(), creds);
    expect(f.http.get.mock.calls[0][0]).toBe(`${AI}?api-version=2024-10-01`);
    const put = f.http.put.mock.calls[0];
    expect(put[0]).toBe(`${AI}/deployments/almyty-abc123?api-version=2024-10-01`);
    expect(put[1]).toEqual({
      sku: { name: 'GlobalStandard', capacity: 50 },
      properties: { model: { format: 'OpenAI', name: 'gpt-4o', version: '2024-11-20' } },
      tags: { 'almyty-deployment': 'abc-123', 'almyty-organization': 'org' },
    });
    // Nothing about compute or weights reaches Azure.
    const wire = JSON.stringify(f.http.put.mock.calls.map((c: any[]) => c[1]));
    for (const forbidden of ['instanceType', 'environmentId', 'image', 'ALMYTY_REGISTRY_URI', 'AWS_ACCESS_KEY_ID', 's3://']) {
      expect(wire).not.toContain(forbidden);
    }
    expect(f.http.put.mock.calls.some((c: any[]) => c[0].includes('MachineLearningServices'))).toBe(false);
    expect(ref).toMatchObject({ route: 'foundry', account: 'fdry', deploymentName: 'almyty-abc123', accountEndpoint: 'https://fdry.openai.azure.com/' });
    expect(ref.url).toBe('https://fdry.openai.azure.com/openai/v1/chat/completions');
  });

  it('accepts a catalog model with no explicit version', async () => {
    const f = fixtureHttp();
    const a = new AzureFoundryAdapter(f.http);
    await a.deploy(catalogRequest('foundry://Microsoft/Phi-4'), creds);
    expect(f.http.put.mock.calls[0][1].properties.model).toEqual({ format: 'Microsoft', name: 'Phi-4' });
  });

  it('refuses a malformed catalog reference and a missing Foundry account', async () => {
    const f = fixtureHttp();
    const a = new AzureFoundryAdapter(f.http);
    await expect(a.deploy(catalogRequest('foundry://gpt-4o'), creds)).rejects.toMatchObject({ code: 'ADAPTER_UNSUPPORTED_OPERATION' });
    await expect(a.deploy(catalogRequest('foundry://OpenAI/gpt-4o', { account: undefined }), creds)).rejects.toMatchObject({ code: 'ADAPTER_CONFIG_INVALID' });
    expect(f.http.put).not.toHaveBeenCalled();
  });

  it('reports the deployment as ready on the account OpenAI-compatible base, with the deployment name as the model id', async () => {
    const f = fixtureHttp();
    const a = new AzureFoundryAdapter(f.http);
    const ref = await a.deploy(catalogRequest(), creds);
    const actual = await a.readEndpoint(ref, creds);
    expect(actual.state).toBe('ready');
    expect(actual.openAiBase).toBe('https://fdry.openai.azure.com/openai/v1');
    expect(actual.url).toBe('https://fdry.openai.azure.com/openai/v1/chat/completions');
    expect(actual.details).toMatchObject({ route: 'foundry', rawState: 'Succeeded', modelId: 'almyty-abc123' });
    expect(actual.details!.model).toEqual({ format: 'OpenAI', name: 'gpt-4o', version: '2024-11-20' });
  });

  it('prices per token, stops by deleting the deployment, and comes back on scale up', async () => {
    const f = fixtureHttp();
    const a = new AzureFoundryAdapter(f.http);
    const ref = await a.deploy(catalogRequest(), creds);
    await a.readEndpoint(ref, creds);
    const cost = await a.costSnapshot(ref, creds);
    expect(cost.ratePerHourCents).toBe(0);
    expect(cost.perToken).toEqual({ inPerMTok: 2.5, outPerMTok: 10, currency: 'USD' });

    await a.scale(ref, 0, creds);
    expect(f.aiDeployments.has('fdry/almyty-abc123')).toBe(false);
    expect((await a.readEndpoint(ref, creds)).state).toBe('stopped');

    await a.scale(ref, 1, creds);
    // Capacity stays the operator's token rate; it is not a replica count.
    expect(f.aiDeployments.get('fdry/almyty-abc123').sku).toEqual({ name: 'GlobalStandard', capacity: 50 });

    await a.teardown(ref, creds);
    expect(f.http.delete.mock.calls[f.http.delete.mock.calls.length - 1][0]).toBe(`${AI}/deployments/almyty-abc123?api-version=2024-10-01`);
    await expect(a.teardown(ref, creds)).resolves.toBeUndefined();
  });

  it('maps every documented serverless provisioning state and reports a capacity refusal as a quota error', async () => {
    const f = fixtureHttp();
    const a = new AzureFoundryAdapter(f.http);
    const ref = await a.deploy(catalogRequest(), creds);
    await a.readEndpoint(ref, creds);
    const dep = f.aiDeployments.get('fdry/almyty-abc123');
    for (const [raw, expected] of Object.entries({ Moving: 'scaling', Succeeded: 'ready', Failed: 'failed', Canceled: 'failed', Disabled: 'stopped', Deleting: 'stopped' })) {
      dep.properties.provisioningState = raw;
      expect((await a.readEndpoint(ref, creds)).state).toBe(expected);
    }
    await expect(a.deploy(catalogRequest('foundry://OpenAI/gpt-4o-quota@1'), creds)).rejects.toMatchObject({ code: 'ADAPTER_QUOTA_EXCEEDED' });
  });
});

describe('azure-foundry managed online endpoint routes', () => {
  const hubRequest = {
    deploymentId: 'abc-123',
    organizationId: 'org',
    version: { id: 'v', name: 'q', registryUri: 'hf://bert-base-uncased', base: 'bert', quantizations: [], manifestSha: 's' },
    desired: { replicas: 2, minScale: 0, maxScale: 2, region: 'westeurope', hardware: 'Standard_NC24ads_A100_v4' },
    providerConfig: { subscriptionId: 'sub', resourceGroup: 'rg', workspace: 'ws', tenantId: 'tenant', clientId: 'client', hourlyRateCents: 53 },
  };
  const assetRequest = {
    ...hubRequest,
    version: { ...hubRequest.version, registryUri: 'azureml://subscriptions/sub/resourcegroups/rg/workspaces/ws/datastores/blob/paths/q@v1' },
    providerConfig: { ...hubRequest.providerConfig, maxModelLen: 8192 },
  };

  it('serves a Hugging Face model from Azure own registry, with no environment and no container of ours', async () => {
    const f = fixtureHttp();
    const a = new AzureFoundryAdapter(f.http);
    const ref = await a.deploy(hubRequest, creds);

    const token = f.http.post.mock.calls[0];
    expect(token[0]).toBe('https://login.microsoftonline.com/tenant/oauth2/v2.0/token');
    expect(new URLSearchParams(token[1]).get('client_id')).toBe('client');

    // Only the endpoint and its deployment: no environment, no model asset.
    expect(f.http.put.mock.calls.map((c: any[]) => c[0])).toEqual([
      `${WS}/onlineEndpoints/almyty-abc123?api-version=2024-10-01`,
      `${WS}/onlineEndpoints/almyty-abc123/deployments/almyty?api-version=2024-10-01`,
    ]);
    const body = f.http.put.mock.calls[1][1];
    expect(body.sku).toEqual({ name: 'Default', capacity: 2 });
    expect(body.properties.endpointComputeType).toBe('Managed');
    expect(body.properties.instanceType).toBe('Standard_NC24ads_A100_v4');
    expect(body.properties.model).toBe('azureml://registries/HuggingFace/models/bert-base-uncased/labels/latest');
    expect(body.properties.environmentId).toBeUndefined();
    expect(body.properties.environmentVariables).toBeUndefined();
    expect(body.properties.modelMountPath).toBeUndefined();
    expect(ref.route).toBe('hub');
    expect(ref.url).toBe('https://almyty-abc123.westeurope.inference.ml.azure.com/score');
  });

  it('registers a model asset for an azureml:// version, mounts it and runs vLLM over it', async () => {
    const f = fixtureHttp();
    const a = new AzureFoundryAdapter(f.http);
    const ref = await a.deploy(assetRequest, { accessToken: 'arm-valid' });
    expect(f.http.post).not.toHaveBeenCalled();
    const envCall = f.http.put.mock.calls.find((c: any[]) => c[0].includes('/environments/'))!;
    expect(envCall[1].properties.image).toBe('vllm/vllm-openai:latest');
    expect(envCall[1].properties.inferenceConfig).toEqual({
      livenessRoute: { path: '/health', port: 8000 },
      readinessRoute: { path: '/health', port: 8000 },
      scoringRoute: { path: '/v1/chat/completions', port: 8000 },
    });
    const model = f.http.put.mock.calls.find((c: any[]) => c[0].includes('/models/'))!;
    expect(model[1]).toEqual({ properties: { modelType: 'custom_model', modelUri: 'azureml://subscriptions/sub/resourcegroups/rg/workspaces/ws/datastores/blob/paths/q' } });
    const dep = f.http.put.mock.calls.find((c: any[]) => c[0].includes('/deployments/'))![1];
    expect(dep.properties.model).toContain('/models/almyty-abc123/versions/1');
    expect(dep.properties.modelMountPath).toBe('/var/azureml-app/model');
    expect(dep.properties.environmentVariables).toEqual({
      SERVED_MODEL_NAME: 'q',
      MODEL_ID: '/var/azureml-app/model/almyty-abc123/1',
      MAX_MODEL_LEN: '8192',
    });
    // The registry plumbing is gone: no almyty URI and no object-store keys.
    const wire = JSON.stringify(f.http.put.mock.calls.map((c: any[]) => c[1]));
    for (const forbidden of ['ALMYTY_REGISTRY_URI', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_ENDPOINT_URL', '/data/model']) {
      expect(wire).not.toContain(forbidden);
    }
    expect(ref.route).toBe('asset');
  });

  it('refuses a source Azure cannot read, naming the three it accepts, and a route with no workspace', async () => {
    const f = fixtureHttp();
    const a = new AzureFoundryAdapter(f.http);
    for (const registryUri of ['s3://registry/models/q@etag', 'gs://registry/models/q@etag', 'file:///models/q']) {
      await expect(a.deploy({ ...hubRequest, version: { ...hubRequest.version, registryUri } }, creds)).rejects.toMatchObject({ code: 'ADAPTER_UNSUPPORTED_OPERATION' });
    }
    await expect(a.deploy({ ...hubRequest, version: { ...hubRequest.version, registryUri: 's3://registry/models/q@etag' } }, creds)).rejects.toThrow(/foundry:\/\/.*hf:\/\/.*azureml:\/\//s);
    await expect(a.deploy({ ...hubRequest, providerConfig: { ...hubRequest.providerConfig, workspace: undefined } }, creds)).rejects.toMatchObject({ code: 'ADAPTER_CONFIG_INVALID' });
    expect(f.http.put).not.toHaveBeenCalled();
  });

  it('routes traffic once the deployment succeeds, scales by sku.capacity, and scales to zero by deleting the deployment', async () => {
    const f = fixtureHttp();
    const a = new AzureFoundryAdapter(f.http);
    const ref = await a.deploy(hubRequest, creds);
    const first = await a.readEndpoint(ref, creds);
    expect(first.state).toBe('deploying');
    expect(f.endpoints.get('almyty-abc123').properties.traffic).toEqual({ almyty: 100 });
    const second = await a.readEndpoint(ref, creds);
    expect(second.state).toBe('ready');
    expect(second.replicas).toBe(2);
    expect(second.details).toMatchObject({ route: 'hub', modelId: 'azureml://registries/HuggingFace/models/bert-base-uncased/labels/latest' });

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
    expect(recreated.properties.model).toBe('azureml://registries/HuggingFace/models/bert-base-uncased/labels/latest');
  });

  it('maps every documented provisioning state', async () => {
    const f = fixtureHttp();
    const a = new AzureFoundryAdapter(f.http);
    const ref = await a.deploy(hubRequest, creds);
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
    const ref = await a.deploy(hubRequest, creds);
    await a.readEndpoint(ref, creds);
    expect(f.http.post.mock.calls.filter((c: any[]) => c[0].startsWith('https://login.microsoftonline.com/')).length).toBe(1);
    await expect(a.readEndpoint(ref, { clientSecret: 'nope' })).rejects.toMatchObject({ code: 'ADAPTER_AUTH' });
  });
});
