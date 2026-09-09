import axios, { AxiosInstance } from 'axios';

import {
  ActualState,
  AdapterCapabilities,
  AdapterCredentials,
  CostSnapshot,
  DeployRequest,
  EndpointRef,
  ModelProviderAdapter,
  UploadResult,
} from './adapter.interface';

/**
 * Together AI dedicated endpoints: the v1 REST API at
 * https://api.together.xyz/v1, bearer token.
 *
 * A registry version is first uploaded with `POST /v1/models`
 * (`model_source` is a Hugging Face repo or an HTTPS archive URL) and the
 * upload job polled at `GET /v1/jobs/{id}` until `Complete`; the owner-
 * prefixed `model_name` it returns is what `POST /v1/endpoints` deploys.
 * A `together://owner/name@model-id` registry URI skips the upload.
 * Together-hosted serverless models are not this adapter's job. Deltas
 * from the spec are recorded in docs/design/adapters/together.md.
 */
const BASE_URL = 'https://api.together.xyz/v1';
const INFERENCE_URL = 'https://api.together.xyz/v1';
const DEFAULT_HARDWARE = '1x_nvidia_h100_80gb_sxm';
const UPLOAD_TERMINAL_FAILURES = /^(failed|error|cancelled)$/i;

const STATE_MAP: Record<string, ActualState['state']> = {
  PENDING: 'deploying',
  STARTING: 'deploying',
  STARTED: 'ready',
  STOPPING: 'scaling',
  STOPPED: 'stopped',
  ERROR: 'failed',
};

export class TogetherAdapter implements ModelProviderAdapter {
  readonly key = 'together';
  readonly displayName = 'Together AI (dedicated endpoints)';

