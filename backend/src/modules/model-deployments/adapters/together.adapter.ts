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
 * Together AI dedicated model inference (DMI), the v2 resource model:
 * project -> model -> config -> endpoint -> deployment -> replicas.
 *
 * A custom checkpoint reaches Together through a **remote upload**: we
 * register the model, then hand Together the Hugging Face repo URL and,
 * for a private or gated repo, the customer's own Hub token. Together
 * streams the weights server-side. almyty never carries a byte.
 *
 * v1 (`POST /v1/endpoints`) is closed to new endpoints: it answers
 * `endpoints_v1_create_access_disabled` (403). See
 * docs/design/adapters/together.md.
 */
const BASE_URL = 'https://api.together.ai/v2';
const V1_URL = 'https://api.together.ai/v1';
const INFERENCE_URL = 'https://api-inference.together.ai/v1';
const INSTANCE_TYPES_URL = `${BASE_URL}/public/inference-instance-types`;
const UPLOAD_TERMINAL_FAILURES = /_(ERROR|FAILED)$/;

const STATE_MAP: Record<string, ActualState['state']> = {
  DEPLOYMENT_STATE_PROVISIONING: 'deploying',
  DEPLOYMENT_STATE_SCALING: 'scaling',
  DEPLOYMENT_STATE_READY: 'ready',
  DEPLOYMENT_STATE_DEGRADED: 'degraded',
  DEPLOYMENT_STATE_STOPPING: 'scaling',
  DEPLOYMENT_STATE_STOPPED: 'stopped',
  DEPLOYMENT_STATE_FAILED: 'failed',
};

export class TogetherAdapter implements ModelProviderAdapter {
  readonly key = 'together';
  readonly displayName = 'Together AI (dedicated model inference)';

