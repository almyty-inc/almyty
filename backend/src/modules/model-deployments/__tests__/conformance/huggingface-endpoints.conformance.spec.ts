import { HuggingFaceEndpointsAdapter } from '../../adapters/huggingface-endpoints.adapter';
import { liveRequested, runConformance } from './conformance.suite';
import { hfFixtureHttp } from './huggingface-endpoints.fixture';

/**
 * Fixture mode: the shared in-memory stand-in for the Inference Endpoints
 * v2 API, faithful to the documented paths, states, price list and error
 * codes. Live mode (CONFORMANCE_LIVE=huggingface-endpoints, HF_TOKEN +
 * HF_NAMESPACE in the local environment) runs the same cases against a
 * real account and is never run in CI.
 */
const live = liveRequested('huggingface-endpoints');
const fixture = hfFixtureHttp();
const adapter = () => (live ? new HuggingFaceEndpointsAdapter() : new HuggingFaceEndpointsAdapter(fixture.http));

const version = (registryUri: string) => ({ id: 'v', name: 'q', registryUri, base: 'qwen3-0.6b', quantizations: [], manifestSha: 's' });

runConformance(live ? 'huggingface-endpoints (LIVE)' : 'huggingface-endpoints (fixture)', {
  adapter,
  credentials: live ? { token: process.env.HF_TOKEN } : { token: 'hf_valid' },
  badCredentials: { token: 'hf_expired' },
  tinyVersion: { id: 'v1', name: 'qwen3-0.6b', registryUri: 'hf://Qwen/Qwen3-0.6B@main', base: 'qwen3-0.6b', quantizations: [], manifestSha: 'sha' },
  providerConfig: { token: live ? process.env.HF_TOKEN : 'hf_valid', namespace: live ? process.env.HF_NAMESPACE : 'almyty-test', instanceType: 'nvidia-t4' },
  quotaExceededConfig: live ? undefined : { token: 'hf_valid', namespace: 'almyty-test', instanceType: 'nvidia-h100-x8' },
  vanish: live ? undefined : (_adapter, ref) => { fixture.endpoints.delete(ref.name); },
  chat: live ? undefined : async () => 'fixture reply',
  readyTimeoutMs: live ? 15 * 60_000 : 5_000,
});

