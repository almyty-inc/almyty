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
 * Baseten: dedicated deployments on the Baseten Inference Stack (BIS-LLM).
 *
 * Management REST at https://api.baseten.co/v1 (hosted OpenAPI spec at
 * /v1/spec), `Authorization: Bearer <key>`. `POST /v1/llm_models` builds a
 * vLLM or TensorRT-LLM deployment from config alone, with no archive
 * upload. Weights come through the Baseten Delivery Network: each
 * `weights[]` entry names a `source` URI Baseten mirrors itself, and a
 * private source is authenticated with a per-source `auth` block that
 * points at a workspace secret. A Hugging Face repo is the documented
 * default. almyty never carries a weight file. See
 * docs/design/adapters/baseten.md.
 */
const BASE_URL = 'https://api.baseten.co/v1';
const MOUNT_LOCATION = '/models/almyty';
const DEFAULT_HF_SECRET = 'hf_access_token';
const DEFAULT_AWS_SECRET = 'aws_credentials';
const DEFAULT_GCS_SECRET = 'gcs_service_account';
/** BDN source schemes, from the weights reference. */
const SOURCE_SCHEMES = ['hf', 's3', 'gs', 'bt', 'r2', 'cw', 'azure'];
const BILLING_WINDOW_DAYS = 31;

const STATE_MAP: Record<string, ActualState['state']> = {
  BUILDING: 'deploying',
  DEPLOYING: 'deploying',
  LOADING_MODEL: 'deploying',
  WAKING_UP: 'deploying',
  ACTIVE: 'ready',
  UNHEALTHY: 'degraded',
  UPDATING: 'scaling',
  DEACTIVATING: 'scaling',
  INACTIVE: 'stopped',
  SCALED_TO_ZERO: 'stopped',
  BUILD_STOPPED: 'stopped',
  DEPLOY_FAILED: 'failed',
  BUILD_FAILED: 'failed',
  FAILED: 'failed',
};

export class BasetenAdapter implements ModelProviderAdapter {
  readonly key = 'baseten';
  readonly displayName = 'Baseten';

  constructor(private readonly http: AxiosInstance = axios.create({ timeout: 60_000 })) {}

  capabilities(): AdapterCapabilities {
    return {
      architectures: 'any',
      lora: 'merged',
      // Baseten's serverless offer is Model APIs over their own catalog; this adapter runs dedicated deployments.
      serverless: false,
      dedicated: true,
      scaleToZero: true,
      // Regional placement is enabled per workspace by Baseten and listed by GET /v1/regions; no public static list.
      regions: [],
      // BDN mirrors from any of these itself; the Hub is the documented default.
      registrySources: ['hub', 's3', 'gcs'],
    };
  }

  configSchema(): Record<string, any> {
    return {
      type: 'object',
      properties: {
        apiKey: { type: 'string', title: 'Baseten API key', 'x-secret': true },
        accelerator: { type: 'string', title: 'Accelerator', description: 'resources.accelerator, e.g. H100, H100:2, A10G, L4', default: 'H100' },
        region: { type: 'string', title: 'Region slug', description: 'Only after Baseten enabled the region for the workspace (GET /v1/regions)' },
        engineBackend: { type: 'string', enum: ['vllm', 'trtllm'], default: 'vllm' },
        engineConfig: { type: 'object', title: 'Engine config', description: 'Passed through as the engine_config block, in the active engine\'s own field names' },
        llmVersion: { type: 'string', title: 'Serving stack version', description: 'bis_llm.version; omitted uses the platform default' },
        scaleDownDelaySeconds: { type: 'integer', minimum: 0, default: 120 },
        concurrencyTarget: { type: 'integer', minimum: 1, description: 'Requests per replica before scaling up' },
        hfToken: { type: 'string', title: 'Hugging Face token (private or gated repo)', 'x-secret': true },
        hfSecretName: { type: 'string', title: 'Workspace secret holding the Hub token', default: DEFAULT_HF_SECRET },
        registrySecretName: { type: 'string', title: 'Workspace secret holding object-storage credentials', default: DEFAULT_AWS_SECRET },
        registryAccessKeyId: { type: 'string', title: 'Object-storage access key id', description: 'An identifier, not a secret; the secret key below is encrypted' },
        registrySecretAccessKey: { type: 'string', title: 'Object-storage secret key', 'x-secret': true },
        registryRegion: { type: 'string', title: 'Object-storage region', default: 'us-east-1' },
        hourlyRateCents: { type: 'integer', title: 'Instance price per hour (cents)', description: 'Fallback when GET /v1/instance_type_prices has no entry for the instance' },
      },
      required: ['apiKey'],
    };
  }

