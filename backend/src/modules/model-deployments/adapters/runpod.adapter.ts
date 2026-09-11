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
 * RunPod Serverless running RunPod's own vLLM worker. Verified shapes are
 * in docs/design/adapters/runpod.md.
 *
 * RunPod operates the workers, the queue and the autoscaler; almyty names
 * a Hugging Face repository. Control plane: REST at
 * https://rest.runpod.io/v1 with a bearer API key. Deploy creates a
 * serverless template (the worker image plus its environment) and an
 * endpoint pointing at it with the GPU type and worker bounds; scale
 * patches the bounds; teardown deletes both. Data plane: the endpoint's
 * health at https://api.runpod.ai/v2/{id}/health gives running and idle
 * worker counts, and chat goes to
 * https://api.runpod.ai/v2/{id}/openai/v1.
 *
 * Source: the worker's MODEL_NAME and MODEL_REVISION, which is a Hub repo
 * id. No weights pass through almyty.
 *
 * Replicas map to active (always-on) workers: scale(n) sets workersMin to
 * n, scale(0) sets both bounds to 0 so nothing can start until scaled up.
 */
const REST = 'https://rest.runpod.io/v1';
const DATA = 'https://api.runpod.ai/v2';
const DEFAULT_IMAGE = 'runpod/worker-v1-vllm:stable-cuda12.1.0';
const DEFAULT_GPU = 'NVIDIA A40';

export class RunPodAdapter implements ModelProviderAdapter {
  readonly key = 'runpod';
  readonly displayName = 'RunPod Serverless (vLLM worker)';

  constructor(private readonly http: AxiosInstance = axios.create({ timeout: 30_000 })) {}

  capabilities(): AdapterCapabilities {
    return {
      architectures: 'any',
      lora: 'merged',
      serverless: true,
      dedicated: false,
      scaleToZero: true,
      regions: ['US-IL-1', 'US-TX-3', 'US-KS-2', 'US-CA-2', 'CA-MTL-1', 'EU-RO-1', 'EU-SE-1', 'EU-CZ-1', 'AP-JP-1'],
      // The stock worker reads the Hub. It has no object-storage source,
      // so an s3 version is refused rather than smuggled in through us.
      registrySources: ['hub'],
    };
  }

  configSchema(): Record<string, any> {
    return {
      type: 'object',
      properties: {
        apiKey: { type: 'string', title: 'RunPod API key', 'x-secret': true },
        gpuTypeId: { type: 'string', title: 'GPU type', description: 'A RunPod GPU type id such as NVIDIA A40 or NVIDIA H100 80GB HBM3', default: DEFAULT_GPU },
        gpuCount: { type: 'integer', minimum: 1, default: 1 },
        image: { type: 'string', title: 'Worker image', default: DEFAULT_IMAGE },
        dataCenterIds: { type: 'array', items: { type: 'string' }, title: 'Data centers', description: 'Empty lets RunPod choose' },
        containerDiskInGb: { type: 'integer', minimum: 5, default: 50 },
        networkVolumeId: { type: 'string', title: 'Network volume', description: 'Optional; a volume already holding the weights under /runpod-volume' },
        idleTimeout: { type: 'integer', title: 'Idle timeout (s)', minimum: 1, maximum: 3600, default: 5 },
        scalerType: { type: 'string', enum: ['QUEUE_DELAY', 'REQUEST_COUNT'], default: 'QUEUE_DELAY' },
        scalerValue: { type: 'integer', minimum: 1, default: 4 },
        flashboot: { type: 'boolean', default: true },
        executionTimeoutMs: { type: 'integer', minimum: 1000 },
        maxModelLen: { type: 'integer', title: 'vLLM max model length' },
        hourlyRateCents: { type: 'integer', title: 'GPU price per hour per worker (cents)', description: 'RunPod publishes no spend API; used to estimate cost' },
        hfToken: { type: 'string', title: 'Hugging Face token (gated hub models)', 'x-secret': true },
      },
      required: ['apiKey'],
    };
  }

  private headers(credentials: AdapterCredentials) {
    if (!credentials.apiKey) throw Object.assign(new Error('missing RunPod API key'), { code: 'ADAPTER_AUTH', status: 401 });
    return { Authorization: `Bearer ${credentials.apiKey}`, 'Content-Type': 'application/json' };
  }

