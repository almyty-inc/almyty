import { createHash } from 'crypto';

import axios, { AxiosInstance } from 'axios';

import {
  ActualState,
  AdapterCapabilities,
  AdapterCredentials,
  CostSnapshot,
  DeployRequest,
  EndpointRef,
  ModelProviderAdapter,
  UnsupportedOperationError,
} from './adapter.interface';

/**
 * Microsoft Foundry, in the customer's own Azure subscription, driven
 * through the ARM REST API. Verified shapes are in
 * docs/design/adapters/azure-foundry.md.
 *
 * Three native paths, chosen from the version's registry URI:
 *
 *   foundry://{format}/{name}[@{version}]
 *     A model from the Foundry catalog, served as a serverless API
 *     deployment: PUT on
 *     Microsoft.CognitiveServices/accounts/{account}/deployments/{name}
 *     with properties.model {format, name, version}. Microsoft runs it;
 *     no container, no instance, no VM, and billing is per token. Chat
 *     goes to the account's OpenAI-compatible v1 base.
 *
 *   hf://{owner}/{repo}
 *     A Hugging Face model from Azure's own HuggingFace registry, put on
 *     a managed online endpoint as
 *     azureml://registries/HuggingFace/models/{name}/labels/latest.
 *     Azure supplies the serving container and pulls the weights from the
 *     Hub itself; almyty specifies no image and no environment.
 *
 *   azureml://... or https://{account}.blob.core.windows.net/...
 *     The customer's own weights, registered as a model asset and mounted
 *     into a vLLM container on a managed online endpoint. This is the only
 *     path where almyty names a container, because Azure has no curated
 *     one for arbitrary weights.
 *
 * Azure model assets read Azure Storage and the Azure registries and
 * nothing else, so an s3:// or gs:// version is refused with a typed
 * error rather than smuggled in through this backend.
 *
 * Managed online endpoints cannot idle at zero instances, so scale(0)
 * deletes the deployment and keeps the endpoint; the next scale(n)
 * recreates it from the spec kept on the ref. A serverless API deployment
 * has nothing running to stop, so scale(0) deletes it and scale(n) puts
 * it back.
 *
 * Auth is an ARM bearer token: either a ready `accessToken` or a service
 * principal (tenantId, clientId, clientSecret) exchanged at
 * login.microsoftonline.com with the client credentials grant.
 */
const ARM = 'https://management.azure.com';
const ML_API_VERSION = '2024-10-01';
const AI_API_VERSION = '2024-10-01';
const LOGIN = 'https://login.microsoftonline.com';
// Only the own-weights route names a container, and Azure pulls images
// from a registry it can reach: an Azure Container Registry reference, or
// a public image mirrored into one. The default here is a starting point
// the operator is expected to replace with their own registry path, the
// same constraint Vertex enforces.
const DEFAULT_IMAGE = 'vllm/vllm-openai:latest';
const DEFAULT_INSTANCE = 'Standard_NC24ads_A100_v4';
const DEFAULT_SKU = 'GlobalStandard';
const DEPLOYMENT_NAME = 'almyty';
const MODEL_MOUNT = '/var/azureml-app/model';
const PORT = 8000;
const HF_REGISTRY = 'azureml://registries/HuggingFace/models';

const ACCEPTED_SOURCES = 'a Foundry catalog model (foundry://{format}/{name}@{version}), a Hugging Face model from the Azure HuggingFace registry (hf://), or your own weights as an Azure model asset (azureml:// or a blob https URL)';

/** provisioningState on a managed online deployment. */
const STATE_MAP: Record<string, ActualState['state']> = {
  Creating: 'deploying',
  Updating: 'scaling',
  Scaling: 'scaling',
  Succeeded: 'ready',
  Failed: 'failed',
  Canceled: 'failed',
  Deleting: 'stopped',
};

/** DeploymentProvisioningState on a Cognitive Services deployment. */
const AI_STATE_MAP: Record<string, ActualState['state']> = {
  Accepted: 'deploying',
  Creating: 'deploying',
  Moving: 'scaling',
  Succeeded: 'ready',
  Failed: 'failed',
  Canceled: 'failed',
  Disabled: 'stopped',
  Deleting: 'stopped',
};

interface CachedToken {
  token: string;
  expiresAt: number;
}

export class AzureFoundryAdapter implements ModelProviderAdapter {
  readonly key = 'azure-foundry';
  readonly displayName = 'Microsoft Foundry';

