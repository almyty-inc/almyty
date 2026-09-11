import { DigitalOceanAdapter } from '../../adapters/digitalocean.adapter';
import { liveRequested, runConformance } from './conformance.suite';

/**
 * Fixture mode: an in-memory stand-in for the DigitalOcean Gradient AI
 * dedicated inference routes, faithful to the documented request body,
 * response envelope, status values and error shape. Live mode
 * (CONFORMANCE_LIVE=digitalocean with DIGITALOCEAN_TOKEN in the local
 * environment) runs the same cases against a real account; never in CI.
 */
function fixtureHttp() {
  const inferences = new Map<string, any>();
  let seq = 0;
  const error = (status: number, id: string, message: string) => Object.assign(new Error(String(status)), { response: { status, data: { id, message, request_id: 'req' } } });
  const authed = (config: any) => {
    if ((config?.headers?.Authorization ?? '') !== 'Bearer dop_v1_valid') throw error(401, 'unauthorized', 'Unable to authenticate you');
  };
  const route = (url: string) => url.match(/^https:\/\/api\.digitalocean\.com\/v2\/dedicated-inferences(?:\/([^/]+))?$/);
  const check = (spec: any) => {
    const deployment = spec?.model_deployments?.[0];
    if (String(deployment?.model_slug ?? '').includes('unsupported')) {
      throw error(422, 'unprocessable_entity', 'The model architecture is not supported by dedicated inference.');
    }
    if (String(deployment?.accelerators?.[0]?.accelerator_slug ?? '').includes('x8-')) {
      throw error(422, 'unprocessable_entity', 'You have reached your GPU limit. Please contact support to raise it.');
    }
  };
  const http = {
    post: jest.fn(async (url: string, body: any, config: any) => {
      authed(config);
      const m = route(url);
      if (!m || m[1]) throw error(404, 'not_found', 'not found');
      check(body.spec);
      const id = `di-${++seq}`;
      const inference = {
        id,
        status: 'provisioning',
        region: body.spec.region,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        endpoints: {},
        spec: body.spec,
      };
      inferences.set(id, inference);
      return { status: 202, data: { dedicated_inference: inference, token: { value: `di_${id}_token`, id: `tok-${id}`, name: 'first-token', is_managed: false } } };
    }),
    get: jest.fn(async (url: string, config: any) => {
      authed(config);
      const m = route(url);
      const inference = m?.[1] ? inferences.get(m[1]) : undefined;
      if (!inference) throw error(404, 'not_found', 'The resource you were accessing could not be found.');
      // Provisioning finishes and the endpoints appear on the first read,
      // like a cluster that came up.
      if (inference.status === 'provisioning' || inference.status === 'updating') {
        inference.status = 'active';
        inference.endpoints = {
          public_endpoint_fqdn: `https://${inference.id}-public-dedicated-inference.do-infra.ai`,
          private_endpoint_fqdn: `https://${inference.id}-private-dedicated-inference.do-infra.ai`,
        };
      }
      return { data: { dedicated_inference: inference } };
    }),
    patch: jest.fn(async (url: string, body: any, config: any) => {
      authed(config);
      const m = route(url);
      const inference = m?.[1] ? inferences.get(m[1]) : undefined;
      if (!inference) throw error(404, 'not_found', 'The resource you were accessing could not be found.');
      check(body.spec);
      inference.spec = body.spec;
      inference.status = 'updating';
      inference.updated_at = new Date().toISOString();
      return { status: 202, data: { dedicated_inference: inference } };
    }),
    delete: jest.fn(async (url: string, config: any) => {
      authed(config);
      const m = route(url);
      if (!m?.[1] || !inferences.delete(m[1])) throw error(404, 'not_found', 'The resource you were accessing could not be found.');
      return { status: 204, data: '' };
    }),
  } as any;
  return { inferences, http };
}

const live = liveRequested('digitalocean');
const fixture = fixtureHttp();
const adapter = () => (live ? new DigitalOceanAdapter() : new DigitalOceanAdapter(fixture.http));
const tiny = { id: 'v1', name: 'qwen3-0.6b', registryUri: 'hf://Qwen/Qwen3-0.6B@main', base: 'qwen3-0.6b', quantizations: [], manifestSha: 'sha' };