  private headers(credentials: AdapterCredentials) {
    if (!credentials.apiKey) throw Object.assign(new Error('missing Baseten API key'), { code: 'ADAPTER_AUTH', status: 401 });
    return { Authorization: `Bearer ${credentials.apiKey}`, 'Content-Type': 'application/json' };
  }

  private classify(err: any, fallback: string): never {
    if (typeof err?.code === 'string' && err.code.startsWith('ADAPTER_')) throw err;
    const status = err?.response?.status;
    const body = err?.response?.data;
    const message = body?.error ?? body?.detail ?? body?.message ?? err?.message ?? fallback;
    if (status === 401 || status === 403) throw Object.assign(new Error(`credential rejected: ${message}`), { code: 'ADAPTER_AUTH', status });
    if (status === 402 || status === 429 || /quota|limit|capacity/i.test(String(message))) {
      throw Object.assign(new Error(`quota: ${message}`), { code: 'ADAPTER_QUOTA_EXCEEDED', status });
    }
    if (status === 404) throw Object.assign(new Error(`not found: ${message}`), { code: 'ADAPTER_NOT_FOUND', status });
    throw Object.assign(new Error(String(message)), { code: 'ADAPTER_ERROR', status });
  }

  static modelName(deploymentId: string): string {
    return `almyty-${deploymentId.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 20)}`;
  }

