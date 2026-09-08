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
 * DigitalOcean GPU Droplets running vLLM. Verified shapes are in
 * docs/design/adapters/digitalocean.md.
 *
 * API v2 at https://api.digitalocean.com with a bearer token. Deploy
 * creates one GPU droplet from a GPU base image whose cloud-init pulls the
 * registry version (S3 through the aws-cli container, or the Hub) and runs
 * the vLLM OpenAI container on port 8000, so the endpoint is
 * http://<public ip>:8000/v1. Readiness is the droplet being active plus
 * /v1/models answering. A droplet is one replica: scale(0) powers it off,
 * scale(1) powers it on, anything above one is refused. DigitalOcean bills
 * a powered-off droplet at the full rate, so scaleToZero is false and the
 * only way to stop paying is teardown, which deletes the droplet.
 *
 * Cost uses size.price_hourly as returned on the droplet itself.
 */
const BASE_URL = 'https://api.digitalocean.com/v2';
const DEFAULT_SIZE = 'gpu-h100x1-80gb';
const DEFAULT_IMAGE = 'gpu-h100x1-base';
const DEFAULT_VLLM_IMAGE = 'vllm/vllm-openai:latest';
const MODEL_DIR = '/opt/almyty/model';
const PORT = 8000;

const STATUS_MAP: Record<string, ActualState['state']> = {
  new: 'deploying',
  active: 'ready',
  off: 'stopped',
  archive: 'stopped',
};

export class DigitalOceanAdapter implements ModelProviderAdapter {
  readonly key = 'digitalocean';
  readonly displayName = 'DigitalOcean GPU Droplet (vLLM)';

  constructor(private readonly http: AxiosInstance = axios.create({ timeout: 30_000 })) {}

  capabilities(): AdapterCapabilities {
    return {
      architectures: 'any',
      lora: 'merged',
      serverless: false,
      dedicated: true,
      scaleToZero: false,
      regions: ['nyc2', 'tor1', 'atl1'],
      registrySources: ['s3', 'hub'],
    };
  }

