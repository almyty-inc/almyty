import { createHash, createSign } from 'crypto';

import axios, { AxiosInstance } from 'axios';

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
 * Nebius AI Cloud compute VM running vLLM. Verified shapes and the reason
 * this is the compute path rather than Token Factory dedicated endpoints
 * are in docs/design/adapters/nebius.md (short version: Token Factory's
 * custom weights are a beta enabled by support with no upload API, so an
 * S3 registry version cannot reach it today).
 *
 * REST gateway at https://api.eu.nebius.cloud (gRPC-transcoded): a boot
 * disk from a CUDA image family, then an instance with the GPU platform
 * and preset, a public address and cloud-init that pulls the registry
 * version and runs vLLM on port 8000. Create, start, stop and delete
 * return Operations; state comes from the instance's status.state.
 *
 * Auth is an IAM bearer: a ready `accessToken`, or a service account
 * (serviceAccountId, publicKeyId, privateKey) whose RS256 JWT is exchanged
 * at auth.eu.nebius.com for a 12 hour token. A VM is one replica; a
 * stopped VM bills only its disk, so scale(0) stops it.
 */
const DEFAULT_API_HOST = 'https://api.eu.nebius.cloud';
const DEFAULT_AUTH_HOST = 'https://auth.eu.nebius.com';
const DEFAULT_PLATFORM = 'gpu-h100-sxm';
const DEFAULT_PRESET = '1gpu-16vcpu-200gb';
const DEFAULT_IMAGE_FAMILY = 'ubuntu22.04-cuda12';
const DEFAULT_VLLM_IMAGE = 'vllm/vllm-openai:latest';
const MODEL_DIR = '/opt/almyty/model';
const PORT = 8000;

const STATE_MAP: Record<string, ActualState['state']> = {
  CREATING: 'deploying',
  STARTING: 'deploying',
  UPDATING: 'scaling',
  RUNNING: 'ready',
  STOPPING: 'scaling',
  STOPPED: 'stopped',
  DELETING: 'stopped',
  ERROR: 'failed',
};

interface CachedToken {
  token: string;
  expiresAt: number;
}

export class NebiusAdapter implements ModelProviderAdapter {
  readonly key = 'nebius';
  readonly displayName = 'Nebius AI Cloud (GPU VM with vLLM)';

  private readonly tokens = new Map<string, CachedToken>();

  constructor(
    private readonly http: AxiosInstance = axios.create({ timeout: 60_000 }),
    private readonly diskWait: { timeoutMs: number; pollMs: number } = { timeoutMs: 180_000, pollMs: 3_000 },
  ) {}

  capabilities(): AdapterCapabilities {
    return {
      architectures: 'any',
      lora: 'merged',
      serverless: false,
      dedicated: true,
      scaleToZero: true,
      regions: ['eu-north1', 'eu-west1', 'us-central1'],
      registrySources: ['s3', 'hub'],
    };
  }

