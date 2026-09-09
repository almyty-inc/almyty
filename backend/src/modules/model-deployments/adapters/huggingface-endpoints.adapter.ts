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
 * Hugging Face Inference Endpoints: the managed product path.
 *
 * REST at https://api.endpoints.huggingface.cloud/v2/endpoint/{namespace}.
 * Delta from the spec, recorded in docs/design/models-layer.md: the API
 * requires a Hub repository even for a custom image, so an S3 registry
 * version is served by a vLLM container whose environment points at the
 * registry URI, with the registry's read credentials passed as endpoint
 * secrets; the repository field carries a placeholder the container
 * ignores. A hub:// version uses repository and revision directly.
 */
const BASE_URL = 'https://api.endpoints.huggingface.cloud/v2/endpoint';
const DEFAULT_IMAGE = 'vllm/vllm-openai:latest';
const PLACEHOLDER_REPOSITORY = 'almyty/registry-placeholder';

const STATE_MAP: Record<string, ActualState['state']> = {
  pending: 'deploying',
  initializing: 'deploying',
  updating: 'scaling',
  updateFailed: 'failed',
  running: 'ready',
  paused: 'stopped',
  scaledToZero: 'stopped',
  failed: 'failed',
};

export class HuggingFaceEndpointsAdapter implements ModelProviderAdapter {
  readonly key = 'huggingface-endpoints';
  readonly displayName = 'Hugging Face Inference Endpoints';

  constructor(private readonly http: AxiosInstance = axios.create({ timeout: 30_000 })) {}

  capabilities(): AdapterCapabilities {
    return {
      architectures: 'any',
      lora: 'merged',
      serverless: false,
      dedicated: true,
      scaleToZero: true,
      regions: ['us-east-1', 'us-west-2', 'eu-west-1', 'eu-central-1', 'ap-southeast-1'],
      registrySources: ['s3', 'hub'],
    };
  }

  configSchema(): Record<string, any> {
    return {
      type: 'object',
      properties: {
        token: { type: 'string', title: 'Hugging Face token', description: 'Needs the Inference Endpoints write scope', 'x-secret': true },
        namespace: { type: 'string', title: 'Namespace', description: 'Your HF user or organization' },
        vendor: { type: 'string', title: 'Cloud', enum: ['aws', 'gcp', 'azure'], default: 'aws' },
        region: { type: 'string', title: 'Region', default: 'us-east-1' },
        accelerator: { type: 'string', enum: ['gpu', 'cpu'], default: 'gpu' },
        instanceType: { type: 'string', title: 'Instance type', default: 'nvidia-a10g' },
        instanceSize: { type: 'string', title: 'Instance size', default: 'x1' },
        image: { type: 'string', title: 'Container image', default: DEFAULT_IMAGE },
        endpointType: { type: 'string', enum: ['protected', 'public', 'private'], default: 'protected' },
        scaleToZeroTimeoutMinutes: { type: 'integer', minimum: 5, default: 15 },
        hourlyRateCents: { type: 'integer', title: 'Instance price per hour (cents)', description: 'HF publishes no billing API; used to estimate spend' },
        registryAccessKeyId: { type: 'string', title: 'Registry access key (S3 source)', 'x-secret': true },
        registrySecretAccessKey: { type: 'string', title: 'Registry secret key (S3 source)', 'x-secret': true },
        registryEndpoint: { type: 'string', title: 'Registry endpoint (S3 source)' },
      },
      required: ['token', 'namespace'],
    };
  }

