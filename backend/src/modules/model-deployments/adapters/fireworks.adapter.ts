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
 * Fireworks AI on-demand (dedicated) deployments: the Gateway REST API at
 * https://api.fireworks.ai/v1/accounts/{account}, bearer token.
 *
 * Fireworks deploys a model that already exists in the account: one from
 * the Fireworks catalog, a Fireworks fine-tune, or a checkpoint imported
 * into the account from object storage, which Fireworks reads itself
 * (`firectl model create <id> s3://bucket/path --role-arn ...`). There is
 * no server-side import from a Hugging Face repository, and the only
 * transfer route the REST API exposes is a signed-URL upload the client
 * feeds byte by byte. almyty does not do that: it will not become the data
 * path for a multi-gigabyte checkpoint. See
 * docs/design/adapters/fireworks.md.
 */
const BASE_URL = 'https://api.fireworks.ai/v1';
const INFERENCE_URL = 'https://api.fireworks.ai/inference/v1';
const MULTI_REGIONS = ['GLOBAL', 'US', 'EUROPE', 'APAC'];
const SINGLE_REGIONS = [
  'AP_MALAYSIA_2', 'AP_NEWSOUTHWALES_1', 'AP_TOKYO_1', 'AP_TOKYO_2',
  'EU_FRANKFURT_1', 'EU_ICELAND_1', 'EU_ICELAND_2',
  'NA_BRITISHCOLUMBIA_1', 'NA_BRITISHCOLUMBIA_2', 'NA_BRITISHCOLUMBIA_3',
  'US_ARIZONA_1', 'US_ARIZONA_3', 'US_CALIFORNIA_1', 'US_CALIFORNIA_2', 'US_GEORGIA_2', 'US_GEORGIA_3',
  'US_ILLINOIS_1', 'US_ILLINOIS_2', 'US_IOWA_1', 'US_MINNESOTA_1', 'US_NEWYORK_1', 'US_OHIO_1', 'US_VIRGINIA_1',
  'US_WASHINGTON_3', 'US_WASHINGTON_4', 'US_WASHINGTON_5',
];
const ACCELERATORS = [
  'NVIDIA_A100_80GB', 'NVIDIA_H100_80GB', 'NVIDIA_H200_141GB', 'NVIDIA_B200_180GB', 'NVIDIA_B300_288GB',
  'NVIDIA_GB300', 'AMD_MI325X_256GB', 'AMD_MI350X_288GB',
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
/** billingUsage caps a request at a 31-day window. */
const BILLING_WINDOW_DAYS = 31;

const STATE_MAP: Record<string, ActualState['state']> = {
  CREATING: 'deploying',
  READY: 'ready',
  UPDATING: 'scaling',
  DELETING: 'stopped',
  DELETED: 'missing',
  FAILED: 'failed',
};

export class FireworksAdapter implements ModelProviderAdapter {
  readonly key = 'fireworks';
  readonly displayName = 'Fireworks AI (on-demand deployments)';

  constructor(private readonly http: AxiosInstance = axios.create({ timeout: 60_000 })) {}

  capabilities(): AdapterCapabilities {
    return {
      architectures: 'any',
      lora: 'multi',
      // Serverless exists on Fireworks, but only over their own catalog; this adapter runs dedicated GPUs.
      serverless: false,
      dedicated: true,
      scaleToZero: true,
      regions: [...MULTI_REGIONS, ...SINGLE_REGIONS],
      // Fireworks reads a checkpoint out of object storage itself, with credentials
      // the operator gives it. It has no Hugging Face import for inference.
      registrySources: ['s3'],
    };
  }

  configSchema(): Record<string, any> {
    return {
      type: 'object',
      properties: {
        apiKey: { type: 'string', title: 'Fireworks API key', 'x-secret': true },
        account: { type: 'string', title: 'Account id', description: 'The {account_id} in accounts/{account_id}/...' },
        deploymentShape: { type: 'string', title: 'Deployment shape', description: 'A validated hardware and precision template, e.g. fast, throughput, minimal, or a full shape id. Fireworks warns against creating a deployment without one' },
        acceleratorType: { type: 'string', title: 'Accelerator', enum: ACCELERATORS, description: 'Only when no shape fits' },
        acceleratorCount: { type: 'integer', minimum: 1, default: 1 },
        precision: { type: 'string', title: 'Precision', description: 'e.g. FP16, BF16, FP8; omitted lets Fireworks choose' },
        region: { type: 'string', title: 'Placement', description: 'A multi-region (GLOBAL, US, EUROPE, APAC) or a single region; single regions cost 1.5x and need their own quota', default: 'GLOBAL' },
        scaleToZeroWindow: { type: 'string', title: 'Scale-to-zero window', description: 'Idle time before replicas drop to zero, at least 5m', default: '1h' },
        hourlyRateCents: { type: 'integer', title: 'GPU price per hour (cents)', description: 'Overrides the built-in list-price table' },
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

  /**
   * The `accounts/{account}/models/{model}` resource this version maps to.
   * A `fireworks://` version names one outright; an object-storage version
   * maps to the deterministic id the documented import should have created.
   */
  static baseModel(version: DeployRequest['version'], account: string): string {
    const uri = version.registryUri;
    if (uri.startsWith('fireworks://')) return uri.slice('fireworks://'.length).split('@')[0];
    if (uri.startsWith('s3://')) return `accounts/${account}/models/${FireworksAdapter.resourceId('model', version.id)}`;
    throw Object.assign(
      new Error(
        `Fireworks deploys a model that already lives in the account: point the version at fireworks://accounts/{account}/models/{model} for a catalog model or a Fireworks fine-tune, or at s3:// for a checkpoint imported with firectl. It has no Hugging Face import for inference, so ${uri.split(':')[0]}:// cannot be served`,
      ),
      { code: 'ADAPTER_UNSUPPORTED_SOURCE' },
    );
  }

  private placement(region: string): Record<string, any> {
    return MULTI_REGIONS.includes(region) ? { multiRegion: region } : { region };
  }

  /**
   * The import is the operator's step, not ours: Fireworks reads the
   * bucket itself with credentials it holds, so no weight ever crosses
   * this backend.
   */
  private importInstruction(version: DeployRequest['version'], modelId: string): never {
    const bucket = version.registryUri.replace(/@[^@/]+$/, '');
    throw Object.assign(
      new Error(
        `Fireworks holds no model ${modelId} yet. Import the checkpoint into the Fireworks account first, where Fireworks reads the bucket itself: firectl model create ${modelId} ${bucket} --role-arn <role with read access> (or --aws-access-key-id/--aws-secret-access-key). almyty does not stream weights through its own API.`,
      ),
      { code: 'ADAPTER_UNSUPPORTED_SOURCE' },
    );
  }

  async deploy(request: DeployRequest, credentials: AdapterCredentials): Promise<EndpointRef> {
    const cfg = request.providerConfig;
    const headers = this.headers(credentials);
    const account = this.account(cfg);
    const baseModel = FireworksAdapter.baseModel(request.version, cfg.account);
    const deploymentId = FireworksAdapter.resourceId('deployment', request.deploymentId);
    const region = String(request.desired.region ?? cfg.region ?? 'GLOBAL');
    const acceleratorType = request.desired.hardware ?? cfg.acceleratorType;
    const acceleratorCount = Number(cfg.acceleratorCount ?? 1);
    const minReplicaCount = request.desired.minScale ?? 0;
    const maxReplicaCount = Math.max(request.desired.maxScale ?? request.desired.replicas ?? 1, 1);

    try {
      if (request.version.registryUri.startsWith('s3://')) {
        const modelId = baseModel.split('/').pop() as string;
        const existing = await this.http.get(`${account}/models/${modelId}`, { headers }).catch((err) => {
          if (err?.response?.status === 404) return null;
          throw err;
        });
        if (!existing) this.importInstruction(request.version, modelId);
        if (existing.data?.state !== 'READY') {
          throw Object.assign(new Error(`Fireworks model ${modelId} is ${existing.data?.state ?? 'in an unknown state'}, not READY`), { code: 'ADAPTER_ERROR' });
        }
      }

      const body = {
        baseModel,
        displayName: `almyty ${request.deploymentId}`.slice(0, 64),
        minReplicaCount,
        maxReplicaCount,
        ...(cfg.deploymentShape ? { deploymentShape: cfg.deploymentShape } : {}),
        ...(acceleratorType ? { acceleratorType } : {}),
        ...(acceleratorType || cfg.acceleratorCount ? { acceleratorCount } : {}),
        ...(request.desired.quantization ?? cfg.precision ? { precision: request.desired.quantization ?? cfg.precision } : {}),
        autoscalingPolicy: { scaleToZeroWindow: cfg.scaleToZeroWindow ?? '1h' },
        placement: this.placement(region),
      };
      const res = await this.http.post(`${account}/deployments`, body, { headers, params: { deploymentId } });
      const name = res.data?.name ?? `accounts/${cfg.account}/deployments/${deploymentId}`;
      return {
        account: cfg.account,
        deploymentId,
        name,
        baseModel,
        acceleratorType: res.data?.acceleratorType ?? acceleratorType ?? null,
        acceleratorCount: res.data?.acceleratorCount ?? acceleratorCount,
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
        openAiBase: INFERENCE_URL,
        replicas,
        hardware: d.acceleratorType ? `${d.acceleratorCount ?? ref.acceleratorCount ?? 1}x ${d.acceleratorType}` : undefined,
        region: d.region ?? d.placement?.region ?? d.placement?.multiRegion,
        message: d.status?.message,
        details: {
          rawState: raw,
          // Inference addresses the deployment, not the model.
          model: d.name ?? ref.name,
          minReplicaCount: d.minReplicaCount,
          maxReplicaCount: d.maxReplicaCount,
          desiredReplicaCount: d.desiredReplicaCount,
          statusCode: d.status?.code,
        },
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

  /** Removes the deployment; the model stays in the account, reusable for the same version. */
  async teardown(ref: EndpointRef, credentials: AdapterCredentials): Promise<void> {
    try {
      await this.http.delete(this.deploymentUrl(ref), { headers: this.headers(credentials), params: { ignoreChecks: true } });
    } catch (err: any) {
      if (err?.response?.status === 404) return;
      this.classify(err, 'delete failed');
    }
  }

  /** Metered GPU-seconds for this deployment, from billingUsage. Zero when the window holds no rows. */
  private async acceleratorSeconds(ref: EndpointRef, headers: Record<string, string>): Promise<number> {
    const end = new Date();
    const start = new Date(Math.max(ref.createdAt ? new Date(ref.createdAt).getTime() : 0, end.getTime() - BILLING_WINDOW_DAYS * 86_400_000));
    const res = await this.http.post(
      `${BASE_URL}/accounts/${encodeURIComponent(ref.account)}/billingUsage:query`,
      {
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        usageType: 'DEDICATED_DEPLOYMENT',
        groupBy: ['deployment_name'],
        filter: { deployment_name: { values: [ref.name] } },
      },
      { headers },
    );
    const body = res.data ?? {};
    const rows: any[] = [body.dedicatedCosts, body.serverlessCosts, body.data, body.usage, body.rows].find(Array.isArray) ?? [];
    return rows.reduce((sum, row) => sum + Number(row?.acceleratorSeconds ?? row?.accelerator_seconds ?? 0), 0);
  }

  /**
   * Fireworks bills per GPU-second while replicas run. `billingUsage`
   * meters those seconds per deployment but reports no dollars at that
   * grain, so spend is metered seconds times the list price; the rate is
   * the same price times the GPUs running now.
   */
  async costSnapshot(ref: EndpointRef, credentials: AdapterCredentials): Promise<CostSnapshot> {
    const headers = this.headers(credentials);
    const actual = await this.readEndpoint(ref, credentials);
    const perGpu = Number(ref.hourlyRateCents) > 0 ? Number(ref.hourlyRateCents) : GPU_HOURLY_CENTS[String(ref.acceleratorType)] ?? 0;
    const premium = ref.singleRegion ? SINGLE_REGION_PREMIUM : 1;
    const gpusPerReplica = Number(ref.acceleratorCount ?? 1);
    const running = actual.state === 'ready' || actual.state === 'degraded' ? actual.replicas ?? 1 : 0;

    let spentCents: number;
    try {
      const seconds = await this.acceleratorSeconds(ref, headers);
      spentCents = Math.round((seconds / 3600) * perGpu * premium);
    } catch {
      // No billing access: fall back to the rate over observed uptime.
      const hours = ref.createdAt ? Math.max(0, (Date.now() - new Date(ref.createdAt).getTime()) / 3_600_000) : 0;
      spentCents = Math.round(perGpu * gpusPerReplica * premium * hours);
    }
    return {
      spentCents,
      ratePerHourCents: Math.round(perGpu * gpusPerReplica * premium) * running,
      observedAt: new Date(),
    };
  }
}