  private readonly tokens = new Map<string, CachedToken>();

  constructor(private readonly http: AxiosInstance = axios.create({ timeout: 60_000 })) {}

  capabilities(): AdapterCapabilities {
    return {
      architectures: 'any',
      lora: 'merged',
      serverless: true,
      dedicated: true,
      scaleToZero: true,
      regions: ['eastus', 'eastus2', 'westus2', 'westus3', 'southcentralus', 'northcentralus', 'westeurope', 'northeurope', 'swedencentral', 'uksouth', 'francecentral', 'japaneast', 'australiaeast'],
      // Azure pulls a Hugging Face repository itself through its own
      // HuggingFace registry, and a catalog model needs no source at all.
      // Its model assets read Azure Storage, never S3 or GCS.
      registrySources: ['hub'],
    };
  }

  configSchema(): Record<string, any> {
    return {
      type: 'object',
      properties: {
        subscriptionId: { type: 'string', title: 'Subscription ID' },
        resourceGroup: { type: 'string', title: 'Resource group' },
        account: { type: 'string', title: 'Foundry resource name', description: 'Catalog models: the Microsoft.CognitiveServices account that serves them' },
        workspace: { type: 'string', title: 'Workspace / project name', description: 'Hugging Face and own-weights models: the Azure Machine Learning workspace that hosts the online endpoint' },
        location: { type: 'string', title: 'Region', default: 'eastus' },
        tenantId: { type: 'string', title: 'Tenant ID', description: 'Service principal login; leave empty when using an access token' },
        clientId: { type: 'string', title: 'Client ID' },
        clientSecret: { type: 'string', title: 'Client secret', 'x-secret': true },
        accessToken: { type: 'string', title: 'ARM access token', description: 'Alternative to a service principal; short lived', 'x-secret': true },
        sku: { type: 'string', title: 'Serverless deployment type', enum: ['GlobalStandard', 'DataZoneStandard', 'Standard', 'GlobalProvisionedManaged', 'DataZoneProvisionedManaged', 'ProvisionedManaged'], default: DEFAULT_SKU },
        capacity: { type: 'integer', minimum: 1, default: 1, title: 'Serverless capacity', description: 'Thousands of tokens per minute for the Standard tiers, provisioned units for the Provisioned ones' },
        raiPolicyName: { type: 'string', title: 'Content filter policy' },
        versionUpgradeOption: { type: 'string', enum: ['OnceNewDefaultVersionAvailable', 'OnceCurrentVersionExpired', 'NoAutoUpgrade'], title: 'Model version upgrades' },
        instanceType: { type: 'string', title: 'Instance type', default: DEFAULT_INSTANCE, description: 'Managed online endpoints only' },
        image: { type: 'string', title: 'Container image', default: DEFAULT_IMAGE, description: 'Own-weights model assets only; a Hugging Face registry model brings its own container' },
        authMode: { type: 'string', title: 'Endpoint auth', enum: ['Key', 'AMLToken', 'AADToken'], default: 'Key' },
        requestTimeoutSeconds: { type: 'integer', minimum: 1, maximum: 180, default: 90 },
        maxConcurrentRequestsPerInstance: { type: 'integer', minimum: 1, default: 8 },
        maxModelLen: { type: 'integer', title: 'vLLM max model length' },
        hourlyRateCents: { type: 'integer', title: 'Instance price per hour (cents)', description: 'Managed online endpoints only; Cost Management lags by a day, so this estimates spend' },
        inPerMTok: { type: 'number', title: 'Catalog input price (USD per million tokens)' },
        outPerMTok: { type: 'number', title: 'Catalog output price (USD per million tokens)' },
      },
      required: ['subscriptionId', 'resourceGroup'],
    };
  }

  private classify(err: any, fallback: string): never {
    if (typeof err?.code === 'string' && err.code.startsWith('ADAPTER_')) throw err;
    const status = err?.response?.status;
    const body = err?.response?.data;
    const code = body?.error?.code ?? body?.error ?? '';
    const message = body?.error?.message ?? body?.error_description ?? body?.message ?? err?.message ?? fallback;
    if (status === 401 || status === 403 || /invalid_client|unauthorized_client|invalid_grant/i.test(String(code))) {
      throw Object.assign(new Error(`credential rejected: ${message}`), { code: 'ADAPTER_AUTH', status });
    }
    if (status === 429 || /quota|limit/i.test(`${code} ${message}`)) throw Object.assign(new Error(`quota: ${message}`), { code: 'ADAPTER_QUOTA_EXCEEDED', status });
    if (status === 404) throw Object.assign(new Error(`not found: ${message}`), { code: 'ADAPTER_NOT_FOUND', status });
    throw Object.assign(new Error(message), { code: 'ADAPTER_ERROR', status });
  }

