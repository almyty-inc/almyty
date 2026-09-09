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
 * A thin wrapper for an OpenAI-compatible server somebody else runs
 * (vLLM, TGI, llama.cpp, LiteLLM proxy, a vendor). It cannot deploy,
 * scale or tear anything down; it exists so the reconcile loop can watch
 * such an endpoint and the catalog can price it like every other card.
 * Registering one goes through POST /models/register-endpoint.
 */
export class CustomEndpointAdapter implements ModelProviderAdapter {
  readonly key = 'custom-endpoint';
  readonly displayName = 'OpenAI-compatible endpoint (managed elsewhere)';

  constructor(private readonly http: AxiosInstance = axios.create({ timeout: 15_000 })) {}

  capabilities(): AdapterCapabilities {
    return {
      architectures: 'any',
      lora: 'none',
      serverless: false,
      dedicated: false,
      scaleToZero: false,
      regions: [],
      registrySources: ['s3', 'hub', 'local'],
    };
  }

  configSchema(): Record<string, any> {
    return {
      type: 'object',
      properties: {
        url: { type: 'string', title: 'Base URL', description: 'The part before /chat/completions' },
        apiKey: { type: 'string', title: 'API key', 'x-secret': true },
        model: { type: 'string', title: 'Model id sent on the wire' },
        inPerMTok: { type: 'number', title: 'Input price per million tokens (USD)' },
        outPerMTok: { type: 'number', title: 'Output price per million tokens (USD)' },
        hourlyRateCents: { type: 'integer', title: 'Machine price per hour (cents)' },
      },
      required: ['url'],
    };
  }

  private headers(credentials: AdapterCredentials): Record<string, string> {
    return { ...(credentials.apiKey ? { Authorization: `Bearer ${credentials.apiKey}` } : {}) };
  }

  async deploy(_request: DeployRequest, _credentials: AdapterCredentials): Promise<EndpointRef> {
    throw new UnsupportedOperationError(this.key, 'deploy');
  }

  /** The endpoint is ready when /models answers and, if a model id is set, lists it. */
  async readEndpoint(ref: EndpointRef, credentials: AdapterCredentials): Promise<ActualState> {
    const url = String(ref.url ?? '').replace(/\/+$/, '');
    if (!url) return { state: 'failed', message: 'no url' };
    try {
      const res = await this.http.get(`${url}/models`, { headers: this.headers(credentials) });
      const ids = (res.data?.data ?? []).map((m: any) => m.id);
      if (ref.model && ids.length > 0 && !ids.includes(ref.model)) {
        return { state: 'missing', url, message: `model ${ref.model} is not served`, details: { served: ids.slice(0, 20) } };
      }
      return { state: 'ready', url, replicas: 1, details: { served: ids.slice(0, 20) } };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 401 || status === 403) throw Object.assign(new Error('credential rejected'), { code: 'ADAPTER_AUTH', status });
      if (status === 404) return { state: 'ready', url, replicas: 1, message: 'no /models route; assumed up' };
      return { state: 'degraded', url, message: err?.message ?? 'unreachable' };
    }
  }

  async scale(_ref: EndpointRef, _replicas: number, _credentials: AdapterCredentials): Promise<void> {
    throw new UnsupportedOperationError(this.key, 'scale');
  }

  async teardown(_ref: EndpointRef, _credentials: AdapterCredentials): Promise<void> {
    throw new UnsupportedOperationError(this.key, 'teardown');
  }

  async costSnapshot(ref: EndpointRef, _credentials: AdapterCredentials): Promise<CostSnapshot> {
    return {
      spentCents: 0,
      ratePerHourCents: Number(ref.hourlyRateCents ?? 0),
      ...(ref.inPerMTok != null && ref.outPerMTok != null ? { perToken: { inPerMTok: Number(ref.inPerMTok), outPerMTok: Number(ref.outPerMTok), currency: 'USD' } } : {}),
      observedAt: new Date(),
    };
  }
}
