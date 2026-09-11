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
 * Nebius Token Factory dedicated endpoints. Verified shapes are in
 * docs/design/adapters/nebius.md.
 *
 * A dedicated endpoint is Nebius' own isolated deployment of a supported
 * model template. Control plane is https://api.tokenfactory.nebius.com
 * with a Token Factory API key as the bearer:
 *
 *   POST   /v0/dedicated_endpoints            create
 *   GET    /v0/dedicated_endpoints/{id}       read
 *   PATCH  /v0/dedicated_endpoints/{id}       enable, disable, rescale
 *   DELETE /v0/dedicated_endpoints/{id}       remove
 *
 * The endpoint is addressed on the region's data plane,
 * https://api.tokenfactory.<region>.nebius.com/v1, with the endpoint's
 * `routing_key` as the OpenAI `model`. Nebius pulls the weights; nothing
 * passes through almyty.
 *
 * `scaling.min_replicas` cannot go below 1, so scale(0) disables the
 * endpoint instead: an endpoint is "billable when at least one replica is
 * running", and a disabled one runs none.
 */
const DEFAULT_API_HOST = 'https://api.tokenfactory.nebius.com';
const DEFAULT_REGION = 'us-central1';
const DEFAULT_GPU_TYPE = 'gpu-h100-sxm';

const STATUS_MAP: Record<string, ActualState['state']> = {
  starting: 'deploying',
  running: 'ready',
  updating: 'scaling',
  stopping: 'scaling',
  stopped: 'stopped',
  error: 'failed',
};

export class NebiusAdapter implements ModelProviderAdapter {
  readonly key = 'nebius';
  readonly displayName = 'Nebius Token Factory (dedicated endpoint)';

  constructor(private readonly http: AxiosInstance = axios.create({ timeout: 60_000 })) {}

  capabilities(): AdapterCapabilities {
    return {
      architectures: 'any',
      lora: 'merged',
      serverless: false,
      dedicated: true,
      // Disabling the endpoint leaves no replica running, and Nebius only
      // bills a dedicated endpoint while one is.
      scaleToZero: true,
      regions: ['eu-north1', 'eu-west1', 'eu-west2', 'us-central1', 'us-north1', 'me-west1', 'uk-south1'],
      // Nebius serves its own model templates. The template is named after
      // the upstream repository, so a hub version maps straight onto it;
      // object storage is not a source Token Factory reads.
      registrySources: ['hub'],
    };
  }

  configSchema(): Record<string, any> {
    return {
      type: 'object',
      properties: {
        apiToken: { type: 'string', title: 'Token Factory API key', 'x-secret': true },
        apiHost: { type: 'string', title: 'Control plane host', default: DEFAULT_API_HOST },
        dataPlaneHost: { type: 'string', title: 'Data plane host', description: 'Defaults to https://api.tokenfactory.<region>.nebius.com' },
        region: { type: 'string', title: 'Region', default: DEFAULT_REGION },
        modelName: { type: 'string', title: 'Model template', description: 'Overrides the version; must be a Token Factory model_name from GET /v0/dedicated_endpoints/templates' },
        flavorName: { type: 'string', title: 'Flavor', description: 'The performance template that goes with the model, from the same templates listing' },
        gpuType: { type: 'string', title: 'GPU', enum: ['gpu-l40s-d', 'gpu-l40s-a', 'gpu-h100-sxm', 'gpu-h200-sxm', 'gpu-b200-sxm', 'gpu-b200-sxm-a', 'gpu-b300-sxm'], default: DEFAULT_GPU_TYPE },
        gpuCount: { type: 'integer', minimum: 1, default: 1 },
        customWeightsId: { type: 'string', title: 'Custom weights id', description: 'Weights Nebius already holds in the Custom Weights Hub; the feature is a beta enabled on request' },
        hourlyRateCents: { type: 'integer', title: 'Price per GPU hour (cents)', description: 'Nebius exposes no usage API; used to estimate spend' },
      },
      required: ['apiToken', 'flavorName'],
    };
  }

  private headers(credentials: AdapterCredentials) {
    if (!credentials.apiToken) throw Object.assign(new Error('missing Nebius Token Factory API key'), { code: 'ADAPTER_AUTH', status: 401 });
    return { Authorization: `Bearer ${credentials.apiToken}`, 'Content-Type': 'application/json' };
  }