  configSchema(): Record<string, any> {
    return {
      type: 'object',
      properties: {
        parentId: { type: 'string', title: 'Project ID', description: 'The Nebius project resources are created in' },
        subnetId: { type: 'string', title: 'Subnet ID' },
        serviceAccountId: { type: 'string', title: 'Service account ID' },
        publicKeyId: { type: 'string', title: 'Authorized key ID' },
        privateKey: { type: 'string', title: 'Authorized key (PEM private key)', 'x-secret': true },
        accessToken: { type: 'string', title: 'IAM access token', description: 'Alternative to a service account; expires after 12 hours', 'x-secret': true },
        apiHost: { type: 'string', title: 'API host', default: DEFAULT_API_HOST },
        authHost: { type: 'string', title: 'IAM host', default: DEFAULT_AUTH_HOST },
        platform: { type: 'string', title: 'Platform', default: DEFAULT_PLATFORM },
        preset: { type: 'string', title: 'Preset', default: DEFAULT_PRESET },
        imageFamily: { type: 'string', title: 'Boot image family', default: DEFAULT_IMAGE_FAMILY },
        bootDiskGib: { type: 'integer', minimum: 64, default: 512 },
        diskType: { type: 'string', enum: ['NETWORK_SSD', 'NETWORK_HDD', 'NETWORK_SSD_NON_REPLICATED', 'NETWORK_SSD_IO_M3'], default: 'NETWORK_SSD' },
        vllmImage: { type: 'string', title: 'vLLM container image', default: DEFAULT_VLLM_IMAGE },
        maxModelLen: { type: 'integer', title: 'vLLM max model length' },
        hourlyRateCents: { type: 'integer', title: 'Preset price per hour (cents)', description: 'Nebius exposes no spend API; used to estimate cost' },
        registryAccessKeyId: { type: 'string', title: 'Registry access key (S3 source)', 'x-secret': true },
        registrySecretAccessKey: { type: 'string', title: 'Registry secret key (S3 source)', 'x-secret': true },
        registryEndpoint: { type: 'string', title: 'Registry endpoint (S3 source)' },
        hfToken: { type: 'string', title: 'Hugging Face token (gated hub models)', 'x-secret': true },
      },
      required: ['parentId', 'subnetId'],
    };
  }

  private classify(err: any, fallback: string): never {
    if (typeof err?.code === 'string' && err.code.startsWith('ADAPTER_')) throw err;
    const status = err?.response?.status;
    const body = err?.response?.data;
    const message = body?.message ?? body?.error_description ?? body?.error ?? err?.message ?? fallback;
    if (status === 401 || status === 403) throw Object.assign(new Error(`credential rejected: ${message}`), { code: 'ADAPTER_AUTH', status });
    if (status === 429 || /quota|limit|RESOURCE_EXHAUSTED/i.test(String(message))) throw Object.assign(new Error(`quota: ${message}`), { code: 'ADAPTER_QUOTA_EXCEEDED', status });
    if (status === 404) throw Object.assign(new Error(`not found: ${message}`), { code: 'ADAPTER_NOT_FOUND', status });
    throw Object.assign(new Error(message), { code: 'ADAPTER_ERROR', status });
  }

