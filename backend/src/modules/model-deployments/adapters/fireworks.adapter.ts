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
 * Fireworks AI on-demand deployments: the REST API at
 * https://api.fireworks.ai/v1/accounts/{account}, bearer token.
 *
 * Fireworks has no server-side import from a registry: custom weights are
 * created as an HF_BASE_MODEL, pushed file by file to the signed upload
 * URLs `:getUploadEndpoint` issues, then `:validateUpload` flips the model
 * to READY. The adapter streams the bytes itself from the registry (S3 via
 * the lazily loaded AWS SDK, the Hub via huggingface.co), so the API
 * container needs no shared filesystem. A `fireworks://accounts/x/models/y`
 * registry URI skips the upload. Deltas from the spec are recorded in
 * docs/design/adapters/fireworks.md.
 */
const BASE_URL = 'https://api.fireworks.ai/v1';
const INFERENCE_URL = 'https://api.fireworks.ai/inference/v1';
const HF_URL = 'https://huggingface.co';
const REGISTRY_MANIFEST = 'almyty-manifest.json';
const MULTI_REGIONS = ['GLOBAL', 'US', 'EUROPE', 'APAC'];
const SINGLE_REGIONS = [
  'AP_MALAYSIA_2', 'AP_NEWSOUTHWALES_1', 'AP_TOKYO_1', 'AP_TOKYO_2',
  'EU_FRANKFURT_1', 'EU_ICELAND_1', 'EU_ICELAND_2',
  'NA_BRITISHCOLUMBIA_1', 'NA_BRITISHCOLUMBIA_2', 'NA_BRITISHCOLUMBIA_3',
  'US_ARIZONA_1', 'US_ARIZONA_3', 'US_CALIFORNIA_1', 'US_CALIFORNIA_2', 'US_GEORGIA_2', 'US_GEORGIA_3',
  'US_ILLINOIS_1', 'US_ILLINOIS_2', 'US_IOWA_1', 'US_MINNESOTA_1', 'US_NEWYORK_1', 'US_OHIO_1', 'US_VIRGINIA_1',
  'US_WASHINGTON_3', 'US_WASHINGTON_4', 'US_WASHINGTON_5',
];
/** Published on-demand list prices, US cents per GPU hour (fireworks.ai/pricing, rates in force from 2026-09-01). */
const GPU_HOURLY_CENTS: Record<string, number> = {
  NVIDIA_H100_80GB: 800,
  NVIDIA_H200_141GB: 800,
  NVIDIA_B200_180GB: 1300,
  NVIDIA_B300_288GB: 1500,
  NVIDIA_GB300: 2000,
};
const SINGLE_REGION_PREMIUM = 1.5;

const STATE_MAP: Record<string, ActualState['state']> = {
  CREATING: 'deploying',
  READY: 'ready',
  UPDATING: 'scaling',
  DELETING: 'stopped',
  DELETED: 'missing',
  FAILED: 'failed',
};

/** One file of a version as the adapter streams it to Fireworks. */
export interface ModelFile {
  name: string;
  size: number;
}

/** Where the adapter reads a version's bytes from; injectable so fixtures need no registry. */
export interface ModelFileSource {
  list(): Promise<ModelFile[]>;
  open(name: string): Promise<NodeJS.ReadableStream | Buffer>;
}

export type ModelFileSourceFactory = (version: DeployRequest['version'], credentials: AdapterCredentials, cfg: Record<string, any>) => ModelFileSource;

export class FireworksAdapter implements ModelProviderAdapter {
  readonly key = 'fireworks';
  readonly displayName = 'Fireworks AI (on-demand deployments)';

  constructor(
    private readonly http: AxiosInstance = axios.create({ timeout: 60_000 }),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly fileSource: ModelFileSourceFactory = (version, credentials, cfg) => this.defaultFileSource(version, credentials, cfg),
  ) {}

  capabilities(): AdapterCapabilities {
    return {
      architectures: 'any',
      lora: 'merged',
      serverless: false,
      dedicated: true,
      scaleToZero: true,
      regions: [...MULTI_REGIONS, ...SINGLE_REGIONS],
      registrySources: ['s3', 'hub'],
    };
  }