  constructor(
    private readonly http: AxiosInstance = axios.create({ timeout: 60_000 }),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  capabilities(): AdapterCapabilities {
    return {
      architectures: 'any',
      lora: 'merged',
      serverless: false,
      dedicated: true,
      // A STOPPED endpoint costs nothing and inactive_timeout stops it on its own.
      scaleToZero: true,
      // v1 takes a free-form availability_zone (e.g. us-central-4b); no public list to enumerate.
      regions: [],
      registrySources: ['s3', 'hub'],
    };
  }

  configSchema(): Record<string, any> {
    return {
      type: 'object',
      properties: {
        apiKey: { type: 'string', title: 'Together API key', 'x-secret': true },
        hardware: { type: 'string', title: 'Hardware', description: 'An id from GET /v1/hardware, e.g. 1x_nvidia_h100_80gb_sxm', default: DEFAULT_HARDWARE },
        availabilityZone: { type: 'string', title: 'Availability zone', description: 'Optional, e.g. us-central-4b' },
        inactiveTimeoutMinutes: { type: 'integer', minimum: 0, title: 'Stop after idle minutes', description: '0 disables the automatic stop' },
        disableSpeculativeDecoding: { type: 'boolean', default: false },
        hfToken: { type: 'string', title: 'Hugging Face token (gated hub source)', 'x-secret': true },
        registryArchiveUrlSecret: { type: 'string', title: 'Registry archive URL (S3 source)', description: 'Presigned HTTPS URL of a .tar.gz or .zip of the version with the files at the archive root; Together cannot read s3:// directly. Named as a secret so it is encrypted at rest', 'x-secret': true },
        uploadTimeoutMinutes: { type: 'integer', minimum: 1, default: 60 },
        hourlyRateCents: { type: 'integer', title: 'Hardware price per hour (cents)', description: 'Fallback when GET /v1/hardware has no price for the hardware' },
      },
      required: ['apiKey'],
    };
  }

  private headers(credentials: AdapterCredentials) {
    if (!credentials.apiKey) throw Object.assign(new Error('missing Together API key'), { code: 'ADAPTER_AUTH', status: 401 });
    return { Authorization: `Bearer ${credentials.apiKey}`, 'Content-Type': 'application/json' };
  }

  private classify(err: any, fallback: string): never {
    if (err?.code === 'ADAPTER_AUTH' || err?.code === 'ADAPTER_ERROR' || err?.code === 'ADAPTER_QUOTA_EXCEEDED') throw err;
    const status = err?.response?.status;
    const body = err?.response?.data;
    const message = body?.error?.message ?? body?.error ?? body?.message ?? err?.message ?? fallback;
    if (status === 401 || status === 403) throw Object.assign(new Error(`credential rejected: ${message}`), { code: 'ADAPTER_AUTH', status });
    if (status === 402 || status === 429 || /quota|limit|capacity|insufficient|unavailable/i.test(String(message))) {
      throw Object.assign(new Error(`quota: ${message}`), { code: 'ADAPTER_QUOTA_EXCEEDED', status });
    }
    if (status === 404) throw Object.assign(new Error(`not found: ${message}`), { code: 'ADAPTER_NOT_FOUND', status });
    throw Object.assign(new Error(String(message)), { code: 'ADAPTER_ERROR', status });
  }

  static endpointName(deploymentId: string): string {
    return `almyty-${deploymentId.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 20)}`;
  }

  /** The `model_source` Together accepts for a version: a Hub repo id, or an HTTPS archive URL for the S3 registry. */
  private modelSource(version: DeployRequest['version'], credentials: AdapterCredentials, cfg: Record<string, any>): string {
    const uri = version.registryUri;
    if (uri.startsWith('hf://')) return uri.slice('hf://'.length).split('@')[0];
    const archive = credentials.registryArchiveUrlSecret ?? cfg.registryArchiveUrlSecret;
    if (!archive) {
      throw Object.assign(
        new Error('Together reads custom weights from a Hugging Face repo or a presigned HTTPS archive URL; set registryArchiveUrlSecret for an S3 registry version'),
        { code: 'ADAPTER_ERROR' },
      );
    }
    return archive;
  }

  /** Push the version to Together's model store and wait for the upload job; returns a together:// URI deploy() uses directly. */
  async upload(version: DeployRequest['version'], credentials: AdapterCredentials, cfg: Record<string, any> = {}): Promise<UploadResult> {
    const headers = this.headers(credentials);
    const source = this.modelSource(version, credentials, cfg);
    const fromHub = version.registryUri.startsWith('hf://');
    const body = {
      model_name: `almyty-${version.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-${version.id.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 8)}`,
      model_source: source,
      model_type: 'model',
      description: `almyty version ${version.id} (${version.manifestSha ?? 'no manifest'})`,
      ...(fromHub && credentials.hfToken ? { hf_token: credentials.hfToken } : {}),
    };
    try {
      const res = await this.http.post(`${BASE_URL}/models`, body, { headers });
      const { job_id: jobId, model_name: modelName, model_id: modelId } = res.data ?? {};
      const deadline = Date.now() + (cfg.uploadTimeoutMinutes ?? 60) * 60_000;
      for (;;) {
        const job = await this.http.get(`${BASE_URL}/jobs/${encodeURIComponent(jobId)}`, { headers });
        const status = String(job.data?.status ?? '');
        if (/^complete/i.test(status)) break;
        if (UPLOAD_TERMINAL_FAILURES.test(status)) {
          throw Object.assign(new Error(`upload job ${jobId} ${status}: ${job.data?.status_message ?? job.data?.message ?? ''}`), { code: 'ADAPTER_ERROR' });
        }
        if (Date.now() > deadline) throw Object.assign(new Error(`upload job ${jobId} still ${status} after ${cfg.uploadTimeoutMinutes ?? 60} minutes`), { code: 'ADAPTER_ERROR' });
        await this.sleep(5_000);
      }
      return { registryUri: `together://${modelName}@${modelId}` };
    } catch (err) {
      this.classify(err, 'model upload failed');
    }
  }

  async deploy(request: DeployRequest, credentials: AdapterCredentials): Promise<EndpointRef> {
    const cfg = request.providerConfig;
    const headers = this.headers(credentials);
    const uri = request.version.registryUri;
    const model = uri.startsWith('together://')
      ? uri.slice('together://'.length).split('@')[0]
      : (await this.upload(request.version, credentials, cfg)).registryUri.slice('together://'.length).split('@')[0];
    const minReplicas = request.desired.minScale ?? 0;
    const maxReplicas = Math.max(request.desired.maxScale ?? request.desired.replicas ?? 1, 1);
    const hardware = request.desired.hardware ?? cfg.hardware ?? DEFAULT_HARDWARE;

    const body = {
      model,
      hardware,
      display_name: TogetherAdapter.endpointName(request.deploymentId),
      autoscaling: { min_replicas: minReplicas, max_replicas: maxReplicas },
      state: 'STARTED',
      disable_speculative_decoding: cfg.disableSpeculativeDecoding ?? false,
      ...(cfg.inactiveTimeoutMinutes !== undefined ? { inactive_timeout: cfg.inactiveTimeoutMinutes } : {}),
      ...(request.desired.region ?? cfg.availabilityZone ? { availability_zone: request.desired.region ?? cfg.availabilityZone } : {}),
    };
    try {
      const res = await this.http.post(`${BASE_URL}/endpoints`, body, { headers });
      const ep = res.data ?? {};
      return {
        endpointId: ep.id,
        name: ep.name,
        model,
        hardware,
        maxReplicas,
        url: INFERENCE_URL,
        createdAt: new Date().toISOString(),
        hourlyRateCents: cfg.hourlyRateCents ?? 0,
      };
    } catch (err) {
      this.classify(err, 'create endpoint failed');
    }
  }

  async readEndpoint(ref: EndpointRef, credentials: AdapterCredentials): Promise<ActualState> {
    try {
      const res = await this.http.get(`${BASE_URL}/endpoints/${encodeURIComponent(ref.endpointId)}`, { headers: this.headers(credentials) });
      const ep = res.data ?? {};
      const raw = String(ep.state ?? 'PENDING');
      const state = STATE_MAP[raw] ?? 'deploying';
      const min = Number(ep.autoscaling?.min_replicas ?? 0);
      return {
        state,
        url: INFERENCE_URL,
        // v1 reports no live replica count; while STARTED at least the floor runs.
        replicas: state === 'ready' ? Math.max(min, 1) : 0,
        hardware: ep.hardware ?? ref.hardware,
        region: ep.availability_zone,
        details: { rawState: raw, model: ep.name ?? ref.name, minReplicas: min, maxReplicas: ep.autoscaling?.max_replicas },
      };
    } catch (err: any) {
      if (err?.response?.status === 404) return { state: 'missing', message: 'endpoint not found' };
      this.classify(err, 'read endpoint failed');
    }
  }

  /** Zero stops the endpoint (billed nothing); a positive count raises the floor and starts it. */
  async scale(ref: EndpointRef, replicas: number, credentials: AdapterCredentials): Promise<void> {
    const headers = this.headers(credentials);
    const url = `${BASE_URL}/endpoints/${encodeURIComponent(ref.endpointId)}`;
    try {
      if (replicas === 0) {
        await this.http.patch(url, { state: 'STOPPED' }, { headers });
        return;
      }
      await this.http.patch(url, { autoscaling: { min_replicas: replicas, max_replicas: Math.max(replicas, Number(ref.maxReplicas ?? 1)) }, state: 'STARTED' }, { headers });
    } catch (err) {
      this.classify(err, 'scale failed');
    }
  }

  /** Removes the endpoint only; the uploaded model stays reusable for the version. */
  async teardown(ref: EndpointRef, credentials: AdapterCredentials): Promise<void> {
    try {
      await this.http.delete(`${BASE_URL}/endpoints/${encodeURIComponent(ref.endpointId)}`, { headers: this.headers(credentials) });
    } catch (err: any) {
      if (err?.response?.status === 404) return;
      this.classify(err, 'delete failed');
    }
  }

  /** Together bills per minute of hardware uptime and publishes no spend API: rate from /v1/hardware, spend from uptime. */
  async costSnapshot(ref: EndpointRef, credentials: AdapterCredentials): Promise<CostSnapshot> {
    const headers = this.headers(credentials);
    const actual = await this.readEndpoint(ref, credentials);
    let rate = Number(ref.hourlyRateCents ?? 0);
    try {
      const res = await this.http.get(`${BASE_URL}/hardware`, { headers });
      const match = (res.data?.data ?? []).find((h: any) => h?.id === (actual.hardware ?? ref.hardware));
      const perMinute = Number(match?.pricing?.cents_per_minute);
      if (Number.isFinite(perMinute) && perMinute > 0) rate = Math.round(perMinute * 60);
    } catch {
      // Price list unavailable: the configured rate stands.
    }
    const running = actual.state === 'ready' ? actual.replicas ?? 1 : 0;
    const hours = ref.createdAt ? Math.max(0, (Date.now() - new Date(ref.createdAt).getTime()) / 3_600_000) : 0;
    return { spentCents: Math.round(rate * hours), ratePerHourCents: rate * running, observedAt: new Date() };
  }
}
