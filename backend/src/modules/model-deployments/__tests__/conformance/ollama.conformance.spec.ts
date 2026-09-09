import { OllamaAdapter } from '../../adapters/ollama.adapter';
import { liveRequested, runConformance } from './conformance.suite';

/**
 * Fixture mode: an in-memory Ollama server (pull, create, copy, tags, ps,
 * generate keep_alive, delete) behind a proxy that checks a bearer token.
 * Live mode (CONFORMANCE_LIVE=ollama, OLLAMA_URL and OLLAMA_TOKEN set,
 * the server behind an auth proxy) runs the same cases for real.
 */
function fixtureServer() {
  const models = new Map<string, { size: number }>();
  const loaded = new Set<string>();
  const authed = (config: any) => {
    if ((config?.headers?.Authorization ?? '') !== 'Bearer ollama_valid') {
      throw Object.assign(new Error('401'), { response: { status: 401, data: { error: 'unauthorized' } } });
    }
  };
  const path = (url: string) => url.replace(/^https?:\/\/[^/]+/, '');
  return {
    models,
    loaded,
    http: {
      post: jest.fn(async (url: string, body: any, config: any) => {
        authed(config);
        switch (path(url)) {
          case '/api/pull':
            if (/huge/.test(body.model)) throw Object.assign(new Error('500'), { response: { status: 500, data: { error: 'write /root/.ollama/models: no space left on device' } } });
            models.set(body.model, { size: 400_000_000 });
            return { data: { status: 'success' } };
          case '/api/create':
            models.set(body.model, { size: 400_000_000 });
            return { data: { status: 'success' } };
          case '/api/copy':
            if (/huge/.test(body.destination)) throw Object.assign(new Error('500'), { response: { status: 500, data: { error: 'write /root/.ollama/models: no space left on device' } } });
            if (!models.has(body.source))
 throw Object.assign(new Error('404'), { response: { status: 404, data: { error: 'model not found' } } });
            models.set(body.destination, models.get(body.source)!);
            return { data: {} };
          case '/api/generate':
            if (!models.has(body.model)) throw Object.assign(new Error('404'), { response: { status: 404, data: { error: `model '${body.model}' not found` } } });
            if (body.keep_alive === 0 || body.keep_alive === '0') loaded.delete(body.model);
            else loaded.add(body.model);
            return { data: { model: body.model, done: true } };
          default:
            throw Object.assign(new Error('404'), { response: { status: 404 } });
        }
      }),
      get: jest.fn(async (url: string, config: any) => {
        authed(config);
        switch (path(url)) {
          case '/api/tags':
            return { data: { models: [...models.entries()].map(([name, m]) => ({ name, model: name, size: m.size, details: { family: 'qwen3', quantization_level: 'Q4_K_M' } })) } };
          case '/api/ps':
            return { data: { models: [...loaded].map((name) => ({ name, model: name, size_vram: 500_000_000, expires_at: '2099-01-01T00:00:00Z' })) } };
          default:
            throw Object.assign(new Error('404'), { response: { status: 404 } });
        }
      }),
      delete: jest.fn(async (url: string, config: any) => {
        authed(config);
        const name = config?.data?.model;
        if (!models.delete(name)) throw Object.assign(new Error('404'), { response: { status: 404, data: { error: 'model not found' } } });
        loaded.delete(name);
        return { data: {} };
      }),
    } as any,
  };
}

const live = liveRequested('ollama');
const fixture = fixtureServer();
const adapter = () => (live ? new OllamaAdapter() : new OllamaAdapter(fixture.http));
const baseUrl = live ? process.env.OLLAMA_URL ?? 'http://localhost:11434' : 'http://ollama.fixture:11434';

runConformance(live ? 'ollama (LIVE)' : 'ollama (fixture)', {
  adapter,
  credentials: { token: live ? process.env.OLLAMA_TOKEN : 'ollama_valid' },
  badCredentials: { token: 'ollama_expired' },
  tinyVersion: { id: 'v1', name: 'qwen3-0.6b', registryUri: 'hf://Qwen/Qwen3-0.6B-GGUF@main', base: 'qwen3-0.6b', quantizations: ['Q4_K_M'], manifestSha: 'sha' },
  providerConfig: { baseUrl, keepAlive: '-1', hourlyRateCents: 30 },
  quotaExceededConfig: live ? undefined : { baseUrl, tag: 'huge-model' },
  vanish: live ? undefined : (_adapter, ref) => { fixture.models.delete(ref.model); fixture.loaded.delete(ref.model); },
  chat: live ? undefined : async () => 'fixture reply',
  readyTimeoutMs: live ? 10 * 60_000 : 5_000,
});

describe('ollama sources', () => {
  const req = (registryUri: string, providerConfig: Record<string, any> = {}, quantization?: string) => ({
    deploymentId: 'd', organizationId: 'o', desired: { replicas: 1, quantization }, providerConfig,
    version: { id: 'v', name: 'My Model v2', registryUri, base: 'qwen3', quantizations: [], manifestSha: null },
  });

  it('pulls Hub GGUF repos through hf.co, with the quantization as the tag suffix', () => {
    expect(OllamaAdapter.source(req('hf://Qwen/Qwen3-0.6B-GGUF@main', {}, 'Q8_0'))).toEqual({ model: 'hf.co/Qwen/Qwen3-0.6B-GGUF:Q8_0', pull: 'hf.co/Qwen/Qwen3-0.6B-GGUF:Q8_0' });
  });

  it('creates from a host path for file://', () => {
    expect(OllamaAdapter.source(req('file:///models/q.gguf@sha'))).toEqual({ model: 'my-model-v2', from: '/models/q.gguf' });
  });

  it('refuses an s3:// version outright: Ollama reads the Hub or its own host, and almyty never ships the weights', () => {
    expect(() => OllamaAdapter.source(req('s3://registry/team/q.gguf@etag'))).toThrow(expect.objectContaining({ code: 'ADAPTER_UNSUPPORTED_SOURCE' }));
    expect(() => OllamaAdapter.source(req('s3://registry/team/q.gguf@etag', { registryMirrorPath: '/mnt/registry/' }))).toThrow(expect.objectContaining({ code: 'ADAPTER_UNSUPPORTED_SOURCE' }));
  });

  it('after deploy the model is loaded; scale(0) unloads it and the burn rate drops to zero', async () => {
    const a = new OllamaAdapter(fixture.http);
    const ref = await a.deploy(req('hf://Qwen/Qwen3-0.6B-GGUF@main', { baseUrl, hourlyRateCents: 30 }) as any, { token: 'ollama_valid' });
    expect(ref.url).toBe(`${baseUrl}/v1`);
    expect((await a.readEndpoint(ref, { token: 'ollama_valid' })).state).toBe('ready');
    expect((await a.costSnapshot(ref, { token: 'ollama_valid' })).ratePerHourCents).toBe(30);
    await a.scale(ref, 0, { token: 'ollama_valid' });
    expect((await a.readEndpoint(ref, { token: 'ollama_valid' })).state).toBe('stopped');
    expect((await a.costSnapshot(ref, { token: 'ollama_valid' })).ratePerHourCents).toBe(0);
    await a.teardown(ref, { token: 'ollama_valid' });
  });
});