describe('huggingface-endpoints request shape', () => {
  const deploy = async (f: ReturnType<typeof hfFixtureHttp>, registryUri: string, providerConfig: Record<string, any> = {}, credentials: Record<string, any> = {}) =>
    new HuggingFaceEndpointsAdapter(f.http).deploy(
      {
        deploymentId: 'abc-123',
        organizationId: 'org',
        version: version(registryUri),
        desired: { replicas: 1, minScale: 0, maxScale: 2, region: 'eu-west-1' },
        providerConfig: { namespace: 'ns', ...providerConfig },
      },
      { token: 'hf_valid', ...credentials },
    );

  it('builds the endpoint from the Hub repository and revision, on the engine image', async () => {
    const f = hfFixtureHttp();
    const ref = await deploy(f, 'hf://Qwen/Qwen3-0.6B@abc123', { instanceType: 'nvidia-a10g' });
    const [url, body] = f.http.post.mock.calls[0];
    expect(url).toBe('https://api.endpoints.huggingface.cloud/v2/endpoint/ns');
    expect(body.name).toBe('almyty-abc123');
    // EndpointType is public | authenticated | private; there is no "protected".
    expect(body.type).toBe('authenticated');
    expect(body.provider).toEqual({ vendor: 'aws', region: 'eu-west-1' });
    expect(body.compute).toEqual({
      accelerator: 'gpu',
      instanceType: 'nvidia-a10g',
      instanceSize: 'x1',
      scaling: { minReplica: 0, maxReplica: 2, scaleToZeroTimeout: 15 },
    });
    expect(body.model).toEqual({
      repository: 'Qwen/Qwen3-0.6B',
      revision: 'abc123',
      framework: 'pytorch',
      task: 'text-generation',
      image: { vLLM: { url: 'vllm/vllm-openai:v0.23.0', port: 8000, healthRoute: '/health' } },
    });
    // Nothing about our object storage reaches Hugging Face any more.
    expect(JSON.stringify(body)).not.toMatch(/ALMYTY_REGISTRY_URI|AWS_ACCESS_KEY_ID|registry-placeholder/);
    expect(ref).toMatchObject({ namespace: 'ns', vendor: 'aws', region: 'eu-west-1', instanceType: 'nvidia-a10g', instanceSize: 'x1' });
  });

  it('omits the revision when the version does not pin one', async () => {
    const f = hfFixtureHttp();
    await deploy(f, 'hf://Qwen/Qwen3-0.6B');
    expect(f.http.post.mock.calls[0][1].model).not.toHaveProperty('revision');
  });

  it('passes a gated-repo token as the HF_TOKEN endpoint secret, and nowhere else', async () => {
    const f = hfFixtureHttp();
    await deploy(f, 'hf://meta-llama/Llama-3-8B@main', {}, { hubToken: 'hf_gated' });
    const body = f.http.post.mock.calls[0][1];
    expect(body.model.secrets).toEqual({ HF_TOKEN: 'hf_gated' });
    expect(JSON.stringify({ ...body, model: { ...body.model, secrets: undefined } })).not.toContain('hf_gated');
  });

  it('refuses an object-storage version before calling Hugging Face, naming what it accepts', async () => {
    const f = hfFixtureHttp();
    await expect(deploy(f, 's3://registry/models/q@etag')).rejects.toMatchObject({ code: 'ADAPTER_UNSUPPORTED_SOURCE' });
    await expect(deploy(f, 's3://registry/models/q@etag')).rejects.toThrow(/hf:\/\/owner\/repo/);
    expect(f.http.post).not.toHaveBeenCalled();
  });

  it('refuses a hub uri that is not owner/repo', async () => {
    const f = hfFixtureHttp();
    await expect(deploy(f, 'hf://gpt2')).rejects.toMatchObject({ code: 'ADAPTER_UNSUPPORTED_SOURCE' });
    expect(f.http.post).not.toHaveBeenCalled();
  });

  it('reports the OpenAI base under the endpoint host', async () => {
    const f = hfFixtureHttp();
    const ref = await deploy(f, 'hf://Qwen/Qwen3-0.6B@main');
    const actual = await new HuggingFaceEndpointsAdapter(f.http).readEndpoint(ref, { token: 'hf_valid' });
    expect(actual.state).toBe('ready');
    expect(actual.openAiBase).toBe('https://almyty-abc123.endpoints.huggingface.cloud/v1');
  });

  it('prices a replica from the published provider price list', async () => {
    const f = hfFixtureHttp();
    const a = new HuggingFaceEndpointsAdapter(f.http);
    const ref = await deploy(f, 'hf://Qwen/Qwen3-0.6B@main', { instanceType: 'nvidia-a10g' });
    // aws/eu-west-1/nvidia-a10g x1 is $1.00 per hour on the fixture's copy of GET /v2/provider.
    const running = await a.costSnapshot(ref, { token: 'hf_valid' });
    expect(running.ratePerHourCents).toBe(100);
    await a.scale(ref, 0, { token: 'hf_valid' });
    const stopped = await a.costSnapshot(ref, { token: 'hf_valid' });
    expect(stopped.ratePerHourCents).toBe(0);
  });

  it('maps every documented state', async () => {
    const f = hfFixtureHttp();
    const a = new HuggingFaceEndpointsAdapter(f.http);
    const ref = await deploy(f, 'hf://Qwen/Qwen3-0.6B@x');
    const ep = f.endpoints.get(ref.name);
    for (const [raw, expected] of Object.entries({ pending: 'deploying', initializing: 'deploying', updating: 'scaling', updateFailed: 'failed', running: 'ready', paused: 'stopped', scaledToZero: 'stopped', failed: 'failed' })) {
      ep.status.state = raw;
      const actual = await a.readEndpoint(ref, { token: 'hf_valid' });
      // The fixture flips initializing to running on read, like a real endpoint that came up.
      expect(actual.state).toBe(raw === 'initializing' ? 'ready' : expected);
    }
  });
});