  private classify(err: any, fallback: string): never {
    if (typeof err?.code === 'string' && err.code.startsWith('ADAPTER_')) throw err;
    const status = err?.response?.status;
    const body = err?.response?.data;
    const message = body?.detail ?? body?.message ?? body?.error ?? err?.message ?? fallback;
    if (status === 401 || status === 403) throw Object.assign(new Error(`credential rejected: ${message}`), { code: 'ADAPTER_AUTH', status });
    if (/unknown model|model_name|no such template|not a supported model/i.test(String(message))) {
      throw Object.assign(new Error(`unsupported model: ${message}`), { code: 'ADAPTER_UNSUPPORTED_ARCHITECTURE', status });
    }
    if (status === 429 || /quota|limit|capacity|no reservation|RESOURCE_EXHAUSTED/i.test(String(message))) {
      throw Object.assign(new Error(`quota: ${message}`), { code: 'ADAPTER_QUOTA_EXCEEDED', status });
    }
    if (status === 404) throw Object.assign(new Error(`not found: ${message}`), { code: 'ADAPTER_NOT_FOUND', status });
    throw Object.assign(new Error(message), { code: 'ADAPTER_ERROR', status });
  }

  static endpointName(deploymentId: string): string {
    return `almyty-${deploymentId.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 20)}`;
  }

  /** Routing keys must start with `dedicated/` and be 11 to 128 characters. */
  static routingKey(deploymentId: string): string {
    return `dedicated/${NebiusAdapter.endpointName(deploymentId)}`;
  }

  /** The model template Nebius is asked for. */
  static modelName(request: DeployRequest): string {
    const cfg = request.providerConfig ?? {};
    if (cfg.modelName) return String(cfg.modelName);
    const uri = request.version.registryUri;
    if (uri.startsWith('hf://')) return uri.slice('hf://'.length).split('@')[0];
    throw Object.assign(
      new Error(
        'Nebius Token Factory serves its own model templates; point the version at hf://org/repo for a model Nebius supports, ' +
          'or set providerConfig.modelName to a model_name from GET /v0/dedicated_endpoints/templates',
      ),
      { code: 'ADAPTER_UNSUPPORTED_SOURCE' },
    );
  }

  private static host(source: { apiHost?: string; [key: string]: any }): string {
    return String(source.apiHost ?? DEFAULT_API_HOST).replace(/\/+$/, '');
  }

  private static dataPlane(source: { dataPlaneHost?: string; region?: string; [key: string]: any }): string {
    const explicit = source.dataPlaneHost ? String(source.dataPlaneHost) : `https://api.tokenfactory.${source.region ?? DEFAULT_REGION}.nebius.com`;
    return `${explicit.replace(/\/+$/, '')}/v1`;
  }

  private static endpointOf(data: any): any {
    return data?.endpoint ?? data?.dedicated_endpoint ?? data;
  }

  async deploy(request: DeployRequest, credentials: AdapterCredentials): Promise<EndpointRef> {
    const cfg = request.providerConfig ?? {};
    const name = NebiusAdapter.endpointName(request.deploymentId);
    const modelName = NebiusAdapter.modelName(request);
    const region = request.desired.region ?? cfg.region ?? DEFAULT_REGION;
    const minReplicas = Math.max(1, request.desired.minScale ?? request.desired.replicas ?? 1);
    const maxReplicas = Math.max(minReplicas, request.desired.maxScale ?? minReplicas);
    const gpuCount = Number(cfg.gpuCount ?? 1);
    const body = {
      name,
      description: `almyty deployment ${request.deploymentId}`,
      model_name: modelName,
      flavor_name: cfg.flavorName,
      gpu_type: request.desired.hardware ?? cfg.gpuType ?? DEFAULT_GPU_TYPE,
      gpu_count: gpuCount,
      region,
      scaling: { min_replicas: minReplicas, max_replicas: maxReplicas },
      routing_key: NebiusAdapter.routingKey(request.deploymentId),
      ...(cfg.customWeightsId ? { custom_weights_id: cfg.customWeightsId } : {}),
    };
    try {
      const res = await this.http.post(`${NebiusAdapter.host(cfg)}/v0/dedicated_endpoints`, body, { headers: this.headers(credentials) });
      const endpoint = NebiusAdapter.endpointOf(res.data);
      return {
        endpointId: endpoint?.id ?? endpoint?.endpoint_id,
        name,
        routingKey: endpoint?.routing_key ?? body.routing_key,
        modelName,
        region,
        gpuCount,
        maxReplicas,
        apiHost: cfg.apiHost ?? DEFAULT_API_HOST,
        dataPlaneHost: cfg.dataPlaneHost,
        url: NebiusAdapter.dataPlane({ dataPlaneHost: cfg.dataPlaneHost, region }),
        createdAt: new Date().toISOString(),
        hourlyRateCents: cfg.hourlyRateCents ?? 0,
      };
    } catch (err) {
      this.classify(err, 'create dedicated endpoint failed');
    }
  }

