import { DigitalOceanAdapter } from '../../adapters/digitalocean.adapter';
import { liveRequested, runConformance } from './conformance.suite';

/**
 * Fixture mode: an in-memory stand-in for the DigitalOcean API v2 droplet
 * routes and for the vLLM /v1/models probe on the droplet, faithful to the
 * documented bodies, statuses and error envelopes. Live mode
 * (CONFORMANCE_LIVE=digitalocean with DIGITALOCEAN_TOKEN in the local
 * environment) runs the same cases against a real account; never in CI.
 */
function fixtureHttp() {
  const droplets = new Map<number, any>();
  let seq = 1000;
  const error = (status: number, id: string, message: string) => Object.assign(new Error(String(status)), { response: { status, data: { id, message, request_id: 'req' } } });
  const authed = (config: any) => {
    if ((config?.headers?.Authorization ?? '') !== 'Bearer dop_v1_valid') throw error(401, 'unauthorized', 'Unable to authenticate you');
  };
  const route = (url: string) => url.match(/^https:\/\/api\.digitalocean\.com\/v2\/droplets(?:\/(\d+))?(?:\/(actions))?$/);
  const probe = (url: string) => url.match(/^http:\/\/([\d.]+):8000\/v1\/models$/);
  const http = {
    post: jest.fn(async (url: string, body: any, config: any) => {
      authed(config);
      const m = route(url);
      if (m && !m[1]) {
        if (body.size === 'gpu-h100x8-640gb') throw error(422, 'unprocessable_entity', 'You have reached your droplet limit. Please contact support to raise it.');
        const id = ++seq;
        const droplet = {
          id,
          name: body.name,
          status: 'new',
          size_slug: body.size,
          size: { slug: body.size, price_hourly: 3.39 },
          region: { slug: body.region },
          image: { slug: body.image },
          networks: { v4: [] },
          tags: body.tags,
          powered: true,
        };
        droplets.set(id, droplet);
        return { status: 202, data: { droplet } };
      }
      if (m && m[1] && m[2] === 'actions') {
        const droplet = droplets.get(Number(m[1]));
        if (!droplet) throw error(404, 'not_found', 'The resource you were accessing could not be found.');
        if (body.type === 'power_off') { droplet.status = 'off'; droplet.powered = false; }
        if (body.type === 'power_on') { droplet.status = 'active'; droplet.powered = true; }
        return { status: 201, data: { action: { id: 1, status: 'completed', type: body.type } } };
      }
      throw error(404, 'not_found', 'not found');
    }),
    get: jest.fn(async (url: string, config: any) => {
      const p = probe(url);
      if (p) {
        const droplet = [...droplets.values()].find((d) => d.networks.v4.some((n: any) => n.ip_address === p[1]));
        if (!droplet || !droplet.powered) throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
        return { data: { object: 'list', data: [{ id: 'model', object: 'model' }] } };
      }
      authed(config);
      const m = route(url);
      const droplet = m?.[1] ? droplets.get(Number(m[1])) : undefined;
      if (!droplet) throw error(404, 'not_found', 'The resource you were accessing could not be found.');
      // The droplet comes up with a public address on the first read, like one that finished booting.
      if (droplet.status === 'new') {
        droplet.status = 'active';
        droplet.networks.v4 = [{ ip_address: '10.0.0.5', type: 'private' }, { ip_address: `203.0.113.${droplet.id % 250}`, type: 'public' }];
      }
      return { data: { droplet } };
    }),
    delete: jest.fn(async (url: string, config: any) => {
      authed(config);
      const m = route(url);
      if (!m?.[1] || !droplets.delete(Number(m[1]))) throw error(404, 'not_found', 'The resource you were accessing could not be found.');
      return { status: 204, data: '' };
    }),
  } as any;
  return { droplets, http };
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
  providerConfig: { region: live ? process.env.DIGITALOCEAN_REGION ?? 'nyc2' : 'nyc2', size: 'gpu-h100x1-80gb' },
  quotaExceededConfig: live ? undefined : { region: 'nyc2', size: 'gpu-h100x8-640gb' },
  vanish: live ? undefined : (_a, ref) => { fixture.droplets.delete(ref.dropletId); },
  chat: live ? undefined : async () => 'fixture reply',
  readyTimeoutMs: live ? 20 * 60_000 : 5_000,
});

