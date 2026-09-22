import axios from 'axios';
import { createSign } from 'crypto';

import {
  ActualState,
  AdapterCapabilities,
  AdapterCredentials,
  CostSnapshot,
  DeployRequest,
  EndpointRef,
  ModelProviderAdapter,
  UnsupportedOperationError,
} from './adapter.interface';

/**
 * Google Vertex AI, in the customer's own GCP project.
 *
 * REST at https://{location}-aiplatform.googleapis.com/v1 with an OAuth2
 * bearer token, either supplied directly (`accessToken`) or minted from a
 * service-account key (`serviceAccountJson`) through the JWT bearer grant
 * at https://oauth2.googleapis.com/token.
 *
 * Two native paths, chosen from the version's registry URI:
 *
 *   vertex://publishers/{publisher}/models/{model}@{version}
 *   hf://{owner}/{repo}[@revision]
 *     Model Garden deploys it for us: one call to
 *     POST {parent}:deploy with `publisherModelName` or
 *     `huggingFaceModelId`. Google picks the container and, unless the
 *     operator names a machine type, the machine spec too. Nothing about
 *     the weights passes through almyty: for a Hugging Face model Vertex
 *     pulls the repository itself, with `modelConfig.huggingFaceAccessToken`
 *     for a gated one.
 *
 *   gs://bucket/prefix
 *     The customer's own weights in Cloud Storage, which is the only
 *     artifact store Vertex reads: models:upload takes `artifactUri` as a
 *     Cloud Storage directory and Vertex copies it to a bucket of its own,
 *     handing the serving container an AIP_STORAGE_URI that also begins
 *     with gs://.
 *
 * Both paths end at a Vertex endpoint. Scaling is mutateDeployedModel on
 * the replica range, or undeployModel for zero, because v1 dedicated
 * resources may not go below one replica. Teardown undeploys, deletes the
 * endpoint, then the model. Deltas and verified facts:
 * docs/design/adapters/vertex.md.
 */
export interface VertexHttp {
  request(config: { method: string; url: string; headers: Record<string, string>; data?: any; params?: Record<string, string> }): Promise<{ status: number; data: any }>;
}

const REGIONS = [
  'us-central1', 'us-east1', 'us-east4', 'us-west1', 'us-west4', 'northamerica-northeast1',
  'europe-west1', 'europe-west2', 'europe-west3', 'europe-west4', 'europe-west9',
  'asia-east1', 'asia-northeast1', 'asia-northeast3', 'asia-southeast1', 'asia-south1', 'australia-southeast1',
];
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
/**
 * Google's own Model Garden vLLM serving container. Vertex only accepts
 * images from Artifact Registry or Container Registry, so a Docker Hub
 * image is not an option here; the dated tag moves, and `image` overrides it.
 */
const DEFAULT_IMAGE = 'us-docker.pkg.dev/vertex-ai/vertex-vision-model-garden-dockers/pytorch-vllm-serve:20241001_0916_RC00';
const CONTAINER_PORT = 8080;

