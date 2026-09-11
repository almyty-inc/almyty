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
 * Ollama: the local tier, and any Ollama server you run elsewhere.
 *
 * "Deploy" means the server pulls or creates the model and loads it into
 * memory; "scale to zero" unloads it; "teardown" deletes it. Sources:
 *   hf://org/repo@rev     pulled straight from the Hub (hf.co/org/repo[:quant])
 *   file:///path@sha      created from a GGUF or directory on the Ollama host
 *   library:tag           a plain Ollama library tag (set providerConfig.tag)
 * Chat goes through the server's OpenAI-compatible /v1. A bearer token is
 * optional and only meaningful behind a reverse proxy that checks one.
 */
export class OllamaAdapter implements ModelProviderAdapter {
  readonly key = 'ollama';
  readonly displayName = 'Ollama (local or remote server)';

  constructor(private readonly http: AxiosInstance = axios.create({ timeout: 10 * 60_000 })) {}

  capabilities(): AdapterCapabilities {
    return {
      architectures: 'any',
      lora: 'merged',
      serverless: false,
      dedicated: true,
      scaleToZero: true,
      regions: [],
      // Ollama pulls from the Hub itself; a local path is the other
      // documented source. It cannot read object storage, so an s3
      // version is refused rather than mirrored by us.
      registrySources: ['hub', 'local'],
    };
  }

  configSchema(): Record<string, any> {
    return {
      type: 'object',
      properties: {
        baseUrl: { type: 'string', title: 'Ollama server URL', default: 'http://localhost:11434' },
        token: { type: 'string', title: 'Bearer token', description: 'Only if a proxy in front of Ollama requires one', 'x-secret': true },
        tag: { type: 'string', title: 'Model tag', description: 'Name to create or library tag to pull; defaults to the version name' },
        keepAlive: { type: 'string', title: 'Keep loaded', description: 'Ollama keep_alive while replicas > 0; -1 keeps the model in memory', default: '-1' },
        hourlyRateCents: { type: 'integer', title: 'Machine price per hour (cents)', description: 'Ollama bills nothing; set this to account for a rented box' },
      },
    };
  }

  private headers(credentials: AdapterCredentials): Record<string, string> {
    return { 'Content-Type': 'application/json', ...(credentials.token ? { Authorization: `Bearer ${credentials.token}` } : {}) };
  }

  private classify(err: any, fallback: string): never {
    const status = err?.response?.status;
    const body = err?.response?.data;
    const message = body?.error ?? body?.message ?? err?.message ?? fallback;
    if (status === 401 || status === 403) throw Object.assign(new Error(`credential rejected: ${message}`), { code: 'ADAPTER_AUTH', status });
    if (status === 429 || /no space|disk full|insufficient|quota/i.test(String(message))) {
      throw Object.assign(new Error(`quota: ${message}`), { code: 'ADAPTER_QUOTA_EXCEEDED', status });
    }
    if (status === 404) throw Object.assign(new Error(`not found: ${message}`), { code: 'ADAPTER_NOT_FOUND', status });
    if (err?.code === 'ECONNREFUSED' || err?.code === 'ENOTFOUND' || err?.code === 'ECONNABORTED') {
      throw Object.assign(new Error(`Ollama server unreachable: ${message}`), { code: 'ADAPTER_UNREACHABLE', status });
    }
    throw Object.assign(new Error(message), { code: 'ADAPTER_ERROR', status });
  }

  private base(cfg: Record<string, any>): string {
    return String(cfg.baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '');
  }

  /** How the server gets the weights: a pull target or a create-from path. */
  static source(request: DeployRequest): { model: string; pull?: string; from?: string } {
    const uri = request.version.registryUri;
    const cfg = request.providerConfig;
    const quant = request.desired.quantization;
    if (uri.startsWith('hf://')) {
      const [repo] = uri.slice('hf://'.length).split('@');
      const target = `hf.co/${repo}${quant ? `:${quant}` : ''}`;
      return { model: cfg.tag ?? target, pull: target };
    }
    const name = cfg.tag ?? request.version.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
    if (uri.startsWith('file://')) {
      const [path] = uri.slice('file://'.length).split('@');
      return { model: name, from: path };
    }
    if (uri.startsWith('s3://')) {
      // Ollama reads the Hub or a path on its own host. Mirroring our
      // object storage onto that host would make almyty the delivery
      // route for the weights, so it is refused instead.
      throw Object.assign(new Error('Ollama serves from a Hugging Face repository or a path on its own host; point the version at hf:// or file://'), { code: 'ADAPTER_UNSUPPORTED_SOURCE' });
    }
    if (uri.startsWith('library:')) return { model: uri.slice('library:'.length), pull: uri.slice('library:'.length) };
    throw Object.assign(new Error(`unsupported registry uri ${uri}`), { code: 'ADAPTER_UNSUPPORTED_SOURCE' });
  }