  configSchema(): Record<string, any> {
    return {
      type: 'object',
      properties: {
        apiKey: { type: 'string', title: 'Fireworks API key', 'x-secret': true },
        account: { type: 'string', title: 'Account id', description: 'The {account_id} in accounts/{account_id}/...' },
        acceleratorType: { type: 'string', title: 'Accelerator', enum: ['NVIDIA_H100_80GB', 'NVIDIA_H200_141GB', 'NVIDIA_B200_180GB', 'NVIDIA_B300_288GB', 'NVIDIA_GB300', 'NVIDIA_A100_80GB', 'AMD_MI300X_192GB', 'AMD_MI325X_256GB'], default: 'NVIDIA_H100_80GB' },
        acceleratorCount: { type: 'integer', minimum: 1, default: 1 },
        precision: { type: 'string', title: 'Precision', description: 'e.g. FP16, BF16, FP8; omitted lets Fireworks choose' },
        region: { type: 'string', title: 'Placement', description: 'A multi-region (GLOBAL, US, EUROPE, APAC) or a single region; single regions cost 1.5x and need their own quota', default: 'GLOBAL' },
        scaleToZeroWindow: { type: 'string', title: 'Scale-to-zero window', description: 'Idle time before replicas drop to zero, at least 5m', default: '1h' },
        hfToken: { type: 'string', title: 'Hugging Face token (gated hub source)', 'x-secret': true },
        registryAccessKeyId: { type: 'string', title: 'Registry access key id (S3 source)', description: 'An identifier, not a secret; the secret key below is encrypted' },
        registrySecretAccessKey: { type: 'string', title: 'Registry secret key (S3 source)', 'x-secret': true },
        registryEndpoint: { type: 'string', title: 'Registry endpoint (S3 source)' },
        registryRegion: { type: 'string', title: 'Registry region (S3 source)', default: 'us-east-1' },
        uploadTimeoutMinutes: { type: 'integer', minimum: 1, default: 60 },
        hourlyRateCents: { type: 'integer', title: 'GPU price per hour (cents)', description: 'Overrides the built-in price table; Fireworks publishes no billing API' },
      },
      required: ['apiKey', 'account'],
    };
  }

  private headers(credentials: AdapterCredentials) {
    if (!credentials.apiKey) throw Object.assign(new Error('missing Fireworks API key'), { code: 'ADAPTER_AUTH', status: 401 });
    return { Authorization: `Bearer ${credentials.apiKey}`, 'Content-Type': 'application/json' };
  }

  private classify(err: any, fallback: string): never {
    if (typeof err?.code === 'string' && err.code.startsWith('ADAPTER_')) throw err;
    const status = err?.response?.status;
    const body = err?.response?.data;
    const message = body?.message ?? body?.error?.message ?? body?.error ?? err?.message ?? fallback;
    const grpc = String(body?.status ?? body?.code ?? '');
    if (status === 401 || status === 403 || /UNAUTHENTICATED|PERMISSION_DENIED/.test(grpc)) {
      throw Object.assign(new Error(`credential rejected: ${message}`), { code: 'ADAPTER_AUTH', status });
    }
    if (status === 429 || /RESOURCE_EXHAUSTED/.test(grpc) || /quota|limit|capacity/i.test(String(message))) {
      throw Object.assign(new Error(`quota: ${message}`), { code: 'ADAPTER_QUOTA_EXCEEDED', status });
    }
    if (status === 404 || /NOT_FOUND/.test(grpc)) throw Object.assign(new Error(`not found: ${message}`), { code: 'ADAPTER_NOT_FOUND', status });
    throw Object.assign(new Error(String(message)), { code: 'ADAPTER_ERROR', status });
  }

  private account(cfg: Record<string, any>): string {
    if (!cfg.account) throw Object.assign(new Error('providerConfig.account is required'), { code: 'ADAPTER_ERROR' });
    return `${BASE_URL}/accounts/${encodeURIComponent(cfg.account)}`;
  }

  static resourceId(kind: 'model' | 'deployment', id: string): string {
    return `almyty-${kind === 'model' ? 'v' : 'd'}-${id.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 24)}`;
  }