  configSchema(): Record<string, any> {
    return {
      type: 'object',
      properties: {
        token: { type: 'string', title: 'DigitalOcean API token', description: 'Needs droplet read and write scopes', 'x-secret': true },
        region: { type: 'string', title: 'Region', default: 'nyc2' },
        size: { type: 'string', title: 'GPU droplet size', default: DEFAULT_SIZE },
        image: { type: 'string', title: 'Base image', description: 'A GPU image with the NVIDIA container toolkit, e.g. gpu-h100x1-base', default: DEFAULT_IMAGE },
        vllmImage: { type: 'string', title: 'vLLM container image', default: DEFAULT_VLLM_IMAGE },
        sshKeys: { type: 'array', items: { type: 'string' }, title: 'SSH key ids or fingerprints' },
        vpcUuid: { type: 'string', title: 'VPC' },
        maxModelLen: { type: 'integer', title: 'vLLM max model length' },
        hourlyRateCents: { type: 'integer', title: 'Fallback price per hour (cents)', description: 'Only used when the API omits size.price_hourly' },
        registryAccessKeyId: { type: 'string', title: 'Registry access key (S3 source)', 'x-secret': true },
        registrySecretAccessKey: { type: 'string', title: 'Registry secret key (S3 source)', 'x-secret': true },
        registryEndpoint: { type: 'string', title: 'Registry endpoint (S3 source)' },
        hfToken: { type: 'string', title: 'Hugging Face token (gated hub models)', 'x-secret': true },
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
    if (status === 401 || status === 403) throw Object.assign(new Error(`credential rejected: ${message}`), { code: 'ADAPTER_AUTH', status });
    if (status === 429 || (status === 422 && /limit|quota|capacity|not available/i.test(String(message))) || /limit|quota/i.test(String(message))) {
      throw Object.assign(new Error(`quota: ${message}`), { code: 'ADAPTER_QUOTA_EXCEEDED', status });
    }
    if (status === 404) throw Object.assign(new Error(`not found: ${message}`), { code: 'ADAPTER_NOT_FOUND', status });
    throw Object.assign(new Error(message), { code: 'ADAPTER_ERROR', status });
  }

  static dropletName(deploymentId: string): string {
    return `almyty-${deploymentId.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 20)}`;
  }

  /**
   * cloud-init that fetches the weights and starts vLLM. Secrets go to a
   * root-only env file rather than the command line so they do not show up
   * in the process list or the console log.
   */
  static userData(request: DeployRequest, credentials: AdapterCredentials): string {
    const cfg = request.providerConfig;
    const uri = request.version.registryUri;
    const fromHub = uri.startsWith('hf://');
    const envLines: string[] = [];
    let fetchCmd = '';
    let modelArg: string;
    if (fromHub) {
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
      modelArg = `--model /model`;
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
      ...(fetchCmd ? [`  - ${fetchCmd}`] : []),
      `  - ${run}`,
    ];
    return lines.join('\n') + '\n';
  }

  private static publicIp(droplet: any): string | undefined {
    return (droplet?.networks?.v4 ?? []).find((n: any) => n.type === 'public')?.ip_address;
  }

  private static rateCents(droplet: any, fallback: number): number {
    const price = droplet?.size?.price_hourly;
    return typeof price === 'number' ? Math.round(price * 100) : fallback;
  }

  async deploy(request: DeployRequest, credentials: AdapterCredentials): Promise<EndpointRef> {
    const cfg = request.providerConfig;
    if ((request.desired.replicas ?? 1) > 1 || (request.desired.maxScale ?? 1) > 1) {
      throw new UnsupportedOperationError(this.key, 'more than one replica (a droplet serves one replica)');
    }
    const uri = request.version.registryUri;
    if (!uri.startsWith('s3://') && !uri.startsWith('hf://')) {
      throw Object.assign(new Error(`unsupported registry uri ${uri}`), { code: 'ADAPTER_UNSUPPORTED_SOURCE' });
    }
    const name = DigitalOceanAdapter.dropletName(request.deploymentId);
    const body = {
      name,
      region: request.desired.region ?? cfg.region ?? 'nyc2',
      size: request.desired.hardware ?? cfg.size ?? DEFAULT_SIZE,
      image: cfg.image ?? DEFAULT_IMAGE,
      ...(cfg.sshKeys?.length ? { ssh_keys: cfg.sshKeys } : {}),
      ...(cfg.vpcUuid ? { vpc_uuid: cfg.vpcUuid } : {}),
      monitoring: true,
      tags: ['almyty', `almyty-deployment:${request.deploymentId}`],
      user_data: DigitalOceanAdapter.userData(request, credentials),
    };
    try {
      const res = await this.http.post(`${BASE_URL}/droplets`, body, { headers: this.headers(credentials) });
      const droplet = res.data?.droplet;
      return {
        dropletId: droplet?.id,
        name,
        region: droplet?.region?.slug ?? body.region,
        size: droplet?.size_slug ?? body.size,
        createdAt: new Date().toISOString(),
        hourlyRateCents: DigitalOceanAdapter.rateCents(droplet, cfg.hourlyRateCents ?? 0),
      };
    } catch (err) {
      this.classify(err, 'create droplet failed');
    }
  }

  async readEndpoint(ref: EndpointRef, credentials: AdapterCredentials): Promise<ActualState> {
    let droplet: any;
    try {
      droplet = (await this.http.get(`${BASE_URL}/droplets/${encodeURIComponent(ref.dropletId)}`, { headers: this.headers(credentials) })).data?.droplet;
    } catch (err: any) {
      if (err?.response?.status === 404) return { state: 'missing', message: 'droplet not found' };
      this.classify(err, 'read droplet failed');
    }
    const raw = String(droplet?.status ?? 'new');
    const ip = DigitalOceanAdapter.publicIp(droplet);
    const url = ip ? `http://${ip}:${PORT}/v1` : undefined;
    let state = STATUS_MAP[raw] ?? 'deploying';
    let message: string | undefined;
    if (state === 'ready') {
      if (!url) {
        state = 'deploying';
        message = 'waiting for a public address';
      } else {
        // The droplet being active says nothing about vLLM; only the model list does.
        try {
          await this.http.get(`${url}/models`, { timeout: 5_000 });
        } catch {
          state = 'deploying';
          message = 'droplet active, vLLM not answering yet';
        }
      }
    }
    return {
      state,
      url,
      replicas: state === 'ready' ? 1 : 0,
      hardware: droplet?.size_slug,
      region: droplet?.region?.slug,
      message,
      details: { rawStatus: raw, priceHourly: droplet?.size?.price_hourly },
    };
  }

  async scale(ref: EndpointRef, replicas: number, credentials: AdapterCredentials): Promise<void> {
    if (replicas > 1) throw new UnsupportedOperationError(this.key, 'more than one replica (a droplet serves one replica)');
    try {
      await this.http.post(
        `${BASE_URL}/droplets/${encodeURIComponent(ref.dropletId)}/actions`,
        { type: replicas === 0 ? 'power_off' : 'power_on' },
        { headers: this.headers(credentials) },
      );
    } catch (err) {
      this.classify(err, 'scale failed');
    }
  }

  async teardown(ref: EndpointRef, credentials: AdapterCredentials): Promise<void> {
    try {
      await this.http.delete(`${BASE_URL}/droplets/${encodeURIComponent(ref.dropletId)}`, { headers: this.headers(credentials) });
    } catch (err: any) {
      if (err?.response?.status === 404) return;
      this.classify(err, 'delete failed');
    }
  }

  /** DigitalOcean bills the droplet hourly while it exists, powered on or off; the rate comes from the size on the droplet. */
  async costSnapshot(ref: EndpointRef, credentials: AdapterCredentials): Promise<CostSnapshot> {
    const actual = await this.readEndpoint(ref, credentials);
    const rate = actual.state === 'missing' ? 0 : typeof actual.details?.priceHourly === 'number' ? Math.round(actual.details.priceHourly * 100) : Number(ref.hourlyRateCents ?? 0);
    const hours = ref.createdAt ? Math.max(0, (Date.now() - new Date(ref.createdAt).getTime()) / 3_600_000) : 0;
    return { spentCents: Math.round(rate * hours), ratePerHourCents: rate, observedAt: new Date() };
  }
}