  constructor(
    private readonly http: AxiosInstance = axios.create({ timeout: 60_000 }),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  capabilities(): AdapterCapabilities {
    return {
      // An upload must be a fine-tuned variant of an architecture Together already serves.
      architectures: 'any',
      lora: 'multi',
      serverless: false,
      dedicated: true,
      // Both replica bounds at zero stops a deployment and it bills nothing.
      scaleToZero: true,
      // Regions come from a placement profile or a config's instance-type headroom; no static list.
      regions: [],
      // Together's remote upload reads a Hugging Face repository itself.
      registrySources: ['hub'],
    };
  }

  configSchema(): Record<string, any> {
    return {
      type: 'object',
      properties: {
        apiKey: { type: 'string', title: 'Together API key', 'x-secret': true },
        projectId: { type: 'string', title: 'Project id', description: 'proj_...; read from GET /v1/whoami when omitted' },
        baseModelId: { type: 'string', title: 'Base model id', description: 'ml_... of the supported architecture an uploaded fine-tune derives from; required to upload' },
        configId: { type: 'string', title: 'Deployment profile', description: 'cr_... config revision; the first published config for the model is used when omitted' },
        hfToken: { type: 'string', title: 'Hugging Face token (private or gated repo)', description: 'Passed to Together for the remote upload only; write-only on their side', 'x-secret': true },
        regions: { type: 'array', items: { type: 'string' }, title: 'Placement regions', description: 'Inline placement; placement cannot be changed after the deployment is created' },
        placementConstraint: { type: 'string', enum: ['ENFORCEMENT_PREFERRED', 'ENFORCEMENT_REQUIRED'], default: 'ENFORCEMENT_PREFERRED' },
        scaleUpWindowSeconds: { type: 'integer', minimum: 0, title: 'Scale-up stabilization window (s)' },
        scaleDownWindowSeconds: { type: 'integer', minimum: 0, title: 'Scale-down stabilization window (s)' },
        scaleToZeroWindowSeconds: { type: 'integer', minimum: 0, title: 'Idle seconds before the deployment stops' },
        uploadTimeoutMinutes: { type: 'integer', minimum: 1, default: 60 },
        hourlyRateCents: { type: 'integer', title: 'Replica price per hour (cents)', description: 'Fallback when the public instance-type catalog has no price for the hardware' },
      },
      required: ['apiKey'],
    };
  }

  private headers(credentials: AdapterCredentials) {
    if (!credentials.apiKey) throw Object.assign(new Error('missing Together API key'), { code: 'ADAPTER_AUTH', status: 401 });
    return { Authorization: `Bearer ${credentials.apiKey}`, 'Content-Type': 'application/json' };
  }

  private classify(err: any, fallback: string): never {
    if (typeof err?.code === 'string' && err.code.startsWith('ADAPTER_')) throw err;
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

  /** The Hugging Face repo URL Together's remote upload reads. Nothing else can be imported. */
  static remoteUrl(registryUri: string): string {
    if (!registryUri.startsWith('hf://')) {
      throw Object.assign(
        new Error(
          `Together imports custom weights from a Hugging Face repository, or serves a model already in the project: point the version at hf://owner/repo or together://ml_..., not ${registryUri.split(':')[0]}://`,
        ),
        { code: 'ADAPTER_UNSUPPORTED_SOURCE' },
      );
    }
    return `https://huggingface.co/${registryUri.slice('hf://'.length).split('@')[0]}`;
  }

  /** proj_... from providerConfig, else from the key itself. */
  private async project(cfg: Record<string, any>, credentials: AdapterCredentials): Promise<{ id: string; slug?: string }> {
    if (cfg.projectId) return { id: cfg.projectId, slug: cfg.projectSlug };
    const res = await this.http.get(`${V1_URL}/whoami`, { headers: this.headers(credentials) });
    return { id: res.data?.project_id, slug: res.data?.project_slug };
  }

  /**
   * Register the version as a project model and have Together pull the
   * weights from the Hub. Returns a `together://ml_...` URI deploy() uses
   * directly on a later attempt.
   */
  async upload(version: DeployRequest['version'], credentials: AdapterCredentials, cfg: Record<string, any> = {}): Promise<UploadResult> {
    const headers = this.headers(credentials);
    const remoteUrl = TogetherAdapter.remoteUrl(version.registryUri);
    const baseModelId = cfg.baseModelId;
    if (!baseModelId) {
      throw Object.assign(
        new Error('Together requires providerConfig.baseModelId (ml_... of a supported base model) before it will accept an uploaded fine-tune'),
        { code: 'ADAPTER_UNSUPPORTED_SOURCE' },
      );
    }
    try {
      const project = await this.project(cfg, credentials);
      const created = await this.http.post(
        `${BASE_URL}/projects/${encodeURIComponent(project.id)}/models`,
        {
          name: `almyty-${version.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-${version.id.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 8)}`,
          type: 'model',
          baseModelId,
          description: `almyty version ${version.id} (${version.manifestSha ?? 'no manifest'})`,
        },
        { headers },
      );
      const modelId = created.data?.id;
      const job = await this.http.post(
        `${BASE_URL}/projects/${encodeURIComponent(project.id)}/models/uploads`,
        { modelId, remoteUrl, ...(credentials.hfToken ? { token: credentials.hfToken } : {}) },
        { headers },
      );
      const jobId = job.data?.id;
      const deadline = Date.now() + (cfg.uploadTimeoutMinutes ?? 60) * 60_000;
      for (;;) {
        const poll = await this.http.get(`${BASE_URL}/projects/${encodeURIComponent(project.id)}/models/uploads/${encodeURIComponent(jobId)}`, { headers });
        const status = String(poll.data?.status ?? '');
        if (status === 'REMOTE_UPLOAD_STATUS_SUCCEEDED') break;
        if (UPLOAD_TERMINAL_FAILURES.test(status)) {
          throw Object.assign(new Error(`remote upload ${jobId} ${status}: ${poll.data?.statusMessage ?? ''}`), { code: 'ADAPTER_ERROR' });
        }
        if (Date.now() > deadline) throw Object.assign(new Error(`remote upload ${jobId} still ${status} after ${cfg.uploadTimeoutMinutes ?? 60} minutes`), { code: 'ADAPTER_ERROR' });
        await this.sleep(5_000);
      }
      return { registryUri: `together://${modelId}` };
    } catch (err) {
      this.classify(err, 'remote upload failed');
    }
  }

  /** A published config revision for the model: the operator's choice, or the model's only profile. */
  private async configRevision(projectId: string, modelId: string, cfg: Record<string, any>, headers: Record<string, string>): Promise<string> {
    if (cfg.configId) return `projects/${projectId}/configs/${cfg.configId}`;
    const res = await this.http.get(`${BASE_URL}/projects/${encodeURIComponent(projectId)}/configs`, {
      headers,
      params: { referenceModel: `projects/${projectId}/models/${modelId}` },
    });
    const configs: any[] = res.data?.data ?? [];
    if (!configs.length) {
      throw Object.assign(new Error(`Together publishes no deployment profile for model ${modelId}`), { code: 'ADAPTER_UNSUPPORTED_ARCHITECTURE' });
    }
    if (configs.length > 1 && !cfg.configId) {
      // More than one profile means quantization and hardware are ambiguous; Together's own CLI refuses here too.
      throw Object.assign(
        new Error(`model ${modelId} has ${configs.length} deployment profiles; set providerConfig.configId to one of ${configs.map((c) => c.id ?? c.name).join(', ')}`),
        { code: 'ADAPTER_ERROR' },
      );
    }
    return configs[0].name ?? `projects/${projectId}/configs/${configs[0].id}`;
  }

  private autoscaling(request: DeployRequest, cfg: Record<string, any>): Record<string, any> {
    const seconds = (v: any) => (Number.isFinite(Number(v)) ? `${Number(v)}s` : undefined);
    return {
      minReplicas: request.desired.minScale ?? 0,
      maxReplicas: Math.max(request.desired.maxScale ?? request.desired.replicas ?? 1, 1),
      ...(seconds(cfg.scaleUpWindowSeconds) ? { scaleUpWindow: seconds(cfg.scaleUpWindowSeconds) } : {}),
      ...(seconds(cfg.scaleDownWindowSeconds) ? { scaleDownWindow: seconds(cfg.scaleDownWindowSeconds) } : {}),
      ...(seconds(cfg.scaleToZeroWindowSeconds) ? { scaleToZeroWindow: seconds(cfg.scaleToZeroWindowSeconds) } : {}),
    };
  }

  async deploy(request: DeployRequest, credentials: AdapterCredentials): Promise<EndpointRef> {
    const cfg = request.providerConfig;
    const headers = this.headers(credentials);
    const uri = request.version.registryUri;
    // Refuse a source Together cannot read before anything is created.
    if (!uri.startsWith('together://')) TogetherAdapter.remoteUrl(uri);
    try {
      const project = await this.project(cfg, credentials);
      const modelId = uri.startsWith('together://')
        ? uri.slice('together://'.length).split('@')[0]
        : (await this.upload(request.version, credentials, { ...cfg, projectId: project.id })).registryUri.slice('together://'.length);
      const config = await this.configRevision(project.id, modelId, cfg, headers);
      const name = TogetherAdapter.endpointName(request.deploymentId);
      const regions: string[] = request.desired.region ? [request.desired.region] : cfg.regions ?? [];

      const endpoint = await this.http.post(`${BASE_URL}/projects/${encodeURIComponent(project.id)}/endpoints`, { name }, { headers });
      const endpointId = endpoint.data?.id;
      const endpointName = endpoint.data?.name ?? (project.slug ? `${project.slug}/${name}` : name);

      const deployment = await this.http.post(
        `${BASE_URL}/projects/${encodeURIComponent(project.id)}/endpoints/${encodeURIComponent(endpointId)}/deployments`,
        {
          name,
          model: `projects/${project.id}/models/${modelId}`,
          config,
          autoscaling: this.autoscaling(request, cfg),
          ...(regions.length ? { placement: { inline: { regions, constraint: cfg.placementConstraint ?? 'ENFORCEMENT_PREFERRED' } } } : {}),
        },
        { headers },
      );
      const deploymentId = deployment.data?.id;

      // A READY deployment serves nothing until it holds weight in the endpoint's traffic split.
      await this.http.patch(
        `${BASE_URL}/projects/${encodeURIComponent(project.id)}/endpoints/${encodeURIComponent(endpointId)}`,
        { trafficSplit: [{ deploymentId, weight: 1 }], ...(endpoint.data?.etag ? { etag: endpoint.data.etag } : {}) },
        { headers, params: { updateMask: 'trafficSplit' } },
      );

      return {
        projectId: project.id,
        endpointId,
        deploymentId,
        // The endpoint string is what callers pass as `model` on an inference request.
        endpointName,
        modelId,
        hardware: deployment.data?.hardware,
        maxReplicas: this.autoscaling(request, cfg).maxReplicas,
        url: INFERENCE_URL,
        createdAt: new Date().toISOString(),
        hourlyRateCents: cfg.hourlyRateCents ?? 0,
      };
    } catch (err) {
      this.classify(err, 'create deployment failed');
    }
  }

  private deploymentUrl(ref: EndpointRef): string {
    return `${BASE_URL}/projects/${encodeURIComponent(ref.projectId)}/endpoints/${encodeURIComponent(ref.endpointId)}/deployments/${encodeURIComponent(ref.deploymentId)}`;
  }

  async readEndpoint(ref: EndpointRef, credentials: AdapterCredentials): Promise<ActualState> {
    try {
      const res = await this.http.get(this.deploymentUrl(ref), { headers: this.headers(credentials) });
      const d = res.data ?? {};
      const raw = String(d.status?.state ?? 'DEPLOYMENT_STATE_PROVISIONING');
      return {
        state: STATE_MAP[raw] ?? 'deploying',
        url: INFERENCE_URL,
        openAiBase: INFERENCE_URL,
        replicas: Number(d.status?.readyReplicas ?? 0),
        hardware: d.hardware ?? ref.hardware,
        message: d.status?.message,
        details: {
          rawState: raw,
          model: ref.endpointName,
          desiredReplicas: d.desiredReplicas,
          scheduledReplicas: d.status?.scheduledReplicas,
          minReplicas: d.autoscaling?.minReplicas,
          maxReplicas: d.autoscaling?.maxReplicas,
        },
      };
    } catch (err: any) {
      if (err?.response?.status === 404) return { state: 'missing', message: 'deployment not found' };
      this.classify(err, 'read deployment failed');
    }
  }

  /** Both bounds at zero stops the deployment; a positive count raises the floor and restarts it. */
  async scale(ref: EndpointRef, replicas: number, credentials: AdapterCredentials): Promise<void> {
    const headers = this.headers(credentials);
    try {
      await this.http.patch(
        this.deploymentUrl(ref),
        { autoscaling: { minReplicas: replicas, maxReplicas: replicas === 0 ? 0 : Math.max(replicas, Number(ref.maxReplicas ?? 1)) } },
        { headers, params: { updateMask: 'autoscaling' } },
      );
    } catch (err) {
      this.classify(err, 'scale failed');
    }
  }

  /** Clear the traffic split, stop the deployment, delete it, then the endpoint. The uploaded model stays. */
  async teardown(ref: EndpointRef, credentials: AdapterCredentials): Promise<void> {
    const headers = this.headers(credentials);
    const endpointUrl = `${BASE_URL}/projects/${encodeURIComponent(ref.projectId)}/endpoints/${encodeURIComponent(ref.endpointId)}`;
    const tolerate = (err: any) => {
      if (err?.response?.status === 404) return undefined;
      // A deployment still draining rejects the delete; the reconcile loop comes back.
      if (err?.response?.status === 400) return undefined;
      this.classify(err, 'delete failed');
    };
    await this.http.patch(endpointUrl, { trafficSplit: [] }, { headers, params: { updateMask: 'trafficSplit' } }).catch(tolerate);
    await this.scale(ref, 0, credentials).catch(tolerate);
    await this.http.delete(this.deploymentUrl(ref), { headers }).catch(tolerate);
    await this.http.delete(endpointUrl, { headers }).catch(tolerate);
  }

  /**
   * Together bills per minute per ready replica by hardware and publishes
   * no spend API (endpoint analytics reports requests, tokens and latency,
   * not dollars). Rate comes from the public instance-type catalog; spend
   * is that rate over observed uptime.
   */
  async costSnapshot(ref: EndpointRef, credentials: AdapterCredentials): Promise<CostSnapshot> {
    const headers = this.headers(credentials);
    const actual = await this.readEndpoint(ref, credentials);
    const hardware = actual.hardware ?? ref.hardware;
    let rate = Number(ref.hourlyRateCents ?? 0);
    try {
      const res = await this.http.get(INSTANCE_TYPES_URL, { headers });
      const match = (res.data?.data ?? []).find((h: any) => h?.id === hardware || h?.name === hardware);
      const cents = Number(match?.priceCentsPerHour);
      if (Number.isFinite(cents) && cents > 0) rate = cents;
    } catch {
      // Catalog unavailable: the configured rate stands.
    }
    const running = actual.state === 'ready' || actual.state === 'degraded' ? actual.replicas ?? 0 : 0;
    const hours = ref.createdAt ? Math.max(0, (Date.now() - new Date(ref.createdAt).getTime()) / 3_600_000) : 0;
    return { spentCents: Math.round(rate * hours), ratePerHourCents: rate * running, observedAt: new Date() };
  }
}