  /** The default byte source: S3 through the lazily loaded AWS SDK, the Hub through huggingface.co. */
  private defaultFileSource(version: DeployRequest['version'], credentials: AdapterCredentials, cfg: Record<string, any>): ModelFileSource {
    const uri = version.registryUri;
    if (uri.startsWith('hf://')) {
      const [repo, revision = 'main'] = uri.slice('hf://'.length).split('@');
      const headers = credentials.hfToken ? { Authorization: `Bearer ${credentials.hfToken}` } : {};
      return {
        list: async () => {
          const res = await this.http.get(`${HF_URL}/api/models/${repo}/tree/${encodeURIComponent(revision)}`, { headers, params: { recursive: true } });
          return (res.data ?? []).filter((e: any) => e?.type === 'file').map((e: any) => ({ name: e.path, size: Number(e.size ?? 0) }));
        },
        open: async (name) => (await this.http.get(`${HF_URL}/${repo}/resolve/${encodeURIComponent(revision)}/${name}`, { headers, responseType: 'stream' })).data,
      };
    }
    const m = uri.match(/^s3:\/\/([^/@]+)\/?([^@]*)@/);
    if (!m) throw Object.assign(new Error(`cannot read weights from ${uri}`), { code: 'ADAPTER_ERROR' });
    const [, bucket, rawPrefix] = m;
    const prefix = rawPrefix.replace(/\/+$/, '');
    let client: any;
    let sdk: any;
    const s3 = () => {
      if (client) return client;
      // Lazy so the SDK is only needed when an S3 version is actually pushed to Fireworks.
      sdk = require('@aws-sdk/client-s3');
      client = new sdk.S3Client({
        endpoint: cfg.registryEndpoint,
        region: cfg.registryRegion ?? 'us-east-1',
        credentials: { accessKeyId: credentials.registryAccessKeyId ?? cfg.registryAccessKeyId, secretAccessKey: credentials.registrySecretAccessKey },
        forcePathStyle: true,
      });
      return client;
    };
    return {
      list: async () => {
        const files: ModelFile[] = [];
        let token: string | undefined;
        do {
          const out = await s3().send(new sdk.ListObjectsV2Command({ Bucket: bucket, Prefix: prefix ? `${prefix}/` : undefined, ContinuationToken: token }));
          for (const obj of out.Contents ?? []) {
            const name = prefix ? String(obj.Key).slice(prefix.length + 1) : String(obj.Key);
            if (name && !name.endsWith('/')) files.push({ name, size: Number(obj.Size ?? 0) });
          }
          token = out.IsTruncated ? out.NextContinuationToken : undefined;
        } while (token);
        return files;
      },
      open: async (name) => (await s3().send(new sdk.GetObjectCommand({ Bucket: bucket, Key: prefix ? `${prefix}/${name}` : name }))).Body,
    };
  }