  private headers(credentials: AdapterCredentials) {
    if (!credentials.token) throw Object.assign(new Error('missing Hugging Face token'), { code: 'ADAPTER_AUTH', status: 401 });
    return { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' };
  }

  private classify(err: any, fallback: string): never {
    const status = err?.response?.status;
    const body = err?.response?.data;
    const message = body?.error ?? body?.message ?? err?.message ?? fallback;
    if (status === 401 || status === 403) throw Object.assign(new Error(`credential rejected: ${message}`), { code: 'ADAPTER_AUTH', status });
    if (status === 402 || status === 429 || /quota|limit/i.test(String(message))) throw Object.assign(new Error(`quota: ${message}`), { code: 'ADAPTER_QUOTA_EXCEEDED', status });
    if (status === 404) throw Object.assign(new Error(`not found: ${message}`), { code: 'ADAPTER_NOT_FOUND', status });
    throw Object.assign(new Error(message), { code: 'ADAPTER_ERROR', status });
  }

  static endpointName(deploymentId: string): string {
    return `almyty-${deploymentId.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 20)}`;
  }

  async deploy(request: DeployRequest, credentials: AdapterCredentials): Promise<EndpointRef> {
    const cfg = request.providerConfig;
    const namespace = cfg.namespace;
    const name = HuggingFaceEndpointsAdapter.endpointName(request.deploymentId);
    const uri = request.version.registryUri;
    const fromHub = uri.startsWith('hf://');
    const hub = fromHub ? uri.slice('hf://'.length).split('@') : null;

    const env: Record<string, string> = fromHub
      ? { MODEL_ID: hub![0], MODEL_REVISION: hub![1] ?? 'main' }
      : { ALMYTY_REGISTRY_URI: uri, MODEL_ID: '/data/model', ...(cfg.registryEndpoint ? { AWS_ENDPOINT_URL: cfg.registryEndpoint } : {}) };
    const secrets: Record<string, string> = fromHub
      ? {}
      : {
          ...(credentials.registryAccessKeyId ? { AWS_ACCESS_KEY_ID: credentials.registryAccessKeyId } : {}),
          ...(credentials.registrySecretAccessKey ? { AWS_SECRET_ACCESS_KEY: credentials.registrySecretAccessKey } : {}),
        };

    const body = {
      name,
      type: cfg.endpointType ?? 'protected',
      provider: { vendor: cfg.vendor ?? 'aws', region: request.desired.region ?? cfg.region ?? 'us-east-1' },
      compute: {
        accelerator: cfg.accelerator ?? 'gpu',
        instanceType: request.desired.hardware ?? cfg.instanceType ?? 'nvidia-a10g',
        instanceSize: cfg.instanceSize ?? 'x1',
        scaling: {
          minReplica: request.desired.minScale ?? 0,
          maxReplica: request.desired.maxScale ?? request.desired.replicas ?? 1,
          scaleToZeroTimeout: cfg.scaleToZeroTimeoutMinutes ?? 15,
        },
      },
      model: {
        repository: fromHub ? hub![0] : PLACEHOLDER_REPOSITORY,
        ...(fromHub && hub![1] ? { revision: hub![1] } : {}),
        framework: 'custom',
        task: 'text-generation',
        image: { custom: { url: cfg.image ?? DEFAULT_IMAGE, port: 8000, health_route: '/health', env, secrets } },
      },
    };

    try {
      const res = await this.http.post(`${BASE_URL}/${encodeURIComponent(namespace)}`, body, { headers: this.headers(credentials) });
      return { namespace, name, url: res.data?.status?.url, createdAt: new Date().toISOString(), hourlyRateCents: cfg.hourlyRateCents ?? 0 };
    } catch (err) {
      this.classify(err, 'create endpoint failed');
    }
  }

  async readEndpoint(ref: EndpointRef, credentials: AdapterCredentials): Promise<ActualState> {
    try {
      const res = await this.http.get(`${BASE_URL}/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.name)}`, { headers: this.headers(credentials) });
      const status = res.data?.status ?? {};
      const raw = String(status.state ?? 'pending');
      return {
        state: STATE_MAP[raw] ?? 'deploying',
        url: status.url ?? ref.url,
        replicas: typeof status.readyReplica === 'number' ? status.readyReplica : undefined,
        hardware: res.data?.compute?.instanceType,
        region: res.data?.provider?.region,
        message: status.message,
        details: { rawState: raw, targetReplica: status.targetReplica },
      };
    } catch (err: any) {
      if (err?.response?.status === 404) return { state: 'missing', message: 'endpoint not found' };
      this.classify(err, 'read endpoint failed');
    }
  }

  async scale(ref: EndpointRef, replicas: number, credentials: AdapterCredentials): Promise<void> {
    const base = `${BASE_URL}/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.name)}`;
    try {
      if (replicas === 0) {
        await this.http.post(`${base}/scale-to-zero`, {}, { headers: this.headers(credentials) });
        return;
      }
      await this.http.put(base, { compute: { scaling: { minReplica: replicas, maxReplica: Math.max(replicas, 1) } } }, { headers: this.headers(credentials) });
      await this.http.post(`${base}/resume`, {}, { headers: this.headers(credentials) }).catch(() => undefined);
    } catch (err) {
      this.classify(err, 'scale failed');
    }
  }

  async teardown(ref: EndpointRef, credentials: AdapterCredentials): Promise<void> {
    try {
      await this.http.delete(`${BASE_URL}/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.name)}`, { headers: this.headers(credentials) });
    } catch (err: any) {
      if (err?.response?.status === 404) return;
      this.classify(err, 'delete failed');
    }
  }

  /** HF publishes no billing API: spend is estimated from the instance rate and observed running time. */
  async costSnapshot(ref: EndpointRef, credentials: AdapterCredentials): Promise<CostSnapshot> {
    const actual = await this.readEndpoint(ref, credentials);
    const rate = Number(ref.hourlyRateCents ?? 0);
    const running = actual.state === 'ready' && (actual.replicas ?? 0) > 0 ? actual.replicas ?? 1 : 0;
    const hours = ref.createdAt ? Math.max(0, (Date.now() - new Date(ref.createdAt).getTime()) / 3_600_000) : 0;
    return {
      spentCents: Math.round(rate * hours),
      ratePerHourCents: rate * running,
      observedAt: new Date(),
    };
  }
}