  /** RS256 JWT for the service account, as the IAM token exchange expects it. */
  static serviceAccountJwt(serviceAccountId: string, publicKeyId: string, privateKey: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
    const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const header = b64({ alg: 'RS256', typ: 'JWT', kid: publicKeyId });
    const payload = b64({ iss: serviceAccountId, sub: serviceAccountId, exp: nowSeconds + 300 });
    const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey).toString('base64url');
    return `${header}.${payload}.${signature}`;
  }

  private async token(credentials: AdapterCredentials, ids: { serviceAccountId?: string; publicKeyId?: string; authHost?: string; [key: string]: any }): Promise<string> {
    if (credentials.accessToken) return credentials.accessToken;
    const serviceAccountId = credentials.serviceAccountId ?? ids.serviceAccountId;
    const publicKeyId = credentials.publicKeyId ?? ids.publicKeyId;
    if (!serviceAccountId || !publicKeyId || !credentials.privateKey) {
      throw Object.assign(new Error('missing Nebius credential: accessToken or serviceAccountId, publicKeyId and privateKey'), { code: 'ADAPTER_AUTH', status: 401 });
    }
    const cacheKey = createHash('sha256').update(`${serviceAccountId}/${publicKeyId}/${credentials.privateKey}`).digest('hex');
    const cached = this.tokens.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 5 * 60_000) return cached.token;
    let assertion: string;
    try {
      assertion = NebiusAdapter.serviceAccountJwt(serviceAccountId, publicKeyId, credentials.privateKey);
    } catch (err: any) {
      throw Object.assign(new Error(`invalid private key: ${err.message}`), { code: 'ADAPTER_AUTH', status: 401 });
    }
    const form = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      subject_token: assertion,
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    });
    try {
      const res = await this.http.post(`${ids.authHost ?? DEFAULT_AUTH_HOST}/oauth2/token/exchange`, form.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      const token = res.data?.access_token;
      if (!token) throw Object.assign(new Error('token exchange returned no access_token'), { code: 'ADAPTER_AUTH', status: 401 });
      this.tokens.set(cacheKey, { token, expiresAt: Date.now() + Number(res.data?.expires_in ?? 43_200) * 1000 });
      return token;
    } catch (err: any) {
      if (err?.code === 'ADAPTER_AUTH') throw err;
      const status = err?.response?.status;
      if (status === 400 || status === 401 || status === 403) {
        throw Object.assign(new Error(`credential rejected: ${err?.response?.data?.error_description ?? err?.response?.data?.message ?? err.message}`), { code: 'ADAPTER_AUTH', status });
      }
      this.classify(err, 'token exchange failed');
    }
  }

  private async headers(credentials: AdapterCredentials, ids: Record<string, any>) {
    return { Authorization: `Bearer ${await this.token(credentials, ids)}`, 'Content-Type': 'application/json' };
  }

  static instanceName(deploymentId: string): string {
    return `almyty-${deploymentId.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 20)}`;
  }

  /** cloud-init that fetches the weights and runs vLLM; secrets live in a root-only env file, not on the command line. */
  static userData(request: DeployRequest, credentials: AdapterCredentials): string {
    const cfg = request.providerConfig;
    const uri = request.version.registryUri;
    const envLines: string[] = [];
    let fetchCmd = '';
    let modelArg: string;
    if (uri.startsWith('hf://')) {
      const [repo, rev] = uri.slice('hf://'.length).split('@');
      if (credentials.hfToken) envLines.push(`HF_TOKEN=${credentials.hfToken}`, `HUGGING_FACE_HUB_TOKEN=${credentials.hfToken}`);
      modelArg = `--model ${repo} --revision ${rev ?? 'main'}`;
    } else {
      const [key] = uri.slice('s3://'.length).split('@');
      if (credentials.registryAccessKeyId) envLines.push(`AWS_ACCESS_KEY_ID=${credentials.registryAccessKeyId}`);
      if (credentials.registrySecretAccessKey) envLines.push(`AWS_SECRET_ACCESS_KEY=${credentials.registrySecretAccessKey}`);
      envLines.push('AWS_DEFAULT_REGION=us-east-1');
      const endpoint = cfg.registryEndpoint ? ` --endpoint-url ${cfg.registryEndpoint}` : '';
      fetchCmd = `docker run --rm --env-file /opt/almyty/env -v ${MODEL_DIR}:/model amazon/aws-cli s3 sync${endpoint} s3://${key} /model`;
      modelArg = '--model /model';
    }
    const extra = [
      `--served-model-name ${request.version.name}`,
      request.desired.quantization ? `--quantization ${request.desired.quantization}` : '',
      cfg.maxModelLen ? `--max-model-len ${cfg.maxModelLen}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    const run = `docker run -d --restart unless-stopped --name almyty-vllm --gpus all --ipc=host -p ${PORT}:${PORT} --env-file /opt/almyty/env -v ${MODEL_DIR}:/model -v /opt/almyty/hf-cache:/root/.cache/huggingface ${cfg.vllmImage ?? DEFAULT_VLLM_IMAGE} ${modelArg} ${extra} --port ${PORT}`;
    const lines = [
      '#cloud-config',
      'write_files:',
      '  - path: /opt/almyty/env',
      "    permissions: '0600'",
      '    content: |',
      ...(envLines.length ? envLines.map((l) => `      ${l}`) : ['      ALMYTY=1']),
      'runcmd:',
      `  - mkdir -p ${MODEL_DIR} /opt/almyty/hf-cache`,
      '  - command -v docker >/dev/null 2>&1 || (curl -fsSL https://get.docker.com | sh)',
      '  - command -v nvidia-ctk >/dev/null 2>&1 || (curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg && curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed "s#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g" > /etc/apt/sources.list.d/nvidia-container-toolkit.list && apt-get update && apt-get install -y nvidia-container-toolkit && nvidia-ctk runtime configure --runtime=docker && systemctl restart docker)',
      ...(fetchCmd ? [`  - ${fetchCmd}`] : []),
      `  - ${run}`,
    ];
    return lines.join('\n') + '\n';
  }

  private base(ref: { apiHost?: string; [key: string]: any }): string {
    return String(ref.apiHost ?? DEFAULT_API_HOST).replace(/\/+$/, '');
  }

  private async waitForDisk(base: string, diskId: string, headers: Record<string, string>): Promise<void> {
    const started = Date.now();
    for (;;) {
      const disk = (await this.http.get(`${base}/compute/v1/disks/${encodeURIComponent(diskId)}`, { headers })).data;
      const state = String(disk?.status?.state ?? '');
      if (state === 'READY') return;
      if (state === 'ERROR') throw Object.assign(new Error(`boot disk ${diskId} failed to create`), { code: 'ADAPTER_ERROR' });
      if (Date.now() - started > this.diskWait.timeoutMs) throw Object.assign(new Error(`boot disk ${diskId} not ready after ${this.diskWait.timeoutMs} ms`), { code: 'ADAPTER_ERROR' });
      await new Promise((r) => setTimeout(r, this.diskWait.pollMs));
    }
  }

  async deploy(request: DeployRequest, credentials: AdapterCredentials): Promise<EndpointRef> {
    const cfg = request.providerConfig;
    if ((request.desired.replicas ?? 1) > 1 || (request.desired.maxScale ?? 1) > 1) {
      throw new UnsupportedOperationError(this.key, 'more than one replica (a VM serves one replica)');
    }
    const uri = request.version.registryUri;
    if (!uri.startsWith('s3://') && !uri.startsWith('hf://')) {
      throw Object.assign(new Error(`unsupported registry uri ${uri}`), { code: 'ADAPTER_UNSUPPORTED_SOURCE' });
    }
    const name = NebiusAdapter.instanceName(request.deploymentId);
    const ids = { serviceAccountId: cfg.serviceAccountId, publicKeyId: cfg.publicKeyId, authHost: cfg.authHost, apiHost: cfg.apiHost };
    const base = this.base(ids);
    let diskId: string | undefined;
    let headers: Record<string, string>;
    try {
      headers = await this.headers(credentials, ids);
      const disk = await this.http.post(
        `${base}/compute/v1/disks`,
        {
          metadata: { parentId: cfg.parentId, name: `${name}-boot` },
          spec: { type: cfg.diskType ?? 'NETWORK_SSD', sizeGibibytes: cfg.bootDiskGib ?? 512, sourceImageFamily: { imageFamily: cfg.imageFamily ?? DEFAULT_IMAGE_FAMILY } },
        },
        { headers },
      );
      diskId = disk.data?.resourceId;
      await this.waitForDisk(base, diskId!, headers);
      const instance = await this.http.post(
        `${base}/compute/v1/instances`,
        {
          metadata: { parentId: cfg.parentId, name },
          spec: {
            resources: { platform: request.desired.hardware ?? cfg.platform ?? DEFAULT_PLATFORM, preset: cfg.preset ?? DEFAULT_PRESET },
            bootDisk: { attachMode: 'READ_WRITE', existingDisk: { id: diskId } },
            networkInterfaces: [{ name: 'eth0', subnetId: cfg.subnetId, ipAddress: {}, publicIpAddress: {} }],
            cloudInitUserData: NebiusAdapter.userData(request, credentials),
          },
        },
        { headers },
      );
      return {
        instanceId: instance.data?.resourceId,
        diskId,
        name,
        parentId: cfg.parentId,
        ...ids,
        createdAt: new Date().toISOString(),
        hourlyRateCents: cfg.hourlyRateCents ?? 0,
      };
    } catch (err) {
      // A disk with no instance would bill forever; drop it before surfacing the error.
      if (diskId && headers!) await this.http.delete(`${base}/compute/v1/disks/${encodeURIComponent(diskId)}`, { headers }).catch(() => undefined);
      this.classify(err, 'create instance failed');
    }
  }

  async readEndpoint(ref: EndpointRef, credentials: AdapterCredentials): Promise<ActualState> {
    const base = this.base(ref);
    let instance: any;
    try {
      const headers = await this.headers(credentials, ref);
      instance = (await this.http.get(`${base}/compute/v1/instances/${encodeURIComponent(ref.instanceId)}`, { headers })).data;
    } catch (err: any) {
      if (err?.response?.status === 404) return { state: 'missing', message: 'instance not found' };
      this.classify(err, 'read instance failed');
    }
    const raw = String(instance?.status?.state ?? 'CREATING');
    const ip = instance?.status?.networkInterfaces?.[0]?.publicIpAddress?.address;
    const url = ip ? `http://${ip}:${PORT}/v1` : undefined;
    let state = STATE_MAP[raw] ?? 'deploying';
    let message: string | undefined;
    if (state === 'ready') {
      if (!url) {
        state = 'deploying';
        message = 'waiting for a public address';
      } else {
        try {
          await this.http.get(`${url}/models`, { timeout: 5_000 });
        } catch {
          state = 'deploying';
          message = 'instance running, vLLM not answering yet';
        }
      }
    }
    return {
      state,
      url,
      replicas: state === 'ready' ? 1 : 0,
      hardware: [instance?.spec?.resources?.platform, instance?.spec?.resources?.preset].filter(Boolean).join('/') || undefined,
      message,
      details: { rawState: raw, diskId: ref.diskId },
    };
  }

  async scale(ref: EndpointRef, replicas: number, credentials: AdapterCredentials): Promise<void> {
    if (replicas > 1) throw new UnsupportedOperationError(this.key, 'more than one replica (a VM serves one replica)');
    const base = this.base(ref);
    try {
      const headers = await this.headers(credentials, ref);
      await this.http.post(`${base}/compute/v1/instances/${encodeURIComponent(ref.instanceId)}:${replicas === 0 ? 'stop' : 'start'}`, {}, { headers });
    } catch (err) {
      this.classify(err, 'scale failed');
    }
  }

  async teardown(ref: EndpointRef, credentials: AdapterCredentials): Promise<void> {
    const base = this.base(ref);
    let headers: Record<string, string>;
    try {
      headers = await this.headers(credentials, ref);
      await this.http.delete(`${base}/compute/v1/instances/${encodeURIComponent(ref.instanceId)}`, { headers });
    } catch (err: any) {
      if (err?.response?.status !== 404) this.classify(err, 'delete failed');
    }
    // The disk detaches once the instance is gone; a delete that races the detach is retried by the next sweep.
    if (ref.diskId) await this.http.delete(`${base}/compute/v1/disks/${encodeURIComponent(ref.diskId)}`, { headers: headers! }).catch(() => undefined);
  }

  /** Nebius exposes no spend API; a stopped VM bills only its disk, which is left out of the compute rate. */
  async costSnapshot(ref: EndpointRef, credentials: AdapterCredentials): Promise<CostSnapshot> {
    const actual = await this.readEndpoint(ref, credentials);
    const rate = Number(ref.hourlyRateCents ?? 0);
    const running = actual.state === 'ready' || actual.state === 'deploying' || actual.state === 'scaling' ? 1 : 0;
    const hours = ref.createdAt ? Math.max(0, (Date.now() - new Date(ref.createdAt).getTime()) / 3_600_000) : 0;
    return { spentCents: Math.round(rate * hours), ratePerHourCents: rate * running, observedAt: new Date() };
  }
}