  /** Create the model, push every file to its signed URL, validate. Idempotent per version: an existing READY model is reused. */
  async upload(version: DeployRequest['version'], credentials: AdapterCredentials, cfg: Record<string, any> = {}): Promise<UploadResult> {
    const headers = this.headers(credentials);
    const account = this.account(cfg);
    const modelId = FireworksAdapter.resourceId('model', version.id);
    const modelName = `accounts/${cfg.account}/models/${modelId}`;
    const result = { registryUri: `fireworks://${modelName}@${version.manifestSha ?? version.id}` };
    const fromHub = version.registryUri.startsWith('hf://');
    try {
      const existing = await this.http.get(`${account}/models/${modelId}`, { headers }).catch((err) => {
        if (err?.response?.status === 404) return null;
        throw err;
      });
      if (existing?.data?.state === 'READY') return result;

      const source = this.fileSource(version, credentials, cfg);
      // The registry's own manifest is not part of the checkpoint.
      const files = (await source.list()).filter((f) => f.name !== REGISTRY_MANIFEST);
      if (!files.length) throw Object.assign(new Error(`no files found at ${version.registryUri}`), { code: 'ADAPTER_ERROR' });

      if (!existing) {
        await this.http.post(
          `${account}/models`,
          {
            modelId,
            model: {
              displayName: version.name.slice(0, 64),
              description: `almyty version ${version.id}`,
              kind: 'HF_BASE_MODEL',
              ...(fromHub ? { huggingFaceUrl: `${HF_URL}/${version.registryUri.slice('hf://'.length).split('@')[0]}` } : {}),
              baseModelDetails: { checkpointFormat: 'HUGGINGFACE', worldSize: 1, huggingfaceFiles: files.map((f) => f.name) },
            },
          },
          { headers },
        );
      }

      const filenameToSize = Object.fromEntries(files.map((f) => [f.name, f.size]));
      const endpoints = await this.http.post(`${account}/models/${modelId}:getUploadEndpoint`, { filenameToSize, enableResumableUpload: false }, { headers });
      const signed: Record<string, string> = endpoints.data?.filenameToSignedUrls ?? {};
      for (const file of files) {
        const url = signed[file.name];
        if (!url) throw Object.assign(new Error(`Fireworks issued no upload URL for ${file.name}`), { code: 'ADAPTER_ERROR' });
        // Signed URLs carry their own auth; the bearer header must not go to the storage host.
        await this.http.put(url, await source.open(file.name), {
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size), 'x-goog-content-length-range': `${file.size},${file.size}` },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
        });
      }

