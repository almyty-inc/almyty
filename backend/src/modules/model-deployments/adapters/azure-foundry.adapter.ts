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
} from './adapter.interface';

/**
 * Azure AI Foundry / Azure Machine Learning managed online endpoints, driven
 * through the ARM REST API (api-version 2024-10-01). Verified shapes are in
 * docs/design/adapters/azure-foundry.md.
 *
 * Deploy registers an environment (the vLLM image with liveness, readiness
 * and scoring routes on port 8000), an endpoint with key auth, and one
 * managed deployment whose sku.capacity is the instance count. An S3
 * registry version is served the same way as on Hugging Face: the container
 * gets ALMYTY_REGISTRY_URI plus the registry's read keys in its environment
 * and loads from /data/model. An azureml:// or blob version is registered as
 * a model asset and mounted. Managed endpoints cannot idle at zero
 * instances, so scale(0) deletes the deployment and keeps the endpoint; the
 * next scale(n) recreates it from the spec kept on the ref.
 *
 * Auth is an ARM bearer token: either a ready `accessToken` or a service
 * principal (tenantId, clientId, clientSecret) exchanged at
 * login.microsoftonline.com with the client credentials grant.
 */
const ARM = 'https://management.azure.com';
const API_VERSION = '2024-10-01';
const LOGIN = 'https://login.microsoftonline.com';
const DEFAULT_IMAGE = 'vllm/vllm-openai:latest';
const DEFAULT_INSTANCE = 'Standard_NC24ads_A100_v4';
const DEPLOYMENT_NAME = 'almyty';
const MODEL_MOUNT = '/var/azureml-app/model';
const PORT = 8000;

const STATE_MAP: Record<string, ActualState['state']> = {
  Creating: 'deploying',
  Updating: 'scaling',
  Scaling: 'scaling',
  Succeeded: 'ready',
  Failed: 'failed',
  Canceled: 'failed',
  Deleting: 'stopped',
};

interface CachedToken {
  token: string;
  expiresAt: number;
}

export class AzureFoundryAdapter implements ModelProviderAdapter {
  readonly key = 'azure-foundry';
  readonly displayName = 'Azure AI Foundry (managed online endpoints)';

  private readonly tokens = new Map<string, CachedToken>();

  constructor(private readonly http: AxiosInstance = axios.create({ timeout: 60_000 })) {}

  capabilities(): AdapterCapabilities {
    return {
      architectures: 'any',
      lora: 'merged',
      serverless: false,
      dedicated: true,
      scaleToZero: true,
      regions: ['eastus', 'eastus2', 'westus2', 'westus3', 'southcentralus', 'northcentralus', 'westeurope', 'northeurope', 'swedencentral', 'uksouth', 'francecentral', 'japaneast', 'australiaeast'],
      registrySources: ['s3', 'hub'],
    };
  }

