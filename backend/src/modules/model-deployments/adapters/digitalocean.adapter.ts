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
 * DigitalOcean Gradient AI Dedicated Inference. Verified shapes are in
 * docs/design/adapters/digitalocean.md.
 *
 * DigitalOcean runs the serving stack; we name a model. Control plane is
 * API v2 at https://api.digitalocean.com with an account bearer token:
 * POST /v2/dedicated-inferences creates one dedicated inference holding a
 * single model deployment, whose `model_slug` is a Hugging Face repository
 * (`model_provider: "hugging_face"`) or a model already imported into the
 * Model Catalog through BYOM. The 202 carries the endpoint FQDNs and a
 * first access token; chat is `<public_endpoint_fqdn>/v1/chat/completions`
 * with that token as the bearer.
 *
 * Scale is the accelerator node count, changed by PATCHing the spec back.
 * DigitalOcean bills the accelerators per GPU-hour whether or not they are
 * answering, so scaleToZero is false and only teardown stops the bill.
 *
 * There is no VM here, and no path by which weights travel through almyty:
 * DigitalOcean pulls from the Hub itself.
 */
const BASE_URL = 'https://api.digitalocean.com/v2';
const DEFAULT_REGION = 'atl1';
const DEFAULT_ACCELERATOR = 'gpu-mi300x1-192gb';
const DEFAULT_ACCELERATOR_TYPE = 'prefill_decode';

const STATUS_MAP: Record<string, ActualState['state']> = {
  new: 'deploying',
  provisioning: 'deploying',
  updating: 'scaling',
  active: 'ready',
  deleting: 'stopped',
  error: 'failed',
};

export class DigitalOceanAdapter implements ModelProviderAdapter {
  readonly key = 'digitalocean';
  readonly displayName = 'DigitalOcean Gradient AI (Dedicated Inference)';

  constructor(private readonly http: AxiosInstance = axios.create({ timeout: 30_000 })) {}

  capabilities(): AdapterCapabilities {
    return {
      architectures: 'any',
      lora: 'merged',
      serverless: false,
      dedicated: true,
      // A dedicated inference bills its accelerators per GPU-hour and the
      // reference states no minimum for `scale`; teardown is the only
      // move that reliably stops the bill.
      scaleToZero: false,
      regions: ['atl1', 'nyc2', 'tor1'],
      // DigitalOcean reads the Hub itself, or serves a model already in
      // its own catalog. It cannot read our object storage.
      registrySources: ['hub'],
      availability: 'public_preview',
      availabilityNote: 'Dedicated Inference is a DigitalOcean public preview: enable it from the Feature Preview page in your control panel first, and expect the API to change.',
    };
  }

  configSchema(): Record<string, any> {
    return {
      type: 'object',
      properties: {
        token: { type: 'string', title: 'DigitalOcean API token', description: 'Needs Gradient AI read and write scopes', 'x-secret': true },
        region: { type: 'string', title: 'Region', enum: ['atl1', 'nyc2', 'tor1'], default: DEFAULT_REGION },
        acceleratorSlug: { type: 'string', title: 'Accelerator', description: 'A dedicated inference GPU slug, e.g. gpu-mi300x1-192gb or gpu-h100x1-80gb', default: DEFAULT_ACCELERATOR },
        acceleratorType: { type: 'string', title: 'Accelerator role', default: DEFAULT_ACCELERATOR_TYPE },
        modelSlug: { type: 'string', title: 'Model', description: 'Overrides the version: a Hugging Face repo id, or a model imported into the Model Catalog through BYOM' },
        modelProvider: { type: 'string', title: 'Model provider', description: 'hugging_face for a Hub repo; the catalog provider for a BYOM import', default: 'hugging_face' },
        vpcUuid: { type: 'string', title: 'VPC' },
        enablePublicEndpoint: { type: 'boolean', title: 'Public endpoint', default: true },
        hourlyRateCents: { type: 'integer', title: 'Accelerator price per hour (cents)', description: 'DigitalOcean publishes a per GPU-hour price list but no usage API; used to estimate spend' },
        hfToken: { type: 'string', title: 'Hugging Face token (gated repositories)', 'x-secret': true },
      },
      required: ['token'],
    };
  }