  async readEndpoint(ref: EndpointRef, credentials: AdapterCredentials): Promise<ActualState> {
    let endpoint: any;
    try {
      const res = await this.http.get(`${NebiusAdapter.host(ref)}/v0/dedicated_endpoints/${encodeURIComponent(ref.endpointId)}`, { headers: this.headers(credentials) });
      endpoint = NebiusAdapter.endpointOf(res.data);
    } catch (err: any) {
      if (err?.response?.status === 404) return { state: 'missing', message: 'dedicated endpoint not found' };
      this.classify(err, 'read dedicated endpoint failed');
    }
    if (!endpoint) return { state: 'missing', message: 'dedicated endpoint not found' };
    const raw = String(endpoint.deployment?.status ?? 'starting');
    const readiness = String(endpoint.deployment?.readiness ?? 'not_ready');
    const readyReplicas = Number(endpoint.deployment?.ready_replicas ?? 0);
    const url = NebiusAdapter.dataPlane({ dataPlaneHost: ref.dataPlaneHost, region: endpoint.region ?? ref.region });
    let state = STATUS_MAP[raw] ?? 'deploying';
    let message: string | undefined;
    if (endpoint.enabled === false) {
      state = 'stopped';
      message = 'endpoint disabled';
    } else if (state === 'ready' && readiness === 'not_ready') {
      // Nebius says to route on readiness, not on the lifecycle status.
      state = 'deploying';
      message = 'running but not ready for traffic';
    } else if (state === 'ready' && readiness === 'partially_ready') {
      message = 'serving below expected capacity';
    }
    return {
      state,
      url,
      openAiBase: url,
      replicas: readyReplicas,
      hardware: [endpoint.gpu_type, endpoint.gpu_count].filter((v) => v !== undefined && v !== null).join('x') || undefined,
      region: endpoint.region ?? ref.region,
      message,
      details: {
        rawStatus: raw,
        readiness,
        // The OpenAI `model` for this endpoint, which is not the version name.
        routingKey: endpoint.routing_key ?? ref.routingKey,
        modelName: endpoint.model_name ?? ref.modelName,
        gpuCount: endpoint.gpu_count ?? ref.gpuCount,
      },
    };
  }

  /**
   * `min_replicas` has a floor of 1, so zero means disabled: the endpoint
   * keeps its configuration and stops running (and billing) replicas.
   */
  async scale(ref: EndpointRef, replicas: number, credentials: AdapterCredentials): Promise<void> {
    const body =
      replicas === 0
        ? { enabled: false }
        : { enabled: true, scaling: { min_replicas: replicas, max_replicas: Math.max(replicas, Number(ref.maxReplicas ?? 1)) } };
    try {
      await this.http.patch(`${NebiusAdapter.host(ref)}/v0/dedicated_endpoints/${encodeURIComponent(ref.endpointId)}`, body, { headers: this.headers(credentials) });
    } catch (err) {
      this.classify(err, 'scale failed');
    }
  }

  async teardown(ref: EndpointRef, credentials: AdapterCredentials): Promise<void> {
    try {
      await this.http.delete(`${NebiusAdapter.host(ref)}/v0/dedicated_endpoints/${encodeURIComponent(ref.endpointId)}`, { headers: this.headers(credentials) });
    } catch (err: any) {
      if (err?.response?.status === 404) return;
      this.classify(err, 'delete failed');
    }
  }

  /**
   * Token Factory shows spend in the console and publishes no usage API,
   * so this is the configured per GPU-hour rate times the GPUs actually
   * running. Spend is estimated against the replicas the endpoint was
   * created with so it never moves backwards.
   */
  async costSnapshot(ref: EndpointRef, credentials: AdapterCredentials): Promise<CostSnapshot> {
    const actual = await this.readEndpoint(ref, credentials);
    const rate = Number(ref.hourlyRateCents ?? 0) * Number(ref.gpuCount ?? 1);
    const running = actual.state === 'ready' || actual.state === 'scaling' ? Math.max(1, Number(actual.replicas ?? 0)) : 0;
    const hours = ref.createdAt ? Math.max(0, (Date.now() - new Date(ref.createdAt).getTime()) / 3_600_000) : 0;
    return { spentCents: Math.round(rate * hours), ratePerHourCents: rate * running, observedAt: new Date() };
  }
}