  private async load(base: string, model: string, keepAlive: string | number, credentials: AdapterCredentials): Promise<void> {
    await this.http.post(`${base}/api/generate`, { model, keep_alive: keepAlive, stream: false }, { headers: this.headers(credentials) });
  }

  async deploy(request: DeployRequest, credentials: AdapterCredentials): Promise<EndpointRef> {
    const cfg = request.providerConfig;
    const base = this.base(cfg);
    const src = OllamaAdapter.source(request);
    try {
      if (src.pull) {
        await this.http.post(`${base}/api/pull`, { model: src.pull, stream: false }, { headers: this.headers(credentials) });
        if (src.model !== src.pull) {
          await this.http.post(`${base}/api/copy`, { source: src.pull, destination: src.model }, { headers: this.headers(credentials) });
        }
      } else {
        await this.http.post(`${base}/api/create`, { model: src.model, from: src.from, stream: false }, { headers: this.headers(credentials) });
      }
      if ((request.desired.replicas ?? 1) > 0) await this.load(base, src.model, cfg.keepAlive ?? '-1', credentials);
    } catch (err) {
      this.classify(err, 'deploy failed');
    }
    return { model: src.model, baseUrl: base, url: `${base}/v1`, keepAlive: cfg.keepAlive ?? '-1', hourlyRateCents: cfg.hourlyRateCents ?? 0 };
  }

  async readEndpoint(ref: EndpointRef, credentials: AdapterCredentials): Promise<ActualState> {
    const base = ref.baseUrl;
    try {
      const tags = await this.http.get(`${base}/api/tags`, { headers: this.headers(credentials) });
      const present = (tags.data?.models ?? []).find((m: any) => m.name === ref.model || m.model === ref.model);
      if (!present) return { state: 'missing', message: `model ${ref.model} is not on the server` };
      const ps = await this.http.get(`${base}/api/ps`, { headers: this.headers(credentials) });
      const loaded = (ps.data?.models ?? []).find((m: any) => m.name === ref.model || m.model === ref.model);
      return {
        state: loaded ? 'ready' : 'stopped',
        url: ref.url,
        replicas: loaded ? 1 : 0,
        hardware: loaded?.size_vram ? `vram ${Math.round(loaded.size_vram / 1e9)} GB` : undefined,
        details: { sizeBytes: present.size, family: present.details?.family, quantization: present.details?.quantization_level, expiresAt: loaded?.expires_at },
      };
    } catch (err) {
      this.classify(err, 'read failed');
    }
  }

  async scale(ref: EndpointRef, replicas: number, credentials: AdapterCredentials): Promise<void> {
    try {
      await this.load(ref.baseUrl, ref.model, replicas > 0 ? ref.keepAlive ?? '-1' : 0, credentials);
    } catch (err) {
      this.classify(err, 'scale failed');
    }
  }

  async teardown(ref: EndpointRef, credentials: AdapterCredentials): Promise<void> {
    try {
      await this.http.delete(`${ref.baseUrl}/api/delete`, { headers: this.headers(credentials), data: { model: ref.model } });
    } catch (err: any) {
      if (err?.response?.status === 404) return;
      this.classify(err, 'teardown failed');
    }
  }

  /** Ollama bills nothing; a rented machine is accounted through hourlyRateCents while the model is loaded. */
  async costSnapshot(ref: EndpointRef, credentials: AdapterCredentials): Promise<CostSnapshot> {
    const actual = await this.readEndpoint(ref, credentials);
    return {
      spentCents: 0,
      ratePerHourCents: actual.state === 'ready' ? Number(ref.hourlyRateCents ?? 0) : 0,
      perToken: { inPerMTok: 0, outPerMTok: 0, currency: 'USD' },
      observedAt: new Date(),
    };
  }
}