  private headers(credentials: AdapterCredentials) {
    if (!credentials.token) throw Object.assign(new Error('missing DigitalOcean token'), { code: 'ADAPTER_AUTH', status: 401 });
    return { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' };
  }

  private classify(err: any, fallback: string): never {
    if (typeof err?.code === 'string' && err.code.startsWith('ADAPTER_')) throw err;
    const status = err?.response?.status;
    const body = err?.response?.data;
    const message = body?.message ?? err?.message ?? fallback;
    if (status === 401 || status === 403) {
      // Dedicated Inference is a public preview an account opts into. A
      // token that works everywhere else on the API still gets refused
      // here until then, so say which of the two it is rather than
      // sending the customer to check a key that is fine.
      if (status === 403 || /preview|not enabled|feature|opt[- ]?in|access/i.test(String(message))) {
        throw Object.assign(
          new Error(
            `DigitalOcean refused the request. Dedicated Inference is a public preview: enable it from the Feature Preview page in the DigitalOcean control panel, then try again. (${message})`,
          ),
          { code: 'ADAPTER_PREVIEW_NOT_ENABLED', status },
        );
      }
      throw Object.assign(new Error(`credential rejected: ${message}`), { code: 'ADAPTER_AUTH', status });
    }
    // Dedicated inference serves a documented set of architectures; a
    // model it cannot run is refused at create time.
    if (/architecture|unsupported model|model .*not supported|incompatible model/i.test(String(message))) {
      throw Object.assign(new Error(`unsupported model: ${message}`), { code: 'ADAPTER_UNSUPPORTED_ARCHITECTURE', status });
    }
    if (status === 429 || (status === 422 && /limit|quota|capacity|not available/i.test(String(message))) || /limit|quota|capacity/i.test(String(message))) {
      throw Object.assign(new Error(`quota: ${message}`), { code: 'ADAPTER_QUOTA_EXCEEDED', status });
    }
    if (status === 404) throw Object.assign(new Error(`not found: ${message}`), { code: 'ADAPTER_NOT_FOUND', status });
    throw Object.assign(new Error(message), { code: 'ADAPTER_ERROR', status });
  }

  static inferenceName(deploymentId: string): string {
    return `almyty-${deploymentId.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 20)}`;
  }

  /**
   * What DigitalOcean is told to serve. A hub version is its own slug; a
   * BYOM import is named by the operator because the import itself is
   * Control Panel only. Anything else is refused rather than mirrored.
   */
  static model(request: DeployRequest): { slug: string; provider: string } {
    const cfg = request.providerConfig ?? {};
    if (cfg.modelSlug) return { slug: String(cfg.modelSlug), provider: String(cfg.modelProvider ?? 'hugging_face') };
    const uri = request.version.registryUri;
    if (uri.startsWith('hf://')) return { slug: uri.slice('hf://'.length).split('@')[0], provider: String(cfg.modelProvider ?? 'hugging_face') };
    throw Object.assign(
      new Error(
        'DigitalOcean Dedicated Inference serves a Hugging Face repository or a model already in its Model Catalog; ' +
          'point the version at hf://org/repo, or import the weights once in the Control Panel and set providerConfig.modelSlug',
      ),
      { code: 'ADAPTER_UNSUPPORTED_SOURCE' },
    );
  }

  private static spec(request: DeployRequest, name: string, scale: number) {
    const cfg = request.providerConfig ?? {};
    const model = DigitalOceanAdapter.model(request);
    return {
      version: 1,
      name,
      region: request.desired.region ?? cfg.region ?? DEFAULT_REGION,
      ...(cfg.vpcUuid ? { vpc: { uuid: cfg.vpcUuid } } : {}),
      enable_public_endpoint: cfg.enablePublicEndpoint ?? true,
      model_deployments: [
        {
          model_slug: model.slug,
          model_provider: model.provider,
          workload_config: {},
          accelerators: [{ scale, type: cfg.acceleratorType ?? DEFAULT_ACCELERATOR_TYPE, accelerator_slug: request.desired.hardware ?? cfg.acceleratorSlug ?? DEFAULT_ACCELERATOR }],
        },
      ],
    };
  }

  private static fqdn(inference: any): string | undefined {
    const endpoints = inference?.endpoints ?? {};
    const fqdn = endpoints.public_endpoint_fqdn ?? endpoints.private_endpoint_fqdn;
    return fqdn ? String(fqdn).replace(/\/+$/, '') : undefined;
  }

  private static totalScale(inference: any): number {
    const deployments = inference?.spec?.model_deployments ?? [];
    return deployments.reduce((sum: number, d: any) => sum + (d.accelerators ?? []).reduce((s: number, a: any) => s + Number(a.scale ?? 0), 0), 0);
  }

  async deploy(request: DeployRequest, credentials: AdapterCredentials): Promise<EndpointRef> {
    const cfg = request.providerConfig ?? {};
    const name = DigitalOceanAdapter.inferenceName(request.deploymentId);
    const scale = Math.max(1, request.desired.replicas ?? request.desired.minScale ?? 1);
    const spec = DigitalOceanAdapter.spec(request, name, scale);
    const body = {
      spec,
      ...(credentials.hfToken ? { access_tokens: { hugging_face_token: credentials.hfToken } } : {}),
    };
    try {
      const res = await this.http.post(`${BASE_URL}/dedicated-inferences`, body, { headers: this.headers(credentials) });
      const inference = res.data?.dedicated_inference;
      const fqdn = DigitalOceanAdapter.fqdn(inference);
      return {
        dedicatedInferenceId: inference?.id,
        name,
        region: inference?.spec?.region ?? spec.region,
        acceleratorSlug: spec.model_deployments[0].accelerators[0].accelerator_slug,
        modelSlug: spec.model_deployments[0].model_slug,
        scale,
        url: fqdn ? `${fqdn}/v1` : undefined,
        // The deployment's own access token, minted by DigitalOcean with
        // the endpoint. The gateway needs it to call the endpoint; it is
        // the only secret on this handle and the caller stores it sealed.
        endpointToken: res.data?.token?.value,
        endpointTokenId: res.data?.token?.id,
        createdAt: new Date().toISOString(),
        hourlyRateCents: cfg.hourlyRateCents ?? 0,
      };
    } catch (err) {
      this.classify(err, 'create dedicated inference failed');
    }
  }

  async readEndpoint(ref: EndpointRef, credentials: AdapterCredentials): Promise<ActualState> {
    let inference: any;
    try {
      inference = (await this.http.get(`${BASE_URL}/dedicated-inferences/${encodeURIComponent(ref.dedicatedInferenceId)}`, { headers: this.headers(credentials) })).data?.dedicated_inference;
    } catch (err: any) {
      if (err?.response?.status === 404) return { state: 'missing', message: 'dedicated inference not found' };
      this.classify(err, 'read dedicated inference failed');
    }
    if (!inference) return { state: 'missing', message: 'dedicated inference not found' };
    const raw = String(inference.status ?? 'new');
    const scale = DigitalOceanAdapter.totalScale(inference);
    const fqdn = DigitalOceanAdapter.fqdn(inference);
    let state = STATUS_MAP[raw] ?? 'deploying';
    let message: string | undefined;
    if (state === 'ready' && scale === 0) {
      state = 'stopped';
      message = 'no accelerators scheduled';
    } else if (state === 'ready' && !fqdn) {
      state = 'deploying';
      message = 'waiting for an endpoint address';
    }
    const deployment = inference.spec?.model_deployments?.[0];
    return {
      state,
      url: fqdn ? `${fqdn}/v1` : undefined,
      openAiBase: fqdn ? `${fqdn}/v1` : undefined,
      replicas: scale,
      hardware: deployment?.accelerators?.[0]?.accelerator_slug,
      region: inference.spec?.region,
      message,
      details: { rawStatus: raw, modelSlug: deployment?.model_slug, modelProvider: deployment?.model_provider },
    };
  }

  async scale(ref: EndpointRef, replicas: number, credentials: AdapterCredentials): Promise<void> {
    const headers = this.headers(credentials);
    const path = `${BASE_URL}/dedicated-inferences/${encodeURIComponent(ref.dedicatedInferenceId)}`;
    try {
      // DigitalOcean takes the whole spec back on a PATCH, so the current
      // one is read first and only the accelerator count is moved.
      const current = (await this.http.get(path, { headers })).data?.dedicated_inference;
      const spec = current?.spec;
      if (!spec) throw Object.assign(new Error('dedicated inference has no spec to patch'), { code: 'ADAPTER_ERROR' });
      for (const deployment of spec.model_deployments ?? []) {
        for (const accelerator of deployment.accelerators ?? []) accelerator.scale = replicas;
      }
      await this.http.patch(path, { spec }, { headers });
    } catch (err) {
      this.classify(err, 'scale failed');
    }
  }

  async teardown(ref: EndpointRef, credentials: AdapterCredentials): Promise<void> {
    try {
      await this.http.delete(`${BASE_URL}/dedicated-inferences/${encodeURIComponent(ref.dedicatedInferenceId)}`, { headers: this.headers(credentials) });
    } catch (err: any) {
      if (err?.response?.status === 404) return;
      this.classify(err, 'delete failed');
    }
  }

  /**
   * Dedicated Inference is billed per GPU-hour and publishes no usage API,
   * so this is the configured accelerator rate times the accelerators that
   * exist. Spend is estimated against the scale the deployment was created
   * with, which keeps it from moving backwards when the endpoint shrinks.
   */
  async costSnapshot(ref: EndpointRef, credentials: AdapterCredentials): Promise<CostSnapshot> {
    const actual = await this.readEndpoint(ref, credentials);
    const rate = Number(ref.hourlyRateCents ?? 0);
    const live = actual.state === 'missing' ? 0 : Number(actual.replicas ?? 0);
    const hours = ref.createdAt ? Math.max(0, (Date.now() - new Date(ref.createdAt).getTime()) / 3_600_000) : 0;
    return {
      spentCents: Math.round(rate * Number(ref.scale ?? live) * hours),
      ratePerHourCents: rate * live,
      observedAt: new Date(),
    };
  }
}