  /** ARM bearer: a supplied token, or one minted for the service principal and cached until shortly before expiry. */
  private async token(credentials: AdapterCredentials, ids: { tenantId?: string; clientId?: string }): Promise<string> {
    if (credentials.accessToken) return credentials.accessToken;
    const tenantId = credentials.tenantId ?? ids.tenantId;
    const clientId = credentials.clientId ?? ids.clientId;
    if (!tenantId || !clientId || !credentials.clientSecret) {
      throw Object.assign(new Error('missing Azure credential: accessToken or tenantId, clientId and clientSecret'), { code: 'ADAPTER_AUTH', status: 401 });
    }
    // Keyed on the secret as well, so a rotated or wrong secret never reuses a token minted for another.
    const cacheKey = createHash('sha256').update(`${tenantId}/${clientId}/${credentials.clientSecret}`).digest('hex');
    const cached = this.tokens.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const form = new URLSearchParams({
      client_id: clientId,
      client_secret: credentials.clientSecret,
      scope: `${ARM}/.default`,
      grant_type: 'client_credentials',
    });
    try {
      const res = await this.http.post(`${LOGIN}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, form.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      const token = res.data?.access_token;
      if (!token) throw Object.assign(new Error('token endpoint returned no access_token'), { code: 'ADAPTER_AUTH', status: 401 });
      this.tokens.set(cacheKey, { token, expiresAt: Date.now() + Number(res.data?.expires_in ?? 3599) * 1000 });
      return token;
    } catch (err: any) {
      if (err?.code === 'ADAPTER_AUTH') throw err;
      // A rejected secret comes back as 400/401 invalid_client; both mean the credential is bad.
      const status = err?.response?.status;
      if (status === 400 || status === 401) throw Object.assign(new Error(`credential rejected: ${err?.response?.data?.error_description ?? err?.response?.data?.error ?? err.message}`), { code: 'ADAPTER_AUTH', status });
      this.classify(err, 'token exchange failed');
    }
  }

  private async headers(credentials: AdapterCredentials, ids: { tenantId?: string; clientId?: string; [key: string]: any }) {
    return { Authorization: `Bearer ${await this.token(credentials, ids)}`, 'Content-Type': 'application/json' };
  }

  static endpointName(deploymentId: string): string {
    return `almyty-${deploymentId.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 20)}`;
  }

  /** Which of the three Azure paths this version asks for. */
  static route(registryUri: string): 'foundry' | 'hub' | 'asset' {
    if (registryUri.startsWith('foundry://')) return 'foundry';
    if (registryUri.startsWith('hf://')) return 'hub';
    if (registryUri.startsWith('azureml://') || /^https:\/\/[^/]+\.blob\.core\.windows\.net\//.test(registryUri)) return 'asset';
    throw new UnsupportedOperationError('azure-foundry', `a ${registryUri.split(':')[0]}:// version. Azure serves ${ACCEPTED_SOURCES}`);
  }

  /** `properties.model` for a foundry:// version. */
  static catalogModel(registryUri: string): { format: string; name: string; version?: string } {
    const [ref, version] = registryUri.slice('foundry://'.length).split('@');
    const slash = ref.indexOf('/');
    if (slash <= 0 || slash === ref.length - 1) {
      throw new UnsupportedOperationError('azure-foundry', `the catalog reference "${ref}". Use foundry://{format}/{name}@{version}, for example foundry://OpenAI/gpt-4o@2024-11-20`);
    }
    return { format: ref.slice(0, slash), name: ref.slice(slash + 1), ...(version ? { version } : {}) };
  }

  /** The Azure HuggingFace registry asset for an hf:// version. */
  static hubModelId(registryUri: string): string {
    const name = registryUri.slice('hf://'.length).split('@')[0];
    if (!name) throw new UnsupportedOperationError('azure-foundry', 'an hf:// version with no repository');
    return `${HF_REGISTRY}/${name}/labels/latest`;
  }

  private workspaceUrl(ref: { subscriptionId: string; resourceGroup: string; workspace: string }): string {
    return `${ARM}/subscriptions/${encodeURIComponent(ref.subscriptionId)}/resourceGroups/${encodeURIComponent(ref.resourceGroup)}/providers/Microsoft.MachineLearningServices/workspaces/${encodeURIComponent(ref.workspace)}`;
  }

  private accountUrl(ref: { subscriptionId: string; resourceGroup: string; account: string }): string {
    return `${ARM}/subscriptions/${encodeURIComponent(ref.subscriptionId)}/resourceGroups/${encodeURIComponent(ref.resourceGroup)}/providers/Microsoft.CognitiveServices/accounts/${encodeURIComponent(ref.account)}`;
  }

  private endpointUrl(ref: EndpointRef): string {
    return `${this.workspaceUrl(ref as any)}/onlineEndpoints/${encodeURIComponent(ref.endpointName)}`;
  }

  private deploymentUrl(ref: EndpointRef): string {
    return ref.route === 'foundry'
      ? `${this.accountUrl(ref as any)}/deployments/${encodeURIComponent(ref.deploymentName)}`
      : `${this.endpointUrl(ref)}/deployments/${encodeURIComponent(ref.deploymentName)}`;
  }

  private withVersion(url: string, apiVersion = ML_API_VERSION): string {
    return `${url}?api-version=${apiVersion}`;
  }

  /** The OpenAI-compatible v1 base of a Foundry account. */
  static openAiBase(accountEndpoint: string): string {
    return `${accountEndpoint.replace(/\/+$/, '')}/openai/v1`;
  }

  async deploy(request: DeployRequest, credentials: AdapterCredentials): Promise<EndpointRef> {
    const route = AzureFoundryAdapter.route(request.version.registryUri);
    return route === 'foundry'
      ? this.deployCatalog(request, credentials)
      : this.deployOnlineEndpoint(request, credentials, route);
  }

  /** A listed model: Microsoft runs it, and we create only the deployment resource that names it. */
  private async deployCatalog(request: DeployRequest, credentials: AdapterCredentials): Promise<EndpointRef> {
    const cfg = request.providerConfig;
    const ids = { tenantId: cfg.tenantId, clientId: cfg.clientId };
    if (!cfg.account) {
      throw Object.assign(new Error('a foundry:// version needs `account`: the Microsoft.CognitiveServices resource that serves the catalog'), { code: 'ADAPTER_CONFIG_INVALID' });
    }
    const model = AzureFoundryAdapter.catalogModel(request.version.registryUri);
    const ref: EndpointRef = {
      route: 'foundry',
      subscriptionId: cfg.subscriptionId,
      resourceGroup: cfg.resourceGroup,
      account: cfg.account,
      ...ids,
      location: request.desired.region ?? cfg.location ?? 'eastus',
      deploymentName: AzureFoundryAdapter.endpointName(request.deploymentId),
      createdAt: new Date().toISOString(),
      model,
      skuName: cfg.sku ?? DEFAULT_SKU,
      capacity: Math.max(1, cfg.capacity ?? 1),
      raiPolicyName: cfg.raiPolicyName,
      versionUpgradeOption: cfg.versionUpgradeOption,
      inPerMTok: cfg.inPerMTok,
      outPerMTok: cfg.outPerMTok,
    };
    try {
      const headers = await this.headers(credentials, ids);
      const account = (await this.http.get(this.withVersion(this.accountUrl(ref as any), AI_API_VERSION), { headers })).data;
      ref.accountEndpoint = account?.properties?.endpoint;
      await this.http.put(this.withVersion(this.deploymentUrl(ref), AI_API_VERSION), this.catalogBody(ref, ref.capacity, request), { headers });
      if (ref.accountEndpoint) ref.url = `${AzureFoundryAdapter.openAiBase(ref.accountEndpoint)}/chat/completions`;
      return ref;
    } catch (err) {
      this.classify(err, 'create serverless deployment failed');
    }
  }

  private catalogBody(ref: EndpointRef, capacity: number, request?: DeployRequest) {
    return {
      sku: { name: ref.skuName, capacity },
      properties: {
        model: ref.model,
        ...(ref.raiPolicyName ? { raiPolicyName: ref.raiPolicyName } : {}),
        ...(ref.versionUpgradeOption ? { versionUpgradeOption: ref.versionUpgradeOption } : {}),
      },
      ...(request
        ? { tags: { 'almyty-deployment': request.deploymentId, 'almyty-organization': request.organizationId } }
        : {}),
    };
  }

  /** Hugging Face or own weights: a managed online endpoint with one deployment. */
  private async deployOnlineEndpoint(request: DeployRequest, credentials: AdapterCredentials, route: 'hub' | 'asset'): Promise<EndpointRef> {
    const cfg = request.providerConfig;
    const ids = { tenantId: cfg.tenantId, clientId: cfg.clientId };
    if (!cfg.workspace) {
      throw Object.assign(new Error(`a ${route === 'hub' ? 'hf://' : 'model asset'} version needs \`workspace\`: the Azure Machine Learning workspace that hosts the online endpoint`), { code: 'ADAPTER_CONFIG_INVALID' });
    }
    const name = AzureFoundryAdapter.endpointName(request.deploymentId);
    const uri = request.version.registryUri;

    const base = { subscriptionId: cfg.subscriptionId, resourceGroup: cfg.resourceGroup, workspace: cfg.workspace };
    const ref: EndpointRef = {
      ...base,
      ...ids,
      route,
      location: request.desired.region ?? cfg.location ?? 'eastus',
      endpointName: name,
      deploymentName: DEPLOYMENT_NAME,
      createdAt: new Date().toISOString(),
      hourlyRateCents: cfg.hourlyRateCents ?? 0,
      authMode: cfg.authMode ?? 'Key',
      spec: {
        instanceType: request.desired.hardware ?? cfg.instanceType ?? DEFAULT_INSTANCE,
        requestTimeoutSeconds: cfg.requestTimeoutSeconds ?? 90,
        maxConcurrentRequestsPerInstance: cfg.maxConcurrentRequestsPerInstance ?? 8,
        env: {},
      },
    };
    const capacity = Math.max(1, request.desired.replicas ?? request.desired.minScale ?? 1);

    try {
      const headers = await this.headers(credentials, ids);
      const ws = this.workspaceUrl(base);

      if (route === 'hub') {
        // Azure's own registry asset: it brings the container and pulls
        // the weights from the Hub. No environment, no image, no env vars.
        ref.spec.modelId = AzureFoundryAdapter.hubModelId(uri);
      } else {
        const envRes = await this.http.put(
          this.withVersion(`${ws}/environments/${name}/versions/1`),
          {
            properties: {
              image: cfg.image ?? DEFAULT_IMAGE,
              osType: 'Linux',
              inferenceConfig: {
                livenessRoute: { path: '/health', port: PORT },
                readinessRoute: { path: '/health', port: PORT },
                scoringRoute: { path: '/v1/chat/completions', port: PORT },
              },
            },
          },
          { headers },
        );
        ref.spec.environmentId = envRes.data?.id ?? `${ws.slice(ARM.length)}/environments/${name}/versions/1`;
        const modelRes = await this.http.put(
          this.withVersion(`${ws}/models/${name}/versions/1`),
          { properties: { modelType: 'custom_model', modelUri: uri.split('@')[0] } },
          { headers },
        );
        ref.spec.modelId = modelRes.data?.id ?? `${ws.slice(ARM.length)}/models/${name}/versions/1`;
        ref.spec.env = {
          SERVED_MODEL_NAME: request.version.name,
          MODEL_ID: `${MODEL_MOUNT}/${name}/1`,
          ...(request.desired.quantization ? { QUANTIZATION: request.desired.quantization } : {}),
          ...(cfg.maxModelLen ? { MAX_MODEL_LEN: String(cfg.maxModelLen) } : {}),
        };
      }

      const epRes = await this.http.put(
        this.withVersion(this.endpointUrl(ref)),
        { location: ref.location, identity: { type: 'SystemAssigned' }, properties: { authMode: ref.authMode } },
        { headers },
      );
      ref.url = epRes.data?.properties?.scoringUri;

      await this.http.put(this.withVersion(this.deploymentUrl(ref)), this.deploymentBody(ref, capacity), { headers });
      return ref;
    } catch (err) {
      this.classify(err, 'create deployment failed');
    }
  }

  private deploymentBody(ref: EndpointRef, capacity: number) {
    const spec = ref.spec;
    return {
      location: ref.location,
      sku: { name: 'Default', capacity },
      properties: {
        endpointComputeType: 'Managed',
        instanceType: spec.instanceType,
        ...(spec.environmentId ? { environmentId: spec.environmentId } : {}),
        ...(Object.keys(spec.env ?? {}).length ? { environmentVariables: spec.env } : {}),
        ...(spec.modelId ? { model: spec.modelId, ...(ref.route === 'asset' ? { modelMountPath: MODEL_MOUNT } : {}) } : {}),
        scaleSettings: { scaleType: 'Default' },
        requestSettings: { requestTimeout: `PT${spec.requestTimeoutSeconds}S`, maxConcurrentRequestsPerInstance: spec.maxConcurrentRequestsPerInstance },
        // Weights load before the server answers, so give the probes minutes rather than the default seconds.
        livenessProbe: { initialDelay: 'PT60S', period: 'PT30S', timeout: 'PT10S', failureThreshold: 30 },
        readinessProbe: { initialDelay: 'PT60S', period: 'PT30S', timeout: 'PT10S', failureThreshold: 60 },
        startupProbe: { initialDelay: 'PT60S', period: 'PT30S', timeout: 'PT10S', failureThreshold: 60 },
      },
    };
  }

  async readEndpoint(ref: EndpointRef, credentials: AdapterCredentials): Promise<ActualState> {
    let headers: Record<string, string>;
    try {
      headers = await this.headers(credentials, ref);
    } catch (err) {
      this.classify(err, 'auth failed');
    }
    return ref.route === 'foundry' ? this.readCatalog(ref, headers) : this.readOnlineEndpoint(ref, headers);
  }

  private async readCatalog(ref: EndpointRef, headers: Record<string, string>): Promise<ActualState> {
    let account: any;
    try {
      account = (await this.http.get(this.withVersion(this.accountUrl(ref as any), AI_API_VERSION), { headers })).data;
    } catch (err: any) {
      if (err?.response?.status === 404) return { state: 'missing', message: 'Foundry account not found' };
      this.classify(err, 'read Foundry account failed');
    }
    const endpoint = account?.properties?.endpoint ?? ref.accountEndpoint;
    const openAiBase = endpoint ? AzureFoundryAdapter.openAiBase(endpoint) : undefined;
    let deployment: any;
    try {
      deployment = (await this.http.get(this.withVersion(this.deploymentUrl(ref), AI_API_VERSION), { headers })).data;
    } catch (err: any) {
      if (err?.response?.status === 404) {
        return { state: 'stopped', url: ref.url, openAiBase, replicas: 0, region: account?.location, message: 'no serverless deployment; scaled to zero' };
      }
      this.classify(err, 'read serverless deployment failed');
    }
    const raw = String(deployment?.properties?.provisioningState ?? 'Creating');
    return {
      state: AI_STATE_MAP[raw] ?? 'deploying',
      url: openAiBase ? `${openAiBase}/chat/completions` : ref.url,
      openAiBase,
      // Nothing of ours runs: Microsoft serves it and bills the tokens.
      replicas: 1,
      region: account?.location ?? ref.location,
      details: {
        route: 'foundry',
        rawState: raw,
        // What to put in the OpenAI request's `model` field.
        modelId: deployment?.name ?? ref.deploymentName,
        model: deployment?.properties?.model ?? ref.model,
        sku: deployment?.sku,
        capabilities: deployment?.properties?.capabilities,
      },
    };
  }

  private async readOnlineEndpoint(ref: EndpointRef, headers: Record<string, string>): Promise<ActualState> {
    let endpoint: any;
    try {
      endpoint = (await this.http.get(this.withVersion(this.endpointUrl(ref)), { headers })).data;
    } catch (err: any) {
      if (err?.response?.status === 404) return { state: 'missing', message: 'endpoint not found' };
      this.classify(err, 'read endpoint failed');
    }
    const url = endpoint?.properties?.scoringUri ?? ref.url;
    let deployment: any;
    try {
      deployment = (await this.http.get(this.withVersion(this.deploymentUrl(ref)), { headers })).data;
    } catch (err: any) {
      if (err?.response?.status === 404) {
        return { state: 'stopped', url, replicas: 0, region: endpoint?.location, message: 'no deployment; scaled to zero', details: { route: ref.route, endpointState: endpoint?.properties?.provisioningState } };
      }
      this.classify(err, 'read deployment failed');
    }
    const raw = String(deployment?.properties?.provisioningState ?? 'Creating');
    let state = STATE_MAP[raw] ?? 'deploying';
    const traffic = endpoint?.properties?.traffic ?? {};
    if (state === 'ready' && traffic[ref.deploymentName] !== 100) {
      // ARM refuses traffic to a deployment that does not exist yet, so it is routed once the deployment has succeeded.
      try {
        await this.http.put(
          this.withVersion(this.endpointUrl(ref)),
          { location: ref.location, identity: { type: 'SystemAssigned' }, properties: { authMode: ref.authMode, traffic: { [ref.deploymentName]: 100 } } },
          { headers },
        );
      } catch (err) {
        this.classify(err, 'route traffic failed');
      }
      state = 'deploying';
    }
    return {
      state,
      url,
      replicas: typeof deployment?.sku?.capacity === 'number' ? deployment.sku.capacity : undefined,
      hardware: deployment?.properties?.instanceType,
      region: deployment?.location ?? endpoint?.location,
      message: state === 'deploying' && raw === 'Succeeded' ? 'routing traffic' : undefined,
      details: { route: ref.route, rawState: raw, endpointState: endpoint?.properties?.provisioningState, traffic, authMode: ref.authMode, chatCompletionsOnly: true, modelId: ref.spec?.modelId },
    };
  }

  async scale(ref: EndpointRef, replicas: number, credentials: AdapterCredentials): Promise<void> {
    try {
      const headers = await this.headers(credentials, ref);
      const apiVersion = ref.route === 'foundry' ? AI_API_VERSION : ML_API_VERSION;
      const url = this.withVersion(this.deploymentUrl(ref), apiVersion);
      if (replicas === 0) {
        await this.http.delete(url, { headers }).catch((err: any) => {
          if (err?.response?.status !== 404) throw err;
        });
        return;
      }
      if (ref.route === 'foundry') {
        // A serverless deployment has no replicas: capacity is a token
        // rate, set by the operator, not derived from a replica count.
        await this.http.put(url, this.catalogBody(ref, ref.capacity ?? 1), { headers });
        return;
      }
      const existing = await this.http.get(url, { headers }).catch((err: any) => {
        if (err?.response?.status === 404) return null;
        throw err;
      });
      if (!existing) {
        await this.http.put(url, this.deploymentBody(ref, replicas), { headers });
        return;
      }
      await this.http.patch(url, { sku: { name: existing.data?.sku?.name ?? 'Default', capacity: replicas } }, { headers });
    } catch (err) {
      this.classify(err, 'scale failed');
    }
  }

  async teardown(ref: EndpointRef, credentials: AdapterCredentials): Promise<void> {
    try {
      const headers = await this.headers(credentials, ref);
      // Deleting the endpoint removes its deployments; the environment and model assets stay in the workspace as history.
      const url = ref.route === 'foundry'
        ? this.withVersion(this.deploymentUrl(ref), AI_API_VERSION)
        : this.withVersion(this.endpointUrl(ref));
      await this.http.delete(url, { headers });
    } catch (err: any) {
      if (err?.response?.status === 404) return;
      this.classify(err, 'delete failed');
    }
  }

  /**
   * Cost Management reports a day late, so an online endpoint's spend is
   * the configured instance rate over observed running time. A serverless
   * catalog deployment has no hourly rate at all: it bills per token, and
   * the operator's per-token prices are reported as-is.
   */
  async costSnapshot(ref: EndpointRef, credentials: AdapterCredentials): Promise<CostSnapshot> {
    const actual = await this.readEndpoint(ref, credentials);
    if (ref.route === 'foundry') {
      const inPerMTok = Number(ref.inPerMTok ?? 0);
      const outPerMTok = Number(ref.outPerMTok ?? 0);
      return {
        spentCents: 0,
        ratePerHourCents: 0,
        ...(inPerMTok || outPerMTok ? { perToken: { inPerMTok, outPerMTok, currency: 'USD' } } : {}),
        observedAt: new Date(),
      };
    }
    const rate = Number(ref.hourlyRateCents ?? 0);
    const running = actual.state === 'ready' || actual.state === 'scaling' || actual.state === 'deploying' ? actual.replicas ?? 1 : 0;
    const hours = ref.createdAt ? Math.max(0, (Date.now() - new Date(ref.createdAt).getTime()) / 3_600_000) : 0;
    return { spentCents: Math.round(rate * hours), ratePerHourCents: rate * running, observedAt: new Date() };
  }
}