  private classify(err: any, fallback: string): never {
    if (typeof err?.code === 'string' && err.code.startsWith('ADAPTER_')) throw err;
    const status = err?.response?.status;
    const body = err?.response?.data;
    const message = body?.error ?? body?.message ?? err?.message ?? fallback;
    if (status === 401 || status === 403) throw Object.assign(new Error(`credential rejected: ${message}`), { code: 'ADAPTER_AUTH', status });
    if (status === 402 || status === 429 || /quota|limit|insufficient/i.test(String(message))) {
      throw Object.assign(new Error(`quota: ${message}`), { code: 'ADAPTER_QUOTA_EXCEEDED', status });
    }
    if (status === 404) throw Object.assign(new Error(`not found: ${message}`), { code: 'ADAPTER_NOT_FOUND', status });
    throw Object.assign(new Error(message), { code: 'ADAPTER_ERROR', status });
  }

  static endpointName(deploymentId: string): string {
    return `almyty-${deploymentId.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 20)}`;
  }

  /**
   * Worker environment for the version. The stock worker loads a Hugging
   * Face repository by id; `HF_TOKEN` rides along because a serverless
   * template's env is the only secret channel RunPod offers.
   */
  static workerEnv(request: DeployRequest, credentials: AdapterCredentials): Record<string, string> {
    const cfg = request.providerConfig ?? {};
    const uri = request.version.registryUri;
    if (!uri.startsWith('hf://')) {
      // worker-vllm reads the Hub or a path already inside the container.
      // Shipping our object storage credentials to the worker so it could
      // fetch from us would make almyty the delivery route, so it is
      // refused instead.
      throw Object.assign(
        new Error('the RunPod vLLM worker loads a Hugging Face repository; point the version at hf://org/repo'),
        { code: 'ADAPTER_UNSUPPORTED_SOURCE' },
      );
    }
    const [repo, rev] = uri.slice('hf://'.length).split('@');
    return {
      OPENAI_SERVED_MODEL_NAME_OVERRIDE: request.version.name,
      ...(request.desired.quantization ? { QUANTIZATION: request.desired.quantization } : {}),
      ...(cfg.maxModelLen ? { MAX_MODEL_LEN: String(cfg.maxModelLen) } : {}),
      MODEL_NAME: repo,
      MODEL_REVISION: rev ?? 'main',
      ...(credentials.hfToken ? { HF_TOKEN: credentials.hfToken } : {}),
    };
  }

  async deploy(request: DeployRequest, credentials: AdapterCredentials): Promise<EndpointRef> {
    const cfg = request.providerConfig;
    const name = RunPodAdapter.endpointName(request.deploymentId);
    const headers = this.headers(credentials);
    const workersMin = request.desired.minScale ?? 0;
    const workersMax = Math.max(workersMin, request.desired.maxScale ?? request.desired.replicas ?? 1, 1);
    let templateId: string | undefined;
    try {
      const template = await this.http.post(
        `${REST}/templates`,
        {
          name,
          imageName: cfg.image ?? DEFAULT_IMAGE,
          isServerless: true,
          env: RunPodAdapter.workerEnv(request, credentials),
          containerDiskInGb: cfg.containerDiskInGb ?? 50,
          ports: [],
        },
        { headers },
      );
      templateId = template.data?.id;
      const endpoint = await this.http.post(
        `${REST}/endpoints`,
        {
          name,
          templateId,
          computeType: 'GPU',
          gpuTypeIds: [request.desired.hardware ?? cfg.gpuTypeId ?? DEFAULT_GPU],
          gpuCount: cfg.gpuCount ?? 1,
          workersMin,
          workersMax,
          idleTimeout: cfg.idleTimeout ?? 5,
          scalerType: cfg.scalerType ?? 'QUEUE_DELAY',
          scalerValue: cfg.scalerValue ?? 4,
          flashboot: cfg.flashboot ?? true,
          ...(request.desired.region ? { dataCenterIds: [request.desired.region] } : cfg.dataCenterIds?.length ? { dataCenterIds: cfg.dataCenterIds } : {}),
          ...(cfg.networkVolumeId ? { networkVolumeId: cfg.networkVolumeId } : {}),
          ...(cfg.executionTimeoutMs ? { executionTimeoutMs: cfg.executionTimeoutMs } : {}),
        },
        { headers },
      );
      const id = endpoint.data?.id;
      return {
        endpointId: id,
        templateId,
        name,
        url: `${DATA}/${id}/openai/v1`,
        workersMax,
        createdAt: new Date().toISOString(),
        hourlyRateCents: cfg.hourlyRateCents ?? 0,
      };
    } catch (err) {
      // A template without an endpoint is clutter, not cost; remove it before surfacing the error.
      if (templateId) await this.http.delete(`${REST}/templates/${encodeURIComponent(templateId)}`, { headers }).catch(() => undefined);
      this.classify(err, 'create endpoint failed');
    }
  }