describe('digitalocean request shape', () => {
  const s3Request = {
    deploymentId: 'abc-123',
    organizationId: 'org',
    version: { id: 'v', name: 'q', registryUri: 's3://registry/models/q@etag', base: 'qwen3-0.6b', quantizations: [], manifestSha: 's' },
    desired: { replicas: 1, minScale: 0, maxScale: 1, region: 'tor1', hardware: 'gpu-l40sx1-48gb', quantization: 'awq' },
    providerConfig: { registryEndpoint: 'https://minio.local', sshKeys: ['aa:bb'], vpcUuid: 'vpc-1', maxModelLen: 4096 },
  };
  const creds = { token: 'dop_v1_valid', registryAccessKeyId: 'AK', registrySecretAccessKey: 'SK' };

  it('creates one GPU droplet whose cloud-init syncs the registry version and starts vLLM on 8000', async () => {
    const f = fixtureHttp();
    const a = new DigitalOceanAdapter(f.http);
    const ref = await a.deploy(s3Request, creds);
    const [url, body] = f.http.post.mock.calls[0];
    expect(url).toBe('https://api.digitalocean.com/v2/droplets');
    expect(body).toMatchObject({
      name: 'almyty-abc123',
      region: 'tor1',
      size: 'gpu-l40sx1-48gb',
      image: 'gpu-h100x1-base',
      ssh_keys: ['aa:bb'],
      vpc_uuid: 'vpc-1',
      monitoring: true,
      tags: ['almyty', 'almyty-deployment:abc-123'],
    });
    const userData: string = body.user_data;
    expect(userData.startsWith('#cloud-config\n')).toBe(true);
    expect(userData).toContain('AWS_ACCESS_KEY_ID=AK');
    expect(userData).toContain('AWS_SECRET_ACCESS_KEY=SK');
    expect(userData).toContain("permissions: '0600'");
    expect(userData).toContain('amazon/aws-cli s3 sync --endpoint-url https://minio.local s3://registry/models/q /model');
    expect(userData).toContain('vllm/vllm-openai:latest --model /model --served-model-name q --quantization awq --max-model-len 4096 --port 8000');
    expect(userData).toContain('-p 8000:8000');
    // Secrets are only in the env file block, never on the docker command line.
    const runLine = userData.split('\n').find((l) => l.includes('docker run -d'))!;
    expect(runLine).not.toContain('SK');
    expect(userData.length).toBeLessThan(64 * 1024);
    expect(ref).toMatchObject({ name: 'almyty-abc123', region: 'tor1', size: 'gpu-l40sx1-48gb', hourlyRateCents: 339 });
    expect(JSON.stringify(ref)).not.toContain('SK');
  });

  it('pulls a hub version straight from the Hub with the HF token in the env file only', async () => {
    const f = fixtureHttp();
    const a = new DigitalOceanAdapter(f.http);
    await a.deploy({ ...s3Request, version: tiny, desired: {}, providerConfig: {} }, { token: 'dop_v1_valid', hfToken: 'hf_x' });
    const userData: string = f.http.post.mock.calls[0][1].user_data;
    expect(userData).toContain('HF_TOKEN=hf_x');
    expect(userData).not.toContain('aws-cli');
    expect(userData).toContain('--model Qwen/Qwen3-0.6B --revision main --served-model-name qwen3-0.6b --port 8000');
  });

  it('reads the endpoint from the public address plus the vLLM probe, powers off and on, refuses a second replica', async () => {
    const f = fixtureHttp();
    const a = new DigitalOceanAdapter(f.http);
    const ref = await a.deploy(s3Request, creds);
    const ready = await a.readEndpoint(ref, creds);
    expect(ready.state).toBe('ready');
    expect(ready.url).toMatch(/^http:\/\/203\.0\.113\.\d+:8000\/v1$/);
    expect(f.http.get.mock.calls.some((c) => c[0] === `${ready.url}/models`)).toBe(true);
    expect((await a.costSnapshot(ref, creds)).ratePerHourCents).toBe(339);

    await a.scale(ref, 0, creds);
    expect(f.http.post.mock.calls[1][1]).toEqual({ type: 'power_off' });
    const off = await a.readEndpoint(ref, creds);
    expect(off.state).toBe('stopped');
    // Powered off still costs the full rate on DigitalOcean.
    expect((await a.costSnapshot(ref, creds)).ratePerHourCents).toBe(339);

    await a.scale(ref, 1, creds);
    expect(f.http.post.mock.calls[2][1]).toEqual({ type: 'power_on' });
    expect((await a.readEndpoint(ref, creds)).state).toBe('ready');
    await expect(a.scale(ref, 2, creds)).rejects.toMatchObject({ code: 'ADAPTER_UNSUPPORTED_OPERATION' });
    await expect(a.deploy({ ...s3Request, desired: { replicas: 2 } }, creds)).rejects.toMatchObject({ code: 'ADAPTER_UNSUPPORTED_OPERATION' });
  });

  it('reports an active droplet whose vLLM is not up yet as deploying', async () => {
    const f = fixtureHttp();
    const a = new DigitalOceanAdapter(f.http);
    const ref = await a.deploy(s3Request, creds);
    await a.readEndpoint(ref, creds);
    const droplet = f.droplets.get(ref.dropletId);
    droplet.powered = false;
    droplet.status = 'active';
    const actual = await a.readEndpoint(ref, creds);
    expect(actual.state).toBe('deploying');
    expect(actual.message).toContain('vLLM');
  });
});