  configSchema(): Record<string, any> {
    return {
      type: 'object',
      properties: {
        subscriptionId: { type: 'string', title: 'Subscription ID' },
        resourceGroup: { type: 'string', title: 'Resource group' },
        workspace: { type: 'string', title: 'Workspace / Foundry project name' },
        location: { type: 'string', title: 'Region', default: 'eastus' },
        tenantId: { type: 'string', title: 'Tenant ID', description: 'Service principal login; leave empty when using an access token' },
        clientId: { type: 'string', title: 'Client ID' },
        clientSecret: { type: 'string', title: 'Client secret', 'x-secret': true },
        accessToken: { type: 'string', title: 'ARM access token', description: 'Alternative to a service principal; short lived', 'x-secret': true },
        instanceType: { type: 'string', title: 'Instance type', default: DEFAULT_INSTANCE },
        image: { type: 'string', title: 'Container image', default: DEFAULT_IMAGE },
        authMode: { type: 'string', title: 'Endpoint auth', enum: ['Key', 'AMLToken', 'AADToken'], default: 'Key' },
        requestTimeoutSeconds: { type: 'integer', minimum: 1, maximum: 180, default: 90 },
        maxConcurrentRequestsPerInstance: { type: 'integer', minimum: 1, default: 8 },
        maxModelLen: { type: 'integer', title: 'vLLM max model length' },
        hourlyRateCents: { type: 'integer', title: 'Instance price per hour (cents)', description: 'Cost Management lags by a day; used to estimate spend' },
        registryAccessKeyId: { type: 'string', title: 'Registry access key (S3 source)', 'x-secret': true },
        registrySecretAccessKey: { type: 'string', title: 'Registry secret key (S3 source)', 'x-secret': true },
        registryEndpoint: { type: 'string', title: 'Registry endpoint (S3 source)' },
        hfToken: { type: 'string', title: 'Hugging Face token (gated hub models)', 'x-secret': true },
      },
      required: ['subscriptionId', 'resourceGroup', 'workspace'],
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

  private workspaceUrl(ref: { subscriptionId: string; resourceGroup: string; workspace: string }): string {
    return `${ARM}/subscriptions/${encodeURIComponent(ref.subscriptionId)}/resourceGroups/${encodeURIComponent(ref.resourceGroup)}/providers/Microsoft.MachineLearningServices/workspaces/${encodeURIComponent(ref.workspace)}`;
  }

  private endpointUrl(ref: EndpointRef): string {
    return `${this.workspaceUrl(ref as any)}/onlineEndpoints/${encodeURIComponent(ref.endpointName)}`;
  }

  private deploymentUrl(ref: EndpointRef): string {
    return `${this.endpointUrl(ref)}/deployments/${encodeURIComponent(ref.deploymentName)}`;
  }

  private withVersion(url: string): string {
    return `${url}?api-version=${API_VERSION}`;
  }

  /** Secrets never live on the ref; they are re-read from credentials whenever the deployment is (re)created. */
  private secretEnv(ref: EndpointRef, credentials: AdapterCredentials): Record<string, string> {
    if (ref.source === 'hub') return credentials.hfToken ? { HF_TOKEN: credentials.hfToken } : {};
    if (ref.source === 's3') {
      return {
        ...(credentials.registryAccessKeyId ? { AWS_ACCESS_KEY_ID: credentials.registryAccessKeyId } : {}),
        ...(credentials.registrySecretAccessKey ? { AWS_SECRET_ACCESS_KEY: credentials.registrySecretAccessKey } : {}),
      };
    }
    return {};
  }

  private deploymentBody(ref: EndpointRef, capacity: number, credentials: AdapterCredentials) {
    const spec = ref.spec;
    return {
      location: ref.location,
      sku: { name: 'Default', capacity },
      properties: {
        endpointComputeType: 'Managed',
        instanceType: spec.instanceType,
        environmentId: spec.environmentId,
        environmentVariables: { ...spec.env, ...this.secretEnv(ref, credentials) },
        ...(spec.modelId ? { model: spec.modelId, modelMountPath: MODEL_MOUNT } : {}),
        scaleSettings: { scaleType: 'Default' },
        requestSettings: { requestTimeout: `PT${spec.requestTimeoutSeconds}S`, maxConcurrentRequestsPerInstance: spec.maxConcurrentRequestsPerInstance },
        // Weights load before the server answers, so give the probes minutes rather than the default seconds.
        livenessProbe: { initialDelay: 'PT60S', period: 'PT30S', timeout: 'PT10S', failureThreshold: 30 },
        readinessProbe: { initialDelay: 'PT60S', period: 'PT30S', timeout: 'PT10S', failureThreshold: 60 },
        startupProbe: { initialDelay: 'PT60S', period: 'PT30S', timeout: 'PT10S', failureThreshold: 60 },
      },
    };
  }

  async deploy(request: DeployRequest, credentials: AdapterCredentials): Promise<EndpointRef> {
    const cfg = request.providerConfig;
    const ids = { tenantId: cfg.tenantId, clientId: cfg.clientId };
    const name = AzureFoundryAdapter.endpointName(request.deploymentId);
    const uri = request.version.registryUri;
    const fromHub = uri.startsWith('hf://');
    const fromAzure = uri.startsWith('azureml://') || /^https:\/\/[^/]+\.blob\.core\.windows\.net\//.test(uri);
    const hub = fromHub ? uri.slice('hf://'.length).split('@') : null;
    const servedName = request.version.name;

    const env: Record<string, string> = {
      SERVED_MODEL_NAME: servedName,
      ...(request.desired.quantization ? { QUANTIZATION: request.desired.quantization } : {}),
      ...(cfg.maxModelLen ? { MAX_MODEL_LEN: String(cfg.maxModelLen) } : {}),
    };
    if (fromHub) {
      env.MODEL_ID = hub![0];
      env.MODEL_REVISION = hub![1] ?? 'main';
    } else if (fromAzure) {
      env.MODEL_ID = `${MODEL_MOUNT}/${name}/1`;
    } else {
      env.ALMYTY_REGISTRY_URI = uri;
      env.MODEL_ID = '/data/model';
      if (cfg.registryEndpoint) env.AWS_ENDPOINT_URL = cfg.registryEndpoint;
    }

    const base = { subscriptionId: cfg.subscriptionId, resourceGroup: cfg.resourceGroup, workspace: cfg.workspace };
    const ref: EndpointRef = {
      ...base,
      ...ids,
      location: request.desired.region ?? cfg.location ?? 'eastus',
      endpointName: name,
      deploymentName: DEPLOYMENT_NAME,
      source: fromHub ? 'hub' : fromAzure ? 'azure' : 's3',
      createdAt: new Date().toISOString(),
      hourlyRateCents: cfg.hourlyRateCents ?? 0,
      authMode: cfg.authMode ?? 'Key',
      spec: {
        instanceType: request.desired.hardware ?? cfg.instanceType ?? DEFAULT_INSTANCE,
        env,
        requestTimeoutSeconds: cfg.requestTimeoutSeconds ?? 90,
        maxConcurrentRequestsPerInstance: cfg.maxConcurrentRequestsPerInstance ?? 8,
      },
    };
    const capacity = Math.max(1, request.desired.replicas ?? request.desired.minScale ?? 1);

    try {
      const headers = await this.headers(credentials, ids);
      const ws = this.workspaceUrl(base);

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

      if (fromAzure) {
        const modelRes = await this.http.put(
          this.withVersion(`${ws}/models/${name}/versions/1`),
          { properties: { modelType: 'custom_model', modelUri: uri.split('@')[0] } },
          { headers },
        );
        ref.spec.modelId = modelRes.data?.id ?? `${ws.slice(ARM.length)}/models/${name}/versions/1`;
      }

      const epRes = await this.http.put(
        this.withVersion(this.endpointUrl(ref)),
        { location: ref.location, identity: { type: 'SystemAssigned' }, properties: { authMode: ref.authMode } },
        { headers },
      );
      ref.url = epRes.data?.properties?.scoringUri;

      await this.http.put(this.withVersion(this.deploymentUrl(ref)), this.deploymentBody(ref, capacity, credentials), { headers });
      return ref;
    } catch (err) {
      this.classify(err, 'create deployment failed');
    }
  }

  async readEndpoint(ref: EndpointRef, credentials: AdapterCredentials): Promise<ActualState> {
    let headers: Record<string, string>;
    try {
      headers = await this.headers(credentials, ref);
    } catch (err) {
      this.classify(err, 'auth failed');
    }
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
        return { state: 'stopped', url, replicas: 0, region: endpoint?.location, message: 'no deployment; scaled to zero', details: { endpointState: endpoint?.properties?.provisioningState } };
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
      details: { rawState: raw, endpointState: endpoint?.properties?.provisioningState, traffic, authMode: ref.authMode, chatCompletionsOnly: true },
    };
  }

  async scale(ref: EndpointRef, replicas: number, credentials: AdapterCredentials): Promise<void> {
    try {
      const headers = await this.headers(credentials, ref);
      const url = this.withVersion(this.deploymentUrl(ref));
      if (replicas === 0) {
        await this.http.delete(url, { headers }).catch((err: any) => {
          if (err?.response?.status !== 404) throw err;
        });
        return;
      }
      const existing = await this.http.get(url, { headers }).catch((err: any) => {
        if (err?.response?.status === 404) return null;
        throw err;
      });
      if (!existing) {
        await this.http.put(url, this.deploymentBody(ref, replicas, credentials), { headers });
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
      await this.http.delete(this.withVersion(this.endpointUrl(ref)), { headers });
    } catch (err: any) {
      if (err?.response?.status === 404) return;
      this.classify(err, 'delete failed');
    }
  }

  /** Cost Management reports a day late, so spend is the configured instance rate over observed running time. */
  async costSnapshot(ref: EndpointRef, credentials: AdapterCredentials): Promise<CostSnapshot> {
    const actual = await this.readEndpoint(ref, credentials);
    const rate = Number(ref.hourlyRateCents ?? 0);
    const running = actual.state === 'ready' || actual.state === 'scaling' || actual.state === 'deploying' ? actual.replicas ?? 1 : 0;
    const hours = ref.createdAt ? Math.max(0, (Date.now() - new Date(ref.createdAt).getTime()) / 3_600_000) : 0;
    return { spentCents: Math.round(rate * hours), ratePerHourCents: rate * running, observedAt: new Date() };
  }
}