  async readEndpoint(ref: EndpointRef, credentials: AdapterCredentials): Promise<ActualState> {
    const headers = this.headers(credentials);
    let endpoint: any;
    try {
      endpoint = (await this.http.get(`${REST}/endpoints/${encodeURIComponent(ref.endpointId)}`, { headers })).data;
    } catch (err: any) {
      if (err?.response?.status === 404) return { state: 'missing', message: 'endpoint not found' };
      this.classify(err, 'read endpoint failed');
    }
    let workers: { running?: number; idle?: number } = {};
    try {
      workers = (await this.http.get(`${DATA}/${encodeURIComponent(ref.endpointId)}/health`, { headers })).data?.workers ?? {};
    } catch (err: any) {
      if (err?.response?.status !== 404) this.classify(err, 'read health failed');
    }
    const running = Number(workers.running ?? 0);
    const idle = Number(workers.idle ?? 0);
    const workersMin = Number(endpoint?.workersMin ?? 0);
    const workersMax = Number(endpoint?.workersMax ?? 0);
    let state: ActualState['state'];
    if (workersMax === 0) state = 'stopped';
    else if (running + idle > 0) state = 'ready';
    // With no always-on workers the endpoint is live and boots a worker on the first request.
    else if (workersMin === 0) state = 'ready';
    else state = 'deploying';
    return {
      state,
      url: ref.url,
      replicas: running + idle,
      hardware: (endpoint?.gpuTypeIds ?? []).join(','),
      region: (endpoint?.dataCenterIds ?? []).join(',') || undefined,
      message: state === 'deploying' ? 'waiting for active workers to boot' : undefined,
      details: { workersMin, workersMax, running, idle, templateId: endpoint?.templateId },
    };
  }

  async scale(ref: EndpointRef, replicas: number, credentials: AdapterCredentials): Promise<void> {
    const headers = this.headers(credentials);
    const body = replicas === 0 ? { workersMin: 0, workersMax: 0 } : { workersMin: replicas, workersMax: Math.max(replicas, Number(ref.workersMax ?? 1)) };
    try {
      await this.http.patch(`${REST}/endpoints/${encodeURIComponent(ref.endpointId)}`, body, { headers });
    } catch (err) {
      this.classify(err, 'scale failed');
    }
  }

  async teardown(ref: EndpointRef, credentials: AdapterCredentials): Promise<void> {
    const headers = this.headers(credentials);
    try {
      await this.http.delete(`${REST}/endpoints/${encodeURIComponent(ref.endpointId)}`, { headers });
    } catch (err: any) {
      if (err?.response?.status !== 404) this.classify(err, 'delete failed');
    }
    if (ref.templateId) await this.http.delete(`${REST}/templates/${encodeURIComponent(ref.templateId)}`, { headers }).catch(() => undefined);
  }

  /** RunPod bills active workers per second and exposes no spend API; the rate is the configured GPU price times billable workers. */
  async costSnapshot(ref: EndpointRef, credentials: AdapterCredentials): Promise<CostSnapshot> {
    const actual = await this.readEndpoint(ref, credentials);
    const rate = Number(ref.hourlyRateCents ?? 0);
    const billable = actual.state === 'stopped' || actual.state === 'missing' ? 0 : Math.max(Number(actual.details?.running ?? 0), Number(actual.details?.workersMin ?? 0));
    const hours = ref.createdAt ? Math.max(0, (Date.now() - new Date(ref.createdAt).getTime()) / 3_600_000) : 0;
    return {
      spentCents: Math.round(rate * hours * Number(actual.details?.workersMin ?? 0)),
      ratePerHourCents: rate * billable,
      observedAt: new Date(),
    };
  }
}