  /** The BDN `source` URI for a version. `hf://` keeps its revision pin; a bucket URI drops the registry's @etag. */
  static weightSource(registryUri: string): string {
    const scheme = registryUri.split('://')[0];
    if (!SOURCE_SCHEMES.includes(scheme)) {
      throw Object.assign(
        new Error(`Baseten mirrors weights from ${SOURCE_SCHEMES.map((s) => `${s}://`).join(', ')}; ${scheme}:// is not one of them`),
        { code: 'ADAPTER_UNSUPPORTED_SOURCE' },
      );
    }
    return scheme === 'hf' ? registryUri : registryUri.replace(/@[A-Za-z0-9._:-]+$/, '');
  }

  private async upsertSecret(name: string, value: string, credentials: AdapterCredentials): Promise<void> {
    await this.http.post(`${BASE_URL}/secrets`, { name, value }, { headers: this.headers(credentials) });
  }

  async deploy(request: DeployRequest, credentials: AdapterCredentials): Promise<EndpointRef> {
    const cfg = request.providerConfig;
    const headers = this.headers(credentials);
    const name = BasetenAdapter.modelName(request.deploymentId);
    const source = BasetenAdapter.weightSource(request.version.registryUri);
    const fromHub = source.startsWith('hf://');
    const accelerator = request.desired.hardware ?? cfg.accelerator ?? 'H100';
    const tensorParallel = Number(String(accelerator).split(':')[1] ?? 1) || 1;
    const minReplica = request.desired.minScale ?? 0;
    const maxReplica = Math.max(request.desired.maxScale ?? request.desired.replicas ?? 1, 1);

    // BDN authenticates a private source through this per-source block, not through the top-level secrets config.
    const secretName = fromHub ? cfg.hfSecretName ?? DEFAULT_HF_SECRET : source.startsWith('gs://') ? DEFAULT_GCS_SECRET : cfg.registrySecretName ?? DEFAULT_AWS_SECRET;
    const secretValue = fromHub
      ? credentials.hfToken
      : credentials.registrySecretAccessKey
        ? JSON.stringify({
            aws_access_key_id: credentials.registryAccessKeyId ?? cfg.registryAccessKeyId ?? '',
            aws_secret_access_key: credentials.registrySecretAccessKey,
            aws_region: cfg.registryRegion ?? 'us-east-1',
          })
        : undefined;

    const body = {
      name,
      resources: { accelerator, use_gpu: true },
      ...(request.desired.region ?? cfg.region ? { region: request.desired.region ?? cfg.region } : {}),
      ...(cfg.llmVersion ? { llm_version: cfg.llmVersion } : {}),
      llm_config: {
        engine_backend: cfg.engineBackend ?? 'vllm',
        checkpoint_name: MOUNT_LOCATION,
        model_name: MOUNT_LOCATION,
        // Point the engine and its tokenizer at the mounted path so nothing is refetched at startup.
        model_path: MOUNT_LOCATION,
        model_path_for_tokenizer: MOUNT_LOCATION,
        served_model_name: request.version.name,
        tensor_parallel_size: tensorParallel,
        ...(cfg.engineConfig ? { engine_config: cfg.engineConfig } : {}),
      },
      weights: [
        {
          source,
          mount_location: MOUNT_LOCATION,
          ...(secretValue ? { auth: { auth_method: 'CUSTOM_SECRET', auth_secret_name: secretName } } : {}),
        },
      ],
      autoscaling_settings: {
        min_replica: minReplica,
        max_replica: maxReplica,
        scale_down_delay: cfg.scaleDownDelaySeconds ?? 120,
        ...(cfg.concurrencyTarget ? { concurrency_target: cfg.concurrencyTarget } : {}),
      },
      metadata: { almyty_deployment_id: request.deploymentId, almyty_version_id: request.version.id, almyty_manifest_sha: request.version.manifestSha },
    };

    try {
      // Secrets live at workspace level and are referenced by name; they never travel in the deployment body.
      if (secretValue) await this.upsertSecret(secretName, secretValue, credentials);

      const res = await this.http.post(`${BASE_URL}/llm_models`, body, { headers });
      const handle = res.data ?? {};
      const hostname = handle.hostname ?? `model-${handle.model_id}.api.baseten.co`;
      return {
        modelId: handle.model_id,
        deploymentId: handle.version_id,
        hostname,
        // Deployment-scoped OpenAI-compatible base: the /deployment/{id} route plus the sync/v1 suffix.
        url: `https://${hostname}/deployment/${handle.version_id}/sync/v1`,
        servedModelName: request.version.name,
        instanceType: handle.instance_type_name ?? null,
        maxReplica,
        createdAt: new Date().toISOString(),
        hourlyRateCents: cfg.hourlyRateCents ?? 0,
      };
    } catch (err) {
      this.classify(err, 'create BIS-LLM deployment failed');
    }
  }

  private deploymentUrl(ref: EndpointRef): string {
    return `${BASE_URL}/models/${encodeURIComponent(ref.modelId)}/deployments/${encodeURIComponent(ref.deploymentId)}`;
  }

  async readEndpoint(ref: EndpointRef, credentials: AdapterCredentials): Promise<ActualState> {
    try {
      const res = await this.http.get(this.deploymentUrl(ref), { headers: this.headers(credentials) });
      const d = res.data ?? {};
      const raw = String(d.status ?? 'DEPLOYING');
      return {
        state: STATE_MAP[raw] ?? 'deploying',
        url: ref.url,
        openAiBase: ref.url,
        replicas: typeof d.active_replica_count === 'number' ? d.active_replica_count : undefined,
        hardware: d.instance_type_name ?? ref.instanceType ?? undefined,
        region: d.region?.slug,
        details: {
          rawState: raw,
          minReplica: d.autoscaling_settings?.min_replica,
          maxReplica: d.autoscaling_settings?.max_replica,
          isProduction: d.is_production,
        },
      };
    } catch (err: any) {
      if (err?.response?.status === 404) return { state: 'missing', message: 'deployment not found' };
      this.classify(err, 'read deployment failed');
    }
  }

  /** Zero deactivates the deployment (nothing billed); a positive count sets the replica floor and activates. */
  async scale(ref: EndpointRef, replicas: number, credentials: AdapterCredentials): Promise<void> {
    const headers = this.headers(credentials);
    const base = this.deploymentUrl(ref);
    try {
      if (replicas === 0) {
        await this.http.post(`${base}/deactivate`, {}, { headers });
        return;
      }
      await this.http.patch(
        `${base}/autoscaling_settings`,
        { min_replica: replicas, max_replica: Math.max(replicas, Number(ref.maxReplica ?? 1)) },
        { headers },
      );
      await this.http.post(`${base}/activate`, {}, { headers });
    } catch (err) {
      this.classify(err, 'scale failed');
    }
  }

  /** The model was created for this deployment alone, so both go. The workspace secret stays. */
  async teardown(ref: EndpointRef, credentials: AdapterCredentials): Promise<void> {
    const headers = this.headers(credentials);
    const ignoreMissing = (err: any) => {
      if (err?.response?.status === 404) return;
      this.classify(err, 'delete failed');
    };
    await this.http.delete(this.deploymentUrl(ref), { headers }).catch(ignoreMissing);
    await this.http.delete(`${BASE_URL}/models/${encodeURIComponent(ref.modelId)}`, { headers }).catch(ignoreMissing);
  }

  /** Burn rate from the published instance price; spend from the billing summary, falling back to rate times uptime. */
  async costSnapshot(ref: EndpointRef, credentials: AdapterCredentials): Promise<CostSnapshot> {
    const headers = this.headers(credentials);
    const actual = await this.readEndpoint(ref, credentials);
    const running = actual.state === 'ready' || actual.state === 'degraded' ? actual.replicas ?? 1 : 0;
    const instance = actual.hardware ?? ref.instanceType;

    let rate = Number(ref.hourlyRateCents ?? 0);
    try {
      const prices = await this.http.get(`${BASE_URL}/instance_type_prices`, { headers });
      const match = (prices.data?.instance_types ?? []).find((e: any) => e?.instance_type?.name === instance || e?.instance_type?.id === instance);
      // price is USD per minute.
      const perMinute = Number(match?.price);
      if (Number.isFinite(perMinute) && perMinute > 0) rate = Math.round(perMinute * 60 * 100);
    } catch {
      // No price list access: the configured rate stands.
    }

    const hours = ref.createdAt ? Math.max(0, (Date.now() - new Date(ref.createdAt).getTime()) / 3_600_000) : 0;
    let spentCents = Math.round(rate * hours);
    try {
      const end = new Date();
      const start = new Date(Math.max(ref.createdAt ? new Date(ref.createdAt).getTime() : 0, end.getTime() - BILLING_WINDOW_DAYS * 86_400_000));
      const usage = await this.http.get(`${BASE_URL}/billing/usage_summary`, { headers, params: { start_date: start.toISOString(), end_date: end.toISOString() } });
      const items: any[] = usage.data?.dedicated_usage?.breakdown ?? [];
      const mine = items.filter((i) => i?.billable_resource?.id === ref.deploymentId || i?.billable_resource?.model_id === ref.modelId);
      // Money fields come back as a number or a decimal string.
      if (mine.length) spentCents = Math.round(mine.reduce((sum, i) => sum + Number(i.subtotal ?? 0), 0) * 100);
    } catch {
      // Billing summary needs a workspace-level key; the estimate stands.
    }

    return { spentCents, ratePerHourCents: rate * running, observedAt: new Date() };
  }
}
