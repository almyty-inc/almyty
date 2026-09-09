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
 * Google Vertex AI endpoints: dedicated replicas in the customer's own
 * GCP project.
 *
 * REST at https://{location}-aiplatform.googleapis.com/v1 with an OAuth2
 * bearer token, either supplied directly (`accessToken`) or minted from a
 * service-account key (`serviceAccountJson`) through the JWT bearer grant
 * at https://oauth2.googleapis.com/token. A deployment is three long
 * running operations: endpoints.create, models:upload (a vLLM container
 * whose args point at the S3 registry prefix through vLLM's Run:ai
 * streamer, with the registry keys as container env) and
 * endpoints:deployModel with dedicated resources. The first two are
 * awaited inside deploy; the third is tracked by readEndpoint. Scaling is
 * mutateDeployedModel on the replica range, or undeployModel for zero
 * (Vertex itself never scales dedicated resources below one replica).
 * Teardown undeploys, deletes the endpoint, then the model. Deltas:
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
const DEFAULT_IMAGE = 'vllm/vllm-openai:latest';
const CONTAINER_PORT = 8080;

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export class VertexAdapter implements ModelProviderAdapter {
  readonly key = 'vertex';
  readonly displayName = 'Google Vertex AI (endpoint)';

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
      registrySources: ['s3'],
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
        image: { type: 'string', title: 'Container image', default: DEFAULT_IMAGE },
        machineType: { type: 'string', title: 'Machine type', default: 'g2-standard-12' },
        acceleratorType: { type: 'string', title: 'Accelerator', default: 'NVIDIA_L4' },
        acceleratorCount: { type: 'integer', minimum: 0, default: 1 },
        dedicatedEndpoint: { type: 'boolean', title: 'Dedicated endpoint DNS', default: false },
        serviceAccount: { type: 'string', title: 'Runtime service account', description: 'Optional; the deployed container runs as it' },
        hourlyRateCents: { type: 'integer', title: 'Replica price per hour (cents)', description: 'Machine plus accelerator from the Vertex pricing page; used to estimate spend' },
        registryAccessKeyId: { type: 'string', title: 'Registry access key (S3 source)', 'x-secret': true },
        registrySecretAccessKey: { type: 'string', title: 'Registry secret key (S3 source)', 'x-secret': true },
        registryEndpoint: { type: 'string', title: 'Registry endpoint (S3 source)' },
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

  static chatUrl(ref: EndpointRef, dedicatedDns?: string): string {
    const host = dedicatedDns ? `https://${dedicatedDns}/v1` : VertexAdapter.base(ref.location);
    return `${host}/${ref.endpointName}/chat/completions`;
  }

  /** vLLM streams weights straight from the S3 prefix; the version @pin is the registry's, not S3's. */
  static s3Prefix(registryUri: string): string {
    if (!registryUri.startsWith('s3://')) throw new UnsupportedOperationError('vertex', `deploying from ${registryUri.split(':')[0]}:// (only the S3 registry source)`);
    return registryUri.replace(/@[^@/]+$/, '');
  }

  private deployedModelBody(ref: EndpointRef, min: number, max: number) {
    return {
      deployedModel: {
        model: ref.modelName,
        displayName: ref.endpointId,
        dedicatedResources: {
          machineSpec: {
            machineType: ref.machineType,
            ...(ref.acceleratorCount > 0 ? { acceleratorType: ref.acceleratorType, acceleratorCount: ref.acceleratorCount } : {}),
          },
          minReplicaCount: min,
          maxReplicaCount: max,
        },
        ...(ref.serviceAccount ? { serviceAccount: ref.serviceAccount } : {}),
        enableAccessLogging: false,
      },
      trafficSplit: { '0': 100 },
    };
  }

  async deploy(request: DeployRequest, credentials: AdapterCredentials): Promise<EndpointRef> {
    const cfg = request.providerConfig;
    const location = request.desired.region ?? cfg.location ?? 'us-central1';
    const parent = `projects/${cfg.projectId}/locations/${location}`;
    const endpointId = VertexAdapter.endpointId(request.deploymentId);
    const s3 = VertexAdapter.s3Prefix(request.version.registryUri);
    const replicas = Math.max(1, request.desired.replicas ?? 1);
    const min = Math.max(1, request.desired.minScale ?? replicas);
    const max = Math.max(min, request.desired.maxScale ?? replicas);

    const env = [
      { name: 'ALMYTY_REGISTRY_URI', value: request.version.registryUri },
      ...(credentials.registryAccessKeyId ? [{ name: 'AWS_ACCESS_KEY_ID', value: credentials.registryAccessKeyId }] : []),
      ...(credentials.registrySecretAccessKey ? [{ name: 'AWS_SECRET_ACCESS_KEY', value: credentials.registrySecretAccessKey }] : []),
      ...(cfg.registryEndpoint ? [{ name: 'AWS_ENDPOINT_URL', value: cfg.registryEndpoint }] : []),
    ];
    const model = {
      model: {
        displayName: endpointId,
        containerSpec: {
          imageUri: cfg.image ?? DEFAULT_IMAGE,
          args: ['--model', s3, '--load-format', 'runai_streamer', '--served-model-name', request.version.name, '--port', String(CONTAINER_PORT), ...(request.desired.quantization ? ['--quantization', request.desired.quantization] : [])],
          env,
          ports: [{ containerPort: CONTAINER_PORT }],
          predictRoute: '/v1/chat/completions',
          healthRoute: '/health',
        },
        labels: { 'almyty-deployment': request.deploymentId.replace(/[^a-z0-9_-]/gi, '').toLowerCase(), 'almyty-organization': request.organizationId.replace(/[^a-z0-9_-]/gi, '').toLowerCase() },
      },
    };

    const ref: EndpointRef = {
      project: cfg.projectId,
      location,
      endpointId,
      endpointName: `${parent}/endpoints/${endpointId}`,
      modelName: undefined,
      deployedModelId: undefined,
      deployOperation: undefined,
      machineType: request.desired.hardware ?? cfg.machineType ?? 'g2-standard-12',
      acceleratorType: cfg.acceleratorType ?? 'NVIDIA_L4',
      acceleratorCount: cfg.acceleratorCount ?? 1,
      serviceAccount: cfg.serviceAccount,
      minReplicas: min,
      maxReplicas: max,
      hourlyRateCents: cfg.hourlyRateCents ?? 0,
      createdAt: new Date().toISOString(),
    };

    try {
      const createOp = await this.call('POST', location, `${parent}/endpoints`, credentials, { displayName: endpointId, dedicatedEndpointEnabled: cfg.dedicatedEndpoint ?? false }, { endpointId });
      await this.waitOperation(location, createOp.name, credentials);

      const uploadOp = await this.call('POST', location, `${parent}/models:upload`, credentials, model);
      const uploaded = await this.waitOperation(location, uploadOp.name, credentials);
      ref.modelName = uploaded?.response?.model;
      if (!ref.modelName) throw Object.assign(new Error('models:upload finished without a model name'), { code: 'ADAPTER_ERROR' });

      const deployOp = await this.call('POST', location, `${ref.endpointName}:deployModel`, credentials, this.deployedModelBody(ref, min, max));
      ref.deployOperation = deployOp.name;
      ref.url = VertexAdapter.chatUrl(ref);
      return ref;
    } catch (err) {
      // Leave nothing half-made: the endpoint and model that got created are removed again.
      await this.call('DELETE', location, ref.endpointName, credentials).catch(() => undefined);
      if (ref.modelName) await this.call('DELETE', location, ref.modelName, credentials).catch(() => undefined);
      this.classify(err, 'deploy failed');
    }
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
      if (err?.response?.status === 404) return { state: 'missing', message: 'endpoint not found' };
      this.classify(err, 'read endpoint failed');
    }
    const url = VertexAdapter.chatUrl(ref, endpoint?.dedicatedEndpointDns);
    const deployed = this.findDeployed(endpoint, ref);
    if (deployed) {
      if (!ref.deployedModelId) ref.deployedModelId = deployed.id;
      const min = deployed.dedicatedResources?.minReplicaCount ?? ref.minReplicas;
      const scaling = ref.scaleOperation ? !(await this.call('GET', ref.location, ref.scaleOperation, credentials).catch(() => ({ done: true })))?.done : false;
      return {
        state: scaling ? 'scaling' : 'ready',
        url,
        replicas: Number(min ?? 1),
        hardware: deployed.dedicatedResources?.machineSpec?.machineType ?? ref.machineType,
        region: ref.location,
        details: { deployedModelId: deployed.id, maxReplicaCount: deployed.dedicatedResources?.maxReplicaCount, dedicatedEndpointDns: endpoint?.dedicatedEndpointDns },
      };
    }
    if (ref.deployOperation) {
      const op = await this.call('GET', ref.location, ref.deployOperation, credentials).catch((err) => this.classify(err, 'read deploy operation failed'));
      if (op?.done && op.error) return { state: 'failed', url, region: ref.location, message: op.error.message, details: { rpcCode: op.error.code } };
      if (op?.done && op.response?.deployedModel?.id && !ref.deployedModelId) ref.deployedModelId = op.response.deployedModel.id;
      return { state: 'deploying', url, region: ref.location, details: { operation: ref.deployOperation, done: Boolean(op?.done) } };
    }
    return { state: 'stopped', url, replicas: 0, region: ref.location, details: { note: 'model undeployed; endpoint kept' } };
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
