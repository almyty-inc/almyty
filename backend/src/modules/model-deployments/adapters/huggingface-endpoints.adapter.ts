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
 * Hugging Face Inference Endpoints: dedicated endpoints over the v2 REST
 * API at https://api.endpoints.huggingface.cloud/v2.
 *
 * An endpoint is always built from a Hub repository. `EndpointModel`
 * requires `repository`, the weights are mounted at /repository inside the
 * container, and there is no field anywhere in the create body that points
 * at object storage. So this adapter serves `hf://` versions and nothing
 * else; anything else is refused before a call is made. See
 * docs/design/adapters/huggingface-endpoints.md.
 */
const API_BASE = 'https://api.endpoints.huggingface.cloud/v2';
const ENDPOINT_BASE = `${API_BASE}/endpoint`;
const PROVIDER_URL = `${API_BASE}/provider`;
const DEFAULT_ENGINE = 'vLLM';
const DEFAULT_IMAGE = 'vllm/vllm-openai:v0.23.0';
const DEFAULT_PORT = 8000;
/** EndpointModelImage is a oneOf keyed by engine; each engine takes the BaseContainer fields. */
const ENGINES = ['vLLM', 'sGLang', 'tgi', 'tei', 'llamacpp', 'hfServe', 'custom'];

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
      // Inference Endpoints is the dedicated product. HF's serverless
      // offer is Inference Providers, a different product that routes to
      // third parties and deploys nothing.
      serverless: false,
      dedicated: true,
      scaleToZero: true,
      // Regions currently offered by GET /v2/provider, read 2026-09-09.
      regions: ['us-east-1', 'us-east-2', 'us-west-2', 'eu-west-1', 'eastus', 'us-east4'],
      // A Hub repository is the only thing an endpoint can be built from.
      registrySources: ['hub'],
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
        accelerator: { type: 'string', enum: ['gpu', 'cpu', 'neuron', 'zero_gpu'], default: 'gpu' },
        instanceType: { type: 'string', title: 'Instance type', default: 'nvidia-l4' },
        instanceSize: { type: 'string', title: 'Instance size', default: 'x1' },
        engine: { type: 'string', title: 'Serving engine', enum: ENGINES, default: DEFAULT_ENGINE },
        image: { type: 'string', title: 'Container image', description: 'The image the engine runs; EndpointModelImage requires a url for every engine', default: DEFAULT_IMAGE },
        port: { type: 'integer', title: 'Container port', default: DEFAULT_PORT },
        healthRoute: { type: 'string', title: 'Health route', default: '/health' },
        framework: { type: 'string', enum: ['pytorch', 'custom', 'llamacpp'], default: 'pytorch' },
        task: { type: 'string', title: 'Task', default: 'text-generation' },
        endpointType: { type: 'string', enum: ['public', 'authenticated', 'private'], default: 'authenticated' },
        scaleToZeroTimeoutMinutes: { type: 'integer', minimum: 0, default: 15 },
        hubToken: { type: 'string', title: 'Hub read token (gated or third-party repo)', description: 'Passed to the container as the HF_TOKEN endpoint secret', 'x-secret': true },
        hourlyRateCents: { type: 'integer', title: 'Instance price per hour (cents)', description: 'Overrides the price GET /v2/provider publishes for this compute' },
      },
      required: ['token', 'namespace'],
    };
  }

  private headers(credentials: AdapterCredentials) {
    if (!credentials.token) throw Object.assign(new Error('missing Hugging Face token'), { code: 'ADAPTER_AUTH', status: 401 });
    return { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' };
  }

  private classify(err: any, fallback: string): never {
    if (typeof err?.code === 'string' && err.code.startsWith('ADAPTER_')) throw err;
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

  /** The Hub repository and revision an endpoint is built from. Nothing else can be served. */
  static repository(registryUri: string): { repository: string; revision?: string } {
    if (!registryUri.startsWith('hf://')) {
      throw Object.assign(
        new Error(
          `Hugging Face Inference Endpoints builds an endpoint from a Hub repository and nothing else: point the version at hf://owner/repo[@revision], not ${registryUri.split(':')[0]}://`,
        ),
        { code: 'ADAPTER_UNSUPPORTED_SOURCE' },
      );
    }
    const [repository, revision] = registryUri.slice('hf://'.length).split('@');
    if (!repository.includes('/')) {
      throw Object.assign(new Error(`${registryUri} is not an owner/repo Hub repository`), { code: 'ADAPTER_UNSUPPORTED_SOURCE' });
    }
    return revision ? { repository, revision } : { repository };
  }

  async deploy(request: DeployRequest, credentials: AdapterCredentials): Promise<EndpointRef> {
    const cfg = request.providerConfig;
    const namespace = cfg.namespace;
    const name = HuggingFaceEndpointsAdapter.endpointName(request.deploymentId);
    const model = HuggingFaceEndpointsAdapter.repository(request.version.registryUri);
    const engine = ENGINES.includes(cfg.engine) ? cfg.engine : DEFAULT_ENGINE;
    const vendor = cfg.vendor ?? 'aws';
    const region = request.desired.region ?? cfg.region ?? 'us-east-1';
    const accelerator = cfg.accelerator ?? 'gpu';
    const instanceType = request.desired.hardware ?? cfg.instanceType ?? 'nvidia-l4';
    const instanceSize = cfg.instanceSize ?? 'x1';
    // A gated or third-party repo needs a read token inside the container; HF encrypts endpoint secrets at rest.
    const hubToken = credentials.hubToken ?? cfg.hubToken;

    const body = {
      name,
      type: cfg.endpointType ?? 'authenticated',
      provider: { vendor, region },
      compute: {
        accelerator,
        instanceType,
        instanceSize,
        scaling: {
          minReplica: request.desired.minScale ?? 0,
          maxReplica: Math.max(request.desired.maxScale ?? request.desired.replicas ?? 1, 1),
          scaleToZeroTimeout: cfg.scaleToZeroTimeoutMinutes ?? 15,
        },
      },
      model: {
        ...model,
        framework: cfg.framework ?? 'pytorch',
        task: cfg.task ?? 'text-generation',
        image: { [engine]: { url: cfg.image ?? DEFAULT_IMAGE, port: cfg.port ?? DEFAULT_PORT, healthRoute: cfg.healthRoute ?? '/health' } },
        ...(hubToken ? { secrets: { HF_TOKEN: hubToken } } : {}),
      },
    };

    try {
      const res = await this.http.post(`${ENDPOINT_BASE}/${encodeURIComponent(namespace)}`, body, { headers: this.headers(credentials) });
      return {
        namespace,
        name,
        url: res.data?.status?.url,
        vendor,
        region,
        instanceType,
        instanceSize,
        createdAt: new Date().toISOString(),
        hourlyRateCents: cfg.hourlyRateCents ?? 0,
      };
    } catch (err) {
      this.classify(err, 'create endpoint failed');
    }
  }

  async readEndpoint(ref: EndpointRef, credentials: AdapterCredentials): Promise<ActualState> {
    try {
      const res = await this.http.get(`${ENDPOINT_BASE}/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.name)}`, { headers: this.headers(credentials) });
      const status = res.data?.status ?? {};
      const raw = String(status.state ?? 'pending');
      const url = status.url ?? ref.url;
      return {
        state: STATE_MAP[raw] ?? 'deploying',
        url,
        // vLLM, SGLang and TGI all serve the OpenAI routes under /v1 on the endpoint host.
        ...(url ? { openAiBase: `${String(url).replace(/\/+$/, '')}/v1` } : {}),
        replicas: typeof status.readyReplica === 'number' ? status.readyReplica : undefined,
        hardware: res.data?.compute?.instanceType,
        region: res.data?.provider?.region,
        message: status.errorMessage ?? status.message,
        details: { rawState: raw, targetReplica: status.targetReplica },
      };
    } catch (err: any) {
      if (err?.response?.status === 404) return { state: 'missing', message: 'endpoint not found' };
      this.classify(err, 'read endpoint failed');
    }
  }

  async scale(ref: EndpointRef, replicas: number, credentials: AdapterCredentials): Promise<void> {
    const base = `${ENDPOINT_BASE}/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.name)}`;
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
      await this.http.delete(`${ENDPOINT_BASE}/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.name)}`, { headers: this.headers(credentials) });
    } catch (err: any) {
      if (err?.response?.status === 404) return;
      this.classify(err, 'delete failed');
    }
  }

  /**
   * HF publishes a price list, not a spend API: `GET /v2/provider` carries
   * `pricePerHour` per replica for every vendor/region/compute. Spend is
   * that rate over observed uptime.
   */
  async costSnapshot(ref: EndpointRef, credentials: AdapterCredentials): Promise<CostSnapshot> {
    const actual = await this.readEndpoint(ref, credentials);
    let perReplica = Number(ref.hourlyRateCents ?? 0);
    try {
      const res = await this.http.get(PROVIDER_URL, { headers: this.headers(credentials) });
      const vendor = (res.data?.vendors ?? []).find((v: any) => v?.name === ref.vendor);
      const region = (vendor?.regions ?? []).find((r: any) => r?.name === ref.region);
      const compute = (region?.computes ?? []).find(
        (c: any) => c?.instanceType === (actual.hardware ?? ref.instanceType) && c?.instanceSize === ref.instanceSize,
      );
      const price = Number(compute?.pricePerHour);
      if (Number.isFinite(price) && price > 0) perReplica = Math.round(price * 100);
    } catch {
      // Price list unavailable: the configured rate stands.
    }
    const running = actual.state === 'ready' ? actual.replicas ?? 1 : 0;
    const hours = ref.createdAt ? Math.max(0, (Date.now() - new Date(ref.createdAt).getTime()) / 3_600_000) : 0;
    return {
      spentCents: Math.round(perReplica * hours),
      ratePerHourCents: perReplica * running,
      observedAt: new Date(),
    };
  }
}