const ACCEPTED_SOURCES = 'a Model Garden model (vertex://publishers/{publisher}/models/{model}@{version}), a Hugging Face repository (hf://) that Model Garden deploys for you, or your own weights in Cloud Storage (gs://)';

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export class VertexAdapter implements ModelProviderAdapter {
  readonly key = 'vertex';
  readonly displayName = 'Google Vertex AI';

  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    private readonly http: VertexHttp = axios.create({ timeout: 30_000 }),
    private readonly options: { pollIntervalMs?: number; operationTimeoutMs?: number } = {},
  ) {}

  capabilities(): AdapterCapabilities {
    return {
      architectures: 'any',
      lora: 'merged',
      serverless: false,
      dedicated: true,
      scaleToZero: false,
      regions: REGIONS,
      // Cloud Storage is the artifact store Vertex reads, and Model
      // Garden pulls a Hugging Face repository itself. Vertex cannot read
      // S3 from anywhere in either path.
      registrySources: ['gcs', 'hub'],
    };
  }

  configSchema(): Record<string, any> {
    return {
      type: 'object',
      properties: {
        serviceAccountJson: { type: 'string', title: 'Service account key (JSON)', description: 'Needs roles/aiplatform.user on the project', 'x-secret': true },
        accessToken: { type: 'string', title: 'OAuth2 access token', description: 'Alternative to a service account key; short lived', 'x-secret': true },
        projectId: { type: 'string', title: 'Project id' },
        location: { type: 'string', title: 'Location', enum: REGIONS, default: 'us-central1' },
        image: { type: 'string', title: 'Container image', description: `Cloud Storage source only; must live in Artifact Registry or Container Registry. Defaults to Google's Model Garden vLLM container (${DEFAULT_IMAGE})`, default: DEFAULT_IMAGE },
        predictRoute: { type: 'string', title: 'Container predict route', default: '/v1/chat/completions' },
        healthRoute: { type: 'string', title: 'Container health route', default: '/health' },
        machineType: { type: 'string', title: 'Machine type', description: 'Model Garden picks one for you when this is empty' },
        acceleratorType: { type: 'string', title: 'Accelerator', default: 'NVIDIA_L4' },
        acceleratorCount: { type: 'integer', minimum: 0, default: 1 },
        dedicatedEndpoint: { type: 'boolean', title: 'Dedicated endpoint DNS', default: false },
        serviceAccount: { type: 'string', title: 'Runtime service account', description: 'Optional; the deployed container runs as it' },
        acceptEula: { type: 'boolean', title: 'Accept the model licence', description: 'Model Garden and Hugging Face models whose licence requires acceptance', default: false },
        huggingFaceToken: { type: 'string', title: 'Hugging Face read token', description: 'Model Garden uses it to pull a gated repository', 'x-secret': true },
        hourlyRateCents: { type: 'integer', title: 'Replica price per hour (cents)', description: 'Machine plus accelerator from the Vertex pricing page; used to estimate spend' },
      },
      required: ['projectId'],
    };
  }

  private async token(credentials: AdapterCredentials): Promise<string> {
    if (credentials.accessToken) return credentials.accessToken;
    if (!credentials.serviceAccountJson) throw Object.assign(new Error('missing Vertex credential: accessToken or serviceAccountJson'), { code: 'ADAPTER_AUTH', status: 401 });
    let key: { client_email?: string; private_key?: string };
    try {
      key = JSON.parse(credentials.serviceAccountJson);
    } catch {
      throw Object.assign(new Error('serviceAccountJson is not valid JSON'), { code: 'ADAPTER_AUTH', status: 401 });
    }
    if (!key.client_email || !key.private_key) throw Object.assign(new Error('serviceAccountJson lacks client_email or private_key'), { code: 'ADAPTER_AUTH', status: 401 });

    const cached = this.tokens.get(key.client_email);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
    const signature = b64url(createSign('RSA-SHA256').update(`${header}.${claims}`).sign(key.private_key));
    const assertion = `${header}.${claims}.${signature}`;
    try {
      const res = await this.http.request({
        method: 'POST',
        url: TOKEN_URL,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      });
      const token = res.data?.access_token;
      if (!token) throw new Error('token endpoint returned no access_token');
      this.tokens.set(key.client_email, { token, expiresAt: Date.now() + Number(res.data?.expires_in ?? 3600) * 1000 });
      return token;
    } catch (err: any) {
      const detail = err?.response?.data?.error_description ?? err?.response?.data?.error ?? err?.message;
      throw Object.assign(new Error(`service account rejected: ${detail}`), { code: 'ADAPTER_AUTH', status: err?.response?.status ?? 401 });
    }
  }

  private classify(err: any, fallback: string): never {
    if (err?.code === 'ADAPTER_AUTH' || err?.code === 'ADAPTER_QUOTA_EXCEEDED' || err?.code === 'ADAPTER_NOT_FOUND') throw err;
    const status: number | undefined = err?.response?.status;
    const body = err?.response?.data?.error ?? err?.response?.data;
    const rpc = String(body?.status ?? '');
    const message = body?.message ?? err?.message ?? fallback;
    if (status === 401 || status === 403 || /UNAUTHENTICATED|PERMISSION_DENIED/.test(rpc)) throw Object.assign(new Error(`credential rejected: ${message}`), { code: 'ADAPTER_AUTH', status });
    if (status === 429 || /RESOURCE_EXHAUSTED/.test(rpc) || /quota/i.test(String(message))) throw Object.assign(new Error(`quota: ${message}`), { code: 'ADAPTER_QUOTA_EXCEEDED', status });
    if (status === 404 || /NOT_FOUND/.test(rpc)) throw Object.assign(new Error(`not found: ${message}`), { code: 'ADAPTER_NOT_FOUND', status });
    throw Object.assign(new Error(message), { code: 'ADAPTER_ERROR', status });
  }

  static base(location: string): string {
    return `https://${location}-aiplatform.googleapis.com/v1`;
  }

  private async call(method: string, location: string, path: string, credentials: AdapterCredentials, data?: any, params?: Record<string, string>): Promise<any> {
    const token = await this.token(credentials);
    const res = await this.http.request({ method, url: `${VertexAdapter.base(location)}/${path}`, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, data, params });
    return res.data;
  }

  private async waitOperation(location: string, name: string, credentials: AdapterCredentials): Promise<any> {
    const started = Date.now();
    const timeout = this.options.operationTimeoutMs ?? 10 * 60_000;
    for (;;) {
      const op = await this.call('GET', location, name, credentials);
      if (op?.done) {
        if (op.error) throw Object.assign(new Error(`operation failed: ${op.error.message ?? op.error.code}`), { response: { status: op.error.code === 8 ? 429 : 500, data: { error: { status: op.error.code === 8 ? 'RESOURCE_EXHAUSTED' : 'INTERNAL', message: op.error.message } } } });
        return op;
      }
      if (Date.now() - started > timeout) throw Object.assign(new Error(`timed out waiting for ${name}`), { code: 'ADAPTER_ERROR' });
      await new Promise((r) => setTimeout(r, this.options.pollIntervalMs ?? 3000));
    }
  }

  static endpointId(deploymentId: string): string {
    return `almyty-${deploymentId.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 40)}`;
  }

  /** The dedicated DNS is documented with its scheme already on it, so strip one if it is there. */
  static host(location: string, dedicatedDns?: string): string {
    if (!dedicatedDns) return VertexAdapter.base(location);
    return `https://${dedicatedDns.replace(/^https?:\/\//, '').replace(/\/+$/, '')}/v1`;
  }

  /** The OpenAI-compatible base: chat goes to `<openAiBase>/chat/completions`. */
  static openAiBase(ref: EndpointRef, dedicatedDns?: string): string {
    return `${VertexAdapter.host(ref.location, dedicatedDns)}/${ref.endpointName}`;
  }

  static chatUrl(ref: EndpointRef, dedicatedDns?: string): string {
    return `${VertexAdapter.openAiBase(ref, dedicatedDns)}/chat/completions`;
  }

  /** Which of the two Vertex paths this version asks for. */
  static route(registryUri: string): 'garden' | 'gcs' {
    if (registryUri.startsWith('vertex://') || registryUri.startsWith('hf://')) return 'garden';
    if (registryUri.startsWith('gs://')) return 'gcs';
    throw new UnsupportedOperationError('vertex', `a ${registryUri.split(':')[0]}:// version. Vertex deploys ${ACCEPTED_SOURCES}`);
  }

  /** The Cloud Storage directory holding the weights; the @pin is the version's, not GCS's. */
  static gcsUri(registryUri: string): string {
    return registryUri.replace(/@[^@/]+$/, '');
  }

  /** `publisherModelName` from a vertex:// version, in either of the two shapes Model Garden accepts. */
  static publisherModelName(registryUri: string): string {
    const rest = registryUri.slice('vertex://'.length);
    const [ref, version] = rest.split('@');
    const name = ref.startsWith('publishers/') ? ref : `publishers/${ref.replace(/^\/+/, '')}`;
    if (!/^publishers\/[^/]+\/models\/[^/]+$/.test(name)) {
      throw new UnsupportedOperationError('vertex', `the Model Garden reference "${rest}". Use vertex://publishers/{publisher}/models/{model}@{version}`);
    }
    return version ? `${name}@${version}` : name;
  }

  private machineSpec(ref: EndpointRef) {
    return {
      machineType: ref.machineType,
      ...(Number(ref.acceleratorCount ?? 0) > 0 ? { acceleratorType: ref.acceleratorType, acceleratorCount: ref.acceleratorCount } : {}),
    };
  }

  private deployedModelBody(ref: EndpointRef, min: number, max: number) {
    if (!ref.machineType) {
      throw Object.assign(new Error('cannot redeploy without a machine type: set machineType on the deployment, or read the endpoint once while the model is still deployed'), { code: 'ADAPTER_CONFIG_INVALID' });
    }
    return {
      deployedModel: {
        model: ref.modelName,
        displayName: ref.endpointId,
        dedicatedResources: { machineSpec: this.machineSpec(ref), minReplicaCount: min, maxReplicaCount: max },
        ...(ref.serviceAccount ? { serviceAccount: ref.serviceAccount } : {}),
        enableAccessLogging: false,
      },
      trafficSplit: { '0': 100 },
    };
  }

  async deploy(request: DeployRequest, credentials: AdapterCredentials): Promise<EndpointRef> {
    const route = VertexAdapter.route(request.version.registryUri);
    const cfg = request.providerConfig;
    const location = request.desired.region ?? cfg.location ?? 'us-central1';
    const endpointId = VertexAdapter.endpointId(request.deploymentId);
    const replicas = Math.max(1, request.desired.replicas ?? 1);
    const min = Math.max(1, request.desired.minScale ?? replicas);
    const max = Math.max(min, request.desired.maxScale ?? replicas);

    const ref: EndpointRef = {
      route,
      project: cfg.projectId,
      location,
      endpointId,
      endpointName: `projects/${cfg.projectId}/locations/${location}/endpoints/${endpointId}`,
      modelName: undefined,
      deployedModelId: undefined,
      deployOperation: undefined,
      machineType: request.desired.hardware ?? cfg.machineType,
      acceleratorType: cfg.acceleratorType ?? 'NVIDIA_L4',
      acceleratorCount: cfg.acceleratorCount ?? 1,
      serviceAccount: cfg.serviceAccount,
      minReplicas: min,
      maxReplicas: max,
      hourlyRateCents: cfg.hourlyRateCents ?? 0,
      createdAt: new Date().toISOString(),
    };
    ref.url = VertexAdapter.chatUrl(ref);

    return route === 'garden'
      ? this.deployFromModelGarden(request, credentials, ref, min, max)
      : this.deployFromCloudStorage(request, credentials, ref, min, max);
  }

  /**
   * One call: Model Garden uploads the model, creates the endpoint and
   * deploys, and reports progress on a single operation that readEndpoint
   * tracks. `endpointUserId` and `modelUserId` pin the resource names so
   * the handle is complete before the operation finishes.
   */
  private async deployFromModelGarden(request: DeployRequest, credentials: AdapterCredentials, ref: EndpointRef, min: number, max: number): Promise<EndpointRef> {
    const cfg = request.providerConfig;
    const uri = request.version.registryUri;
    const fromHub = uri.startsWith('hf://');
    const modelUserId = `${ref.endpointId}-model`;
    ref.modelName = `projects/${cfg.projectId}/locations/${ref.location}/models/${modelUserId}`;

    const body: Record<string, any> = {
      ...(fromHub
        ? { huggingFaceModelId: uri.slice('hf://'.length).split('@')[0] }
        : { publisherModelName: VertexAdapter.publisherModelName(uri) }),
      modelConfig: {
        modelUserId,
        modelDisplayName: ref.endpointId,
        acceptEula: Boolean(cfg.acceptEula),
        ...(credentials.huggingFaceToken ? { huggingFaceAccessToken: credentials.huggingFaceToken } : {}),
      },
      endpointConfig: {
        endpointUserId: ref.endpointId,
        endpointDisplayName: ref.endpointId,
        dedicatedEndpointEnabled: cfg.dedicatedEndpoint ?? false,
        labels: VertexAdapter.labels(request),
      },
      // Without a machine type, Model Garden uses the machine spec Google
      // recommends for this model rather than one we invented.
      ...(ref.machineType ? { deployConfig: { dedicatedResources: { machineSpec: this.machineSpec(ref), minReplicaCount: min, maxReplicaCount: max } } } : {}),
    };

    try {
      const op = await this.call('POST', ref.location, `projects/${cfg.projectId}/locations/${ref.location}:deploy`, credentials, body);
      ref.deployOperation = op.name;
      return ref;
    } catch (err) {
      this.classify(err, 'model garden deploy failed');
    }
  }

  /** The customer's own weights: Vertex reads the Cloud Storage directory itself. */
  private async deployFromCloudStorage(request: DeployRequest, credentials: AdapterCredentials, ref: EndpointRef, min: number, max: number): Promise<EndpointRef> {
    const cfg = request.providerConfig;
    const parent = `projects/${cfg.projectId}/locations/${ref.location}`;
    const artifactUri = VertexAdapter.gcsUri(request.version.registryUri);
    ref.machineType = ref.machineType ?? 'g2-standard-12';

    const model = {
      model: {
        displayName: ref.endpointId,
        artifactUri,
        containerSpec: {
          imageUri: cfg.image ?? DEFAULT_IMAGE,
          args: [
            `--model=${artifactUri}`,
            `--served-model-name=${request.version.name}`,
            `--port=${CONTAINER_PORT}`,
            ...(request.desired.quantization ? [`--quantization=${request.desired.quantization}`] : []),
          ],
          env: [
            { name: 'MODEL_ID', value: artifactUri },
            { name: 'DEPLOY_SOURCE', value: 'almyty' },
          ],
          ports: [{ containerPort: CONTAINER_PORT }],
          predictRoute: cfg.predictRoute ?? '/v1/chat/completions',
          healthRoute: cfg.healthRoute ?? '/health',
        },
        labels: VertexAdapter.labels(request),
      },
    };

    try {
      const createOp = await this.call('POST', ref.location, `${parent}/endpoints`, credentials, { displayName: ref.endpointId, dedicatedEndpointEnabled: cfg.dedicatedEndpoint ?? false }, { endpointId: ref.endpointId });
      await this.waitOperation(ref.location, createOp.name, credentials);

      const uploadOp = await this.call('POST', ref.location, `${parent}/models:upload`, credentials, model);
      const uploaded = await this.waitOperation(ref.location, uploadOp.name, credentials);
      ref.modelName = uploaded?.response?.model;
      if (!ref.modelName) throw Object.assign(new Error('models:upload finished without a model name'), { code: 'ADAPTER_ERROR' });

      const deployOp = await this.call('POST', ref.location, `${ref.endpointName}:deployModel`, credentials, this.deployedModelBody(ref, min, max));
      ref.deployOperation = deployOp.name;
      return ref;
    } catch (err) {
      // Leave nothing half-made: the endpoint and model that got created are removed again.
      await this.call('DELETE', ref.location, ref.endpointName, credentials).catch(() => undefined);
      if (ref.modelName) await this.call('DELETE', ref.location, ref.modelName, credentials).catch(() => undefined);
      this.classify(err, 'deploy failed');
    }
  }

  static labels(request: DeployRequest): Record<string, string> {
    return {
      'almyty-deployment': request.deploymentId.replace(/[^a-z0-9_-]/gi, '').toLowerCase(),
      'almyty-organization': request.organizationId.replace(/[^a-z0-9_-]/gi, '').toLowerCase(),
    };
  }

  private findDeployed(endpoint: any, ref: EndpointRef): any | undefined {
    const models: any[] = endpoint?.deployedModels ?? [];
    return models.find((d) => d.id === ref.deployedModelId) ?? models.find((d) => String(d.model ?? '').split('@')[0] === ref.modelName);
  }

  async readEndpoint(ref: EndpointRef, credentials: AdapterCredentials): Promise<ActualState> {
    let endpoint: any;
    try {
      endpoint = await this.call('GET', ref.location, ref.endpointName, credentials);
    } catch (err: any) {
      if (err?.response?.status === 404) {
        // Model Garden creates the endpoint part-way through its own
        // operation, so a 404 before that operation has ever produced an
        // endpoint is progress, not an orphan. Once the endpoint has been
        // seen, a 404 means it really is gone.
        if (ref.route === 'garden' && ref.deployOperation && !ref.seenEndpoint) {
          const op = await this.call('GET', ref.location, ref.deployOperation, credentials).catch(() => undefined);
          if (op?.done && op.error) return { state: 'failed', region: ref.location, message: op.error.message, details: { rpcCode: op.error.code } };
          return { state: 'deploying', region: ref.location, details: { route: ref.route, operation: ref.deployOperation, done: Boolean(op?.done) } };
        }
        return { state: 'missing', message: 'endpoint not found' };
      }
      this.classify(err, 'read endpoint failed');
    }
    ref.seenEndpoint = true;
    const url = VertexAdapter.chatUrl(ref, endpoint?.dedicatedEndpointDns);
    const openAiBase = VertexAdapter.openAiBase(ref, endpoint?.dedicatedEndpointDns);
    const deployed = this.findDeployed(endpoint, ref);
    if (deployed) {
      if (!ref.deployedModelId) ref.deployedModelId = deployed.id;
      // Model Garden may have chosen the machine spec; remember it so a
      // redeploy after scale-to-zero asks for the same hardware.
      const spec = deployed.dedicatedResources?.machineSpec;
      if (spec?.machineType) {
        ref.machineType = spec.machineType;
        ref.acceleratorType = spec.acceleratorType ?? ref.acceleratorType;
        ref.acceleratorCount = spec.acceleratorCount ?? (spec.acceleratorType ? ref.acceleratorCount : 0);
      }
      const min = deployed.dedicatedResources?.minReplicaCount ?? ref.minReplicas;
      const scaling = ref.scaleOperation ? !(await this.call('GET', ref.location, ref.scaleOperation, credentials).catch(() => ({ done: true })))?.done : false;
      return {
        state: scaling ? 'scaling' : 'ready',
        url,
        openAiBase,
        replicas: Number(deployed.status?.availableReplicaCount ?? min ?? 1),
        hardware: spec?.machineType ?? ref.machineType,
        region: ref.location,
        details: { route: ref.route, deployedModelId: deployed.id, maxReplicaCount: deployed.dedicatedResources?.maxReplicaCount, dedicatedEndpointDns: endpoint?.dedicatedEndpointDns },
      };
    }
    if (ref.deployOperation) {
      const op = await this.call('GET', ref.location, ref.deployOperation, credentials).catch((err) => this.classify(err, 'read deploy operation failed'));
      if (op?.done && op.error) return { state: 'failed', url, region: ref.location, message: op.error.message, details: { rpcCode: op.error.code } };
      if (op?.done) {
        if (op.response?.deployedModel?.id && !ref.deployedModelId) ref.deployedModelId = op.response.deployedModel.id;
        if (op.response?.model && !ref.modelName) ref.modelName = op.response.model;
      }
      return { state: 'deploying', url, region: ref.location, details: { route: ref.route, operation: ref.deployOperation, done: Boolean(op?.done) } };
    }
    return { state: 'stopped', url, openAiBase, replicas: 0, region: ref.location, details: { route: ref.route, note: 'model undeployed; endpoint kept' } };
  }

  async scale(ref: EndpointRef, replicas: number, credentials: AdapterCredentials): Promise<void> {
    try {
      if (replicas === 0) {
        if (!ref.deployedModelId) {
          const endpoint = await this.call('GET', ref.location, ref.endpointName, credentials);
          ref.deployedModelId = this.findDeployed(endpoint, ref)?.id;
        }
        if (ref.deployedModelId) {
          const op = await this.call('POST', ref.location, `${ref.endpointName}:undeployModel`, credentials, { deployedModelId: ref.deployedModelId });
          await this.waitOperation(ref.location, op.name, credentials);
        }
        ref.deployedModelId = undefined;
        ref.deployOperation = undefined;
        ref.scaleOperation = undefined;
        return;
      }
      const max = Math.max(replicas, Number(ref.maxReplicas ?? replicas));
      ref.minReplicas = replicas;
      ref.maxReplicas = max;
      if (ref.deployedModelId) {
        const op = await this.call('PATCH', ref.location, `${ref.endpointName}:mutateDeployedModel`, credentials, {
          deployedModel: { id: ref.deployedModelId, dedicatedResources: { minReplicaCount: replicas, maxReplicaCount: max } },
          updateMask: 'dedicatedResources.minReplicaCount,dedicatedResources.maxReplicaCount',
        });
        ref.scaleOperation = op.name;
        return;
      }
      const op = await this.call('POST', ref.location, `${ref.endpointName}:deployModel`, credentials, this.deployedModelBody(ref, replicas, max));
      ref.deployOperation = op.name;
    } catch (err) {
      this.classify(err, 'scale failed');
    }
  }

  async teardown(ref: EndpointRef, credentials: AdapterCredentials): Promise<void> {
    try {
      let endpoint: any;
      try {
        endpoint = await this.call('GET', ref.location, ref.endpointName, credentials);
      } catch (err: any) {
        if (err?.response?.status !== 404) throw err;
      }
      // Vertex refuses to delete an endpoint that still has a deployed model.
      const deployed = endpoint ? this.findDeployed(endpoint, ref) : undefined;
      if (deployed) {
        const op = await this.call('POST', ref.location, `${ref.endpointName}:undeployModel`, credentials, { deployedModelId: deployed.id });
        await this.waitOperation(ref.location, op.name, credentials);
      }
      if (endpoint) {
        const op = await this.call('DELETE', ref.location, ref.endpointName, credentials);
        if (op?.name) await this.waitOperation(ref.location, op.name, credentials).catch(() => undefined);
      }
      if (ref.modelName) {
        await this.call('DELETE', ref.location, ref.modelName, credentials).catch((err) => {
          if (err?.response?.status !== 404) throw err;
        });
      }
    } catch (err) {
      this.classify(err, 'teardown failed');
    }
  }

  /** Vertex has no per-endpoint billing API: replica rate times observed replicas and time. */
  async costSnapshot(ref: EndpointRef, credentials: AdapterCredentials): Promise<CostSnapshot> {
    const actual = await this.readEndpoint(ref, credentials);
    const rate = Number(ref.hourlyRateCents ?? 0);
    const hours = ref.createdAt ? Math.max(0, (Date.now() - new Date(ref.createdAt).getTime()) / 3_600_000) : 0;
    const running = actual.state === 'ready' || actual.state === 'scaling' ? actual.replicas ?? Number(ref.minReplicas ?? 1) : 0;
    return {
      spentCents: Math.round(rate * hours * Number(ref.minReplicas ?? 1)),
      ratePerHourCents: rate * running,
      observedAt: new Date(),
    };
  }
}
