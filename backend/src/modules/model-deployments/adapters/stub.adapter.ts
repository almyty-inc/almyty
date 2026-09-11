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
 * An in-memory provider. It exists so the conformance suite, the
 * reconcile loop and the router can be exercised without an account
 * anywhere, and so a new adapter has a reference for what "ready",
 * "scaled to zero" and "orphaned" look like.
 *
 * Behaviour is deterministic and driven by the request: an architecture
 * outside `architectures` is refused before anything is created, the
 * credential `token` must equal 'valid', and the config `simulate` field
 * can force 'quota_exceeded' or 'fail_ready'.
 */
interface StubEndpoint {
  id: string;
  url: string;
  replicas: number;
  state: ActualState['state'];
  hardware?: string;
  spentCents: number;
  createdAt: number;
}

export class StubAdapter implements ModelProviderAdapter {
  readonly key = 'stub';
  readonly displayName = 'Stub (in-memory)';
  readonly endpoints = new Map<string, StubEndpoint>();
  private seq = 0;

  constructor(private readonly options: { architectures?: string[] | 'any'; centsPerHour?: number } = {}) {}

  capabilities(): AdapterCapabilities {
    return {
      architectures: this.options.architectures ?? ['qwen3', 'llama'],
      lora: 'merged',
      serverless: true,
      dedicated: false,
      scaleToZero: true,
      regions: ['eu', 'us'],
      registrySources: ['hub', 's3', 'local'],
    };
  }

  configSchema(): Record<string, any> {
    return {
      type: 'object',
      properties: {
        token: { type: 'string', title: 'API token', 'x-secret': true },
        image: { type: 'string', title: 'Container image', default: 'stub/vllm:latest' },
        simulate: { type: 'string', enum: ['none', 'quota_exceeded', 'fail_ready'], default: 'none' },
      },
      required: ['token'],
    };
  }

  private auth(credentials: AdapterCredentials): void {
    if (credentials.token !== 'valid') {
      throw Object.assign(new Error('credential expired or invalid'), { code: 'ADAPTER_AUTH', status: 401 });
    }
  }

  async deploy(request: DeployRequest, credentials: AdapterCredentials): Promise<EndpointRef> {
    this.auth(credentials);
    const caps = this.capabilities();
    if (caps.architectures !== 'any' && !caps.architectures.some((a) => request.version.base.startsWith(a))) {
      throw Object.assign(new Error(`architecture ${request.version.base} is not supported by ${this.key}`), {
        code: 'ADAPTER_UNSUPPORTED_ARCHITECTURE',
      });
    }
    if (request.providerConfig.simulate === 'quota_exceeded') {
      throw Object.assign(new Error('quota exceeded for this account'), { code: 'ADAPTER_QUOTA_EXCEEDED', status: 429 });
    }
    const id = `stub-ep-${++this.seq}`;
    const failReady = request.providerConfig.simulate === 'fail_ready';
    this.endpoints.set(id, {
      id,
      url: `https://stub.invalid/${id}/v1`,
      replicas: request.desired.replicas ?? 1,
      state: failReady ? 'failed' : 'ready',
      hardware: request.desired.hardware,
      spentCents: 0,
      createdAt: Date.now(),
    });
    return { id, url: `https://stub.invalid/${id}/v1` };
  }

  async readEndpoint(ref: EndpointRef, credentials: AdapterCredentials): Promise<ActualState> {
    this.auth(credentials);
    const ep = this.endpoints.get(ref.id);
    if (!ep) return { state: 'missing', message: 'endpoint not found' };
    return { state: ep.replicas === 0 ? 'stopped' : ep.state, url: ep.url, replicas: ep.replicas, hardware: ep.hardware };
  }

  async scale(ref: EndpointRef, replicas: number, credentials: AdapterCredentials): Promise<void> {
    this.auth(credentials);
    const ep = this.endpoints.get(ref.id);
    if (!ep) throw Object.assign(new Error('endpoint not found'), { code: 'ADAPTER_NOT_FOUND', status: 404 });
    ep.replicas = replicas;
  }

  async teardown(ref: EndpointRef, credentials: AdapterCredentials): Promise<void> {
    this.auth(credentials);
    this.endpoints.delete(ref.id);
  }

  async costSnapshot(ref: EndpointRef, credentials: AdapterCredentials): Promise<CostSnapshot> {
    this.auth(credentials);
    const ep = this.endpoints.get(ref.id);
    const rate = this.options.centsPerHour ?? 120;
    if (!ep) return { spentCents: 0, ratePerHourCents: 0, observedAt: new Date() };
    // Deterministic: a cent per running replica per call, so tests can assert monotonic spend.
    ep.spentCents += ep.replicas;
    return { spentCents: ep.spentCents, ratePerHourCents: ep.replicas > 0 ? rate * ep.replicas : 0, observedAt: new Date() };
  }

  /** Test helper: make the provider forget an endpoint, as if deleted out of band. */
  vanish(id: string): void {
    this.endpoints.delete(id);
  }
}