runConformance(live ? 'digitalocean (LIVE)' : 'digitalocean (fixture)', {
  adapter,
  credentials: live ? { token: process.env.DIGITALOCEAN_TOKEN } : { token: 'dop_v1_valid' },
  badCredentials: { token: 'dop_v1_expired' },
  tinyVersion: tiny,
  providerConfig: { region: live ? process.env.DIGITALOCEAN_REGION ?? 'atl1' : 'atl1', acceleratorSlug: 'gpu-mi300x1-192gb', hourlyRateCents: 259 },
  unsupportedArchitectureVersion: live ? undefined : { ...tiny, id: 'v2', registryUri: 'hf://acme/unsupported-arch' },
  quotaExceededConfig: live ? undefined : { region: 'atl1', acceleratorSlug: 'gpu-mi300x8-1536gb' },
  vanish: live ? undefined : (_a, ref) => { fixture.inferences.delete(ref.dedicatedInferenceId); },
  chat: live ? undefined : async () => 'fixture reply',
  readyTimeoutMs: live ? 30 * 60_000 : 5_000,
});

describe('digitalocean request shape', () => {
  const request = {
    deploymentId: 'abc-123',
    organizationId: 'org',
    version: tiny,
    desired: { replicas: 2, minScale: 1, maxScale: 2, region: 'tor1', hardware: 'gpu-h100x1-80gb' },
    providerConfig: { vpcUuid: 'vpc-1', hourlyRateCents: 441 },
  };
  const creds = { token: 'dop_v1_valid', hfToken: 'hf_x' };

  it('creates one dedicated inference that points at the Hugging Face repository', async () => {
    const f = fixtureHttp();
    const a = new DigitalOceanAdapter(f.http);
    const ref = await a.deploy(request, creds);
    const [url, body] = f.http.post.mock.calls[0];
    expect(url).toBe('https://api.digitalocean.com/v2/dedicated-inferences');
    expect(body).toEqual({
      spec: {
        version: 1,
        name: 'almyty-abc123',
        region: 'tor1',
        vpc: { uuid: 'vpc-1' },
        enable_public_endpoint: true,
        model_deployments: [
          {
            model_slug: 'Qwen/Qwen3-0.6B',
            model_provider: 'hugging_face',
            workload_config: {},
            accelerators: [{ scale: 2, type: 'prefill_decode', accelerator_slug: 'gpu-h100x1-80gb' }],
          },
        ],
      },
      access_tokens: { hugging_face_token: 'hf_x' },
    });
    expect(ref).toMatchObject({ name: 'almyty-abc123', region: 'tor1', modelSlug: 'Qwen/Qwen3-0.6B', scale: 2, endpointToken: expect.stringContaining('di_') });
    // No cloud-init, no droplet, no registry credentials anywhere near it.
    expect(JSON.stringify(body)).not.toContain('cloud-config');
    expect(JSON.stringify(body)).not.toContain('AWS_');
  });

  it('serves a model imported through BYOM when the operator names it', async () => {
    const f = fixtureHttp();
    const a = new DigitalOceanAdapter(f.http);
    await a.deploy(
      { ...request, version: { ...tiny, registryUri: 's3://registry/models/q@etag' }, providerConfig: { modelSlug: 'my-team/finetuned-qwen3', modelProvider: 'digital_ocean' } },
      { token: 'dop_v1_valid' },
    );
    const deployment = f.http.post.mock.calls[0][1].spec.model_deployments[0];
    expect(deployment).toMatchObject({ model_slug: 'my-team/finetuned-qwen3', model_provider: 'digital_ocean' });
    // No Hugging Face token was supplied, so no access_tokens block.
    expect(f.http.post.mock.calls[0][1].access_tokens).toBeUndefined();
  });

  it('refuses a registry source DigitalOcean cannot read, naming what it accepts', async () => {
    const f = fixtureHttp();
    const a = new DigitalOceanAdapter(f.http);
    await expect(
      a.deploy({ ...request, version: { ...tiny, registryUri: 's3://registry/models/q@etag' }, providerConfig: {} }, creds),
    ).rejects.toMatchObject({ code: 'ADAPTER_UNSUPPORTED_SOURCE', message: expect.stringContaining('hf://org/repo') });
    expect(f.http.post).not.toHaveBeenCalled();
  });

  it('says the preview has to be enabled, rather than blaming the token', async () => {
    // Dedicated Inference is a public preview an account opts into. A
    // token that works everywhere else on the API is still refused here
    // until then, so the customer must be sent to the Feature Preview
    // page and not off to check a key that is fine.
    const f = fixtureHttp();
    f.http.post.mockRejectedValueOnce(
      Object.assign(new Error('403'), { response: { status: 403, data: { id: 'forbidden', message: 'dedicated inference is not enabled for this account' } } }),
    );
    const a = new DigitalOceanAdapter(f.http);
    await expect(a.deploy(request, creds)).rejects.toMatchObject({
      code: 'ADAPTER_PREVIEW_NOT_ENABLED',
      message: expect.stringContaining('Feature Preview'),
    });
  });

  it('still blames the token on a plain 401', async () => {
    const f = fixtureHttp();
    const a = new DigitalOceanAdapter(f.http);
    await expect(a.deploy(request, { ...creds, token: 'nope' })).rejects.toMatchObject({ code: 'ADAPTER_AUTH' });
  });

  it('declares itself a public preview, so the form can say so before anything is created', () => {
    const caps = new DigitalOceanAdapter(fixtureHttp().http).capabilities();
    expect(caps.availability).toBe('public_preview');
    expect(caps.availabilityNote).toMatch(/Feature Preview/);
  });

  it('reads the OpenAI base off the public endpoint, rescales by patching the spec back, and tears down', async () => {
    const f = fixtureHttp();
    const a = new DigitalOceanAdapter(f.http);
    const ref = await a.deploy(request, creds);
    const ready = await a.readEndpoint(ref, creds);
    expect(ready.state).toBe('ready');
    expect(ready.url).toBe(`https://${ref.dedicatedInferenceId}-public-dedicated-inference.do-infra.ai/v1`);
    expect(ready.openAiBase).toBe(ready.url);
    expect(ready.replicas).toBe(2);
    expect((await a.costSnapshot(ref, creds)).ratePerHourCents).toBe(882);

    await a.scale(ref, 1, creds);
    const [patchUrl, patchBody] = f.http.patch.mock.calls[0];
    expect(patchUrl).toBe(`https://api.digitalocean.com/v2/dedicated-inferences/${ref.dedicatedInferenceId}`);
    expect(patchBody.spec.model_deployments[0].accelerators[0].scale).toBe(1);
    expect((await a.costSnapshot(ref, creds)).ratePerHourCents).toBe(441);

    await a.scale(ref, 0, creds);
    expect((await a.readEndpoint(ref, creds)).state).toBe('stopped');

    await a.teardown(ref, creds);
    expect(f.http.delete.mock.calls[0][0]).toBe(`https://api.digitalocean.com/v2/dedicated-inferences/${ref.dedicatedInferenceId}`);
    expect((await a.readEndpoint(ref, creds)).state).toBe('missing');
  });

  it('maps a rejected architecture and a GPU limit to their own error codes', async () => {
    const f = fixtureHttp();
    const a = new DigitalOceanAdapter(f.http);
    await expect(a.deploy({ ...request, version: { ...tiny, registryUri: 'hf://acme/unsupported-arch' } }, creds)).rejects.toMatchObject({
      code: 'ADAPTER_UNSUPPORTED_ARCHITECTURE',
    });
    await expect(a.deploy({ ...request, desired: { ...request.desired, hardware: 'gpu-mi300x8-1536gb' } }, creds)).rejects.toMatchObject({
      code: 'ADAPTER_QUOTA_EXCEEDED',
    });
  });
});