      const deadline = Date.now() + (cfg.uploadTimeoutMinutes ?? 60) * 60_000;
      for (;;) {
        try {
          await this.http.get(`${account}/models/${modelId}:validateUpload`, { headers });
          break;
        } catch (err: any) {
          // FAILED_PRECONDITION means the files are still landing.
          const still = err?.response?.status === 400 || /FAILED_PRECONDITION/.test(String(err?.response?.data?.status ?? err?.response?.data?.message ?? ''));
          if (!still) throw err;
          if (Date.now() > deadline) throw Object.assign(new Error(`model ${modelId} still validating after ${cfg.uploadTimeoutMinutes ?? 60} minutes`), { code: 'ADAPTER_ERROR' });
          await this.sleep(5_000);
        }
      }
      return result;
    } catch (err) {
      this.classify(err, 'model upload failed');
    }
  }

  private placement(region: string): Record<string, any> {
    return MULTI_REGIONS.includes(region) ? { multiRegion: region } : { region };
  }

  async deploy(request: DeployRequest, credentials: AdapterCredentials): Promise<EndpointRef> {
    const cfg = request.providerConfig;
    const headers = this.headers(credentials);
    const account = this.account(cfg);
    const uri = request.version.registryUri;
    const baseModel = uri.startsWith('fireworks://')
      ? uri.slice('fireworks://'.length).split('@')[0]
      : (await this.upload(request.version, credentials, cfg)).registryUri.slice('fireworks://'.length).split('@')[0];
    const deploymentId = FireworksAdapter.resourceId('deployment', request.deploymentId);
    const region = String(request.desired.region ?? cfg.region ?? 'GLOBAL');
    const acceleratorType = request.desired.hardware ?? cfg.acceleratorType ?? 'NVIDIA_H100_80GB';
    const acceleratorCount = Number(cfg.acceleratorCount ?? 1);
    const minReplicaCount = request.desired.minScale ?? 0;
    const maxReplicaCount = Math.max(request.desired.maxScale ?? request.desired.replicas ?? 1, 1);
    const body = {
      baseModel,
      displayName: `almyty ${request.deploymentId}`.slice(0, 64),
      minReplicaCount,
      maxReplicaCount,
      acceleratorType,
      acceleratorCount,
      ...(request.desired.quantization ?? cfg.precision ? { precision: request.desired.quantization ?? cfg.precision } : {}),
      autoscalingPolicy: { scaleToZeroWindow: cfg.scaleToZeroWindow ?? '1h' },
      placement: this.placement(region),
    };
    try {
      const res = await this.http.post(`${account}/deployments`, body, { headers, params: { deploymentId } });
      const name = res.data?.name ?? `accounts/${cfg.account}/deployments/${deploymentId}`;
      return {
        account: cfg.account,
        deploymentId,
        name,
        baseModel,
        acceleratorType,
        acceleratorCount,
        maxReplicas: maxReplicaCount,
        singleRegion: !MULTI_REGIONS.includes(region),
        url: INFERENCE_URL,
        createdAt: new Date().toISOString(),
        hourlyRateCents: cfg.hourlyRateCents ?? 0,
      };
    } catch (err) {
      this.classify(err, 'create deployment failed');
    }
  }

  private deploymentUrl(ref: EndpointRef): string {
    return `${BASE_URL}/accounts/${encodeURIComponent(ref.account)}/deployments/${encodeURIComponent(ref.deploymentId)}`;
  }

  async readEndpoint(ref: EndpointRef, credentials: AdapterCredentials): Promise<ActualState> {
    try {
      const res = await this.http.get(this.deploymentUrl(ref), { headers: this.headers(credentials) });
      const d = res.data ?? {};
      const raw = String(d.state ?? 'CREATING');
      const replicas = Number(d.replicaStats?.readyReplicaCount ?? d.replicaCount ?? 0);
      let state = STATE_MAP[raw] ?? 'deploying';
      // READY with no replicas is a deployment that scaled to zero.
      if (state === 'ready' && replicas === 0) state = 'stopped';
      return {
        state,
        url: INFERENCE_URL,
        replicas,
        hardware: d.acceleratorType ? `${d.acceleratorCount ?? ref.acceleratorCount ?? 1}x ${d.acceleratorType}` : undefined,
        region: d.region ?? d.placement?.region ?? d.placement?.multiRegion,
        message: d.status?.message,
        details: { rawState: raw, model: d.name ?? ref.name, minReplicaCount: d.minReplicaCount, maxReplicaCount: d.maxReplicaCount, desiredReplicaCount: d.desiredReplicaCount, statusCode: d.status?.code },
      };
    } catch (err: any) {
      if (err?.response?.status === 404) return { state: 'missing', message: 'deployment not found' };
      this.classify(err, 'read deployment failed');
    }
  }

  /** Sets the replica floor, then the current count; zero leaves the deployment READY with no replicas billed. */
  async scale(ref: EndpointRef, replicas: number, credentials: AdapterCredentials): Promise<void> {
    const headers = this.headers(credentials);
    const url = this.deploymentUrl(ref);
    try {
      // PATCH requires baseModel even when only the counts change.
      await this.http.patch(url, { baseModel: ref.baseModel, minReplicaCount: replicas, maxReplicaCount: Math.max(replicas, Number(ref.maxReplicas ?? 1)) }, { headers });
      await this.http.patch(`${url}:scale`, { replicaCount: replicas }, { headers });
    } catch (err) {
      this.classify(err, 'scale failed');
    }
  }

  /** Removes the deployment; the uploaded model stays, reusable for the same version. */
  async teardown(ref: EndpointRef, credentials: AdapterCredentials): Promise<void> {
    try {
      await this.http.delete(this.deploymentUrl(ref), { headers: this.headers(credentials), params: { ignoreChecks: true } });
    } catch (err: any) {
      if (err?.response?.status === 404) return;
      this.classify(err, 'delete failed');
    }
  }

  /** Fireworks bills per GPU-second while replicas run and publishes no spend API: list price times running GPUs, spend from uptime. */
  async costSnapshot(ref: EndpointRef, credentials: AdapterCredentials): Promise<CostSnapshot> {
    const actual = await this.readEndpoint(ref, credentials);
    const perGpu = Number(ref.hourlyRateCents) > 0 ? Number(ref.hourlyRateCents) : GPU_HOURLY_CENTS[String(ref.acceleratorType)] ?? 0;
    const rate = Math.round(perGpu * Number(ref.acceleratorCount ?? 1) * (ref.singleRegion ? SINGLE_REGION_PREMIUM : 1));
    const running = actual.state === 'ready' || actual.state === 'degraded' ? actual.replicas ?? 1 : 0;
    const hours = ref.createdAt ? Math.max(0, (Date.now() - new Date(ref.createdAt).getTime()) / 3_600_000) : 0;
    return { spentCents: Math.round(rate * hours), ratePerHourCents: rate * running, observedAt: new Date() };
  }
}
