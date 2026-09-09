import { generateKeyPairSync } from 'crypto';

import { NebiusAdapter } from '../../adapters/nebius.adapter';
import { liveRequested, runConformance } from './conformance.suite';

/**
 * Fixture mode: an in-memory stand-in for the Nebius REST gateway
 * (compute/v1 disks and instances with Operation replies), the IAM token
 * exchange, and the vLLM /v1/models probe on the VM, faithful to the
 * documented paths, bodies and instance states. Live mode
 * (CONFORMANCE_LIVE=nebius with NEBIUS_SA_ID, NEBIUS_KEY_ID,
 * NEBIUS_PRIVATE_KEY, NEBIUS_PARENT_ID, NEBIUS_SUBNET_ID in the local
 * environment) runs the same cases against a real project; never in CI.
 */
const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_KEY = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function fixtureHttp() {
  const disks = new Map<string, any>();
  const instances = new Map<string, any>();
  let seq = 0;
  const error = (status: number, message: string, code = 0) => Object.assign(new Error(String(status)), { response: { status, data: { code, message } } });
  const authed = (config: any) => {
    if ((config?.headers?.Authorization ?? '') !== 'Bearer iam-valid') throw error(401, 'UNAUTHENTICATED: invalid token', 16);
  };
  const route = (url: string) => url.match(/^https:\/\/api\.eu\.nebius\.cloud\/compute\/v1\/(disks|instances)(?:\/([^/:]+))?(?::(start|stop))?$/);
  const probe = (url: string) => url.match(/^http:\/\/([\d.]+):8000\/v1\/models$/);
  const http = {
    post: jest.fn(async (url: string, body: any, config: any) => {
      if (url === 'https://auth.eu.nebius.com/oauth2/token/exchange') {
        const form = new URLSearchParams(String(body));
        if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:token-exchange' || form.get('subject_token_type') !== 'urn:ietf:params:oauth:token-type:jwt') {
          throw error(400, 'invalid_request');
        }
        const [header, payload] = String(form.get('subject_token')).split('.');
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
        const kid = JSON.parse(Buffer.from(header, 'base64url').toString()).kid;
        if (claims.iss !== 'serviceaccount-valid' || claims.sub !== claims.iss || kid !== 'publickey-1' || claims.exp <= Date.now() / 1000) {
          throw Object.assign(new Error('401'), { response: { status: 401, data: { error: 'invalid_grant', error_description: 'service account key revoked' } } });
        }
        return { data: { access_token: 'iam-valid', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 43_200 } };
      }
      authed(config);
      const m = route(url);
      if (m?.[1] === 'disks' && !m[2]) {
        const id = `computedisk-${++seq}`;
        disks.set(id, { metadata: { id, ...body.metadata }, spec: body.spec, status: { state: 'READY' } });
        return { data: { id: `op-${seq}`, resourceId: id, done: false } };
      }
      if (m?.[1] === 'instances' && !m[2]) {
        if (!disks.has(body.spec?.bootDisk?.existingDisk?.id)) throw error(404, 'NOT_FOUND: disk', 5);
        if (body.spec?.resources?.preset === '8gpu-128vcpu-1600gb') throw error(429, 'RESOURCE_EXHAUSTED: quota exceeded for gpu-h100-sxm', 8);
        const id = `computeinstance-${++seq}`;
        instances.set(id, { metadata: { id, ...body.metadata }, spec: body.spec, status: { state: 'CREATING', networkInterfaces: [] }, powered: true });
        return { data: { id: `op-${seq}`, resourceId: id, done: false } };
      }
      if (m?.[1] === 'instances' && m[2] && m[3]) {
        const inst = instances.get(m[2]);
        if (!inst) throw error(404, 'NOT_FOUND: instance', 5);
        if (m[3] === 'stop') { inst.status.state = 'STOPPED'; inst.powered = false; }
        if (m[3] === 'start') { inst.status.state = 'RUNNING'; inst.powered = true; }
        return { data: { id: `op-${++seq}`, resourceId: m[2], done: true } };
      }
      throw error(404, 'NOT_FOUND', 5);
    }),
    get: jest.fn(async (url: string, config: any) => {
      const p = probe(url);
      if (p) {
        const inst = [...instances.values()].find((i) => i.status.networkInterfaces[0]?.publicIpAddress?.address === p[1]);
        if (!inst || !inst.powered) throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
        return { data: { object: 'list', data: [{ id: 'model', object: 'model' }] } };
      }
      authed(config);
      const m = route(url);
      if (m?.[1] === 'disks' && m[2]) {
        const disk = disks.get(m[2]);
        if (!disk) throw error(404, 'NOT_FOUND: disk', 5);
        return { data: disk };
      }
      if (m?.[1] === 'instances' && m[2]) {
        const inst = instances.get(m[2]);
        if (!inst) throw error(404, 'NOT_FOUND: instance', 5);
        // The instance comes up with a public address on the first read, like one that finished booting.
        if (inst.status.state === 'CREATING') {
          inst.status.state = 'RUNNING';
          inst.status.networkInterfaces = [{ name: 'eth0', ipAddress: { address: '192.168.0.10' }, publicIpAddress: { address: `198.51.100.${seq % 250}` } }];
        }
        return { data: inst };
      }
      throw error(404, 'NOT_FOUND', 5);
    }),
    delete: jest.fn(async (url: string, config: any) => {
      authed(config);
      const m = route(url);
      if (m?.[1] === 'instances' && m[2]) {
        if (!instances.delete(m[2])) throw error(404, 'NOT_FOUND: instance', 5);
        return { data: { id: `op-${++seq}`, resourceId: m[2], done: false } };
      }
      if (m?.[1] === 'disks' && m[2]) {
        if (!disks.delete(m[2])) throw error(404, 'NOT_FOUND: disk', 5);
        return { data: { id: `op-${++seq}`, resourceId: m[2], done: false } };
      }
      throw error(404, 'NOT_FOUND', 5);
    }),
  } as any;
  return { disks, instances, http };
}

const live = liveRequested('nebius');
const fixture = fixtureHttp();
const adapter = () => (live ? new NebiusAdapter() : new NebiusAdapter(fixture.http, { timeoutMs: 2_000, pollMs: 10 }));
const env = process.env;
const tiny = { id: 'v1', name: 'qwen3-0.6b', registryUri: 'hf://Qwen/Qwen3-0.6B@main', base: 'qwen3-0.6b', quantizations: [], manifestSha: 'sha' };
const baseConfig = live
  ? { parentId: env.NEBIUS_PARENT_ID, subnetId: env.NEBIUS_SUBNET_ID, serviceAccountId: env.NEBIUS_SA_ID, publicKeyId: env.NEBIUS_KEY_ID, platform: env.NEBIUS_PLATFORM ?? 'gpu-h100-sxm', preset: env.NEBIUS_PRESET ?? '1gpu-16vcpu-200gb' }
  : { parentId: 'project-1', subnetId: 'vpcsubnet-1', serviceAccountId: 'serviceaccount-valid', publicKeyId: 'publickey-1', preset: '1gpu-16vcpu-200gb' };

runConformance(live ? 'nebius (LIVE)' : 'nebius (fixture)', {
  adapter,
  credentials: live ? { privateKey: env.NEBIUS_PRIVATE_KEY } : { privateKey: PRIVATE_KEY },
  badCredentials: { serviceAccountId: 'serviceaccount-revoked', privateKey: PRIVATE_KEY },
  tinyVersion: tiny,
  providerConfig: { ...baseConfig, hourlyRateCents: 295 },
  quotaExceededConfig: live ? undefined : { ...baseConfig, preset: '8gpu-128vcpu-1600gb' },
  vanish: live ? undefined : (_a, ref) => { fixture.instances.delete(ref.instanceId); },
  chat: live ? undefined : async () => 'fixture reply',
  readyTimeoutMs: live ? 20 * 60_000 : 5_000,
});

describe('nebius request shape', () => {
  const s3Request = {
    deploymentId: 'abc-123',
    organizationId: 'org',
    version: { id: 'v', name: 'q', registryUri: 's3://registry/models/q@etag', base: 'qwen3-0.6b', quantizations: [], manifestSha: 's' },
    desired: { replicas: 1, minScale: 0, maxScale: 1, hardware: 'gpu-l40s-a', quantization: 'awq' },
    providerConfig: { parentId: 'project-1', subnetId: 'vpcsubnet-1', serviceAccountId: 'serviceaccount-valid', publicKeyId: 'publickey-1', preset: '1gpu-8vcpu-32gb', bootDiskGib: 256, registryEndpoint: 'https://minio.local', maxModelLen: 4096 },
  };
  const creds = { privateKey: PRIVATE_KEY, registryAccessKeyId: 'AK', registrySecretAccessKey: 'SK' };
  const fresh = (f: ReturnType<typeof fixtureHttp>) => new NebiusAdapter(f.http, { timeoutMs: 2_000, pollMs: 10 });

  it('exchanges the service account JWT, creates a boot disk from the CUDA family, then the instance with cloud-init', async () => {
    const f = fixtureHttp();
    const a = fresh(f);
    const ref = await a.deploy(s3Request, creds);
    const [exchange, diskCall, instanceCall] = f.http.post.mock.calls;
    expect(exchange[0]).toBe('https://auth.eu.nebius.com/oauth2/token/exchange');
    const form = new URLSearchParams(exchange[1]);
    expect(form.get('requested_token_type')).toBe('urn:ietf:params:oauth:token-type:access_token');
    expect(exchange[2].headers['Content-Type']).toBe('application/x-www-form-urlencoded');

    expect(diskCall[0]).toBe('https://api.eu.nebius.cloud/compute/v1/disks');
    expect(diskCall[1]).toEqual({
      metadata: { parentId: 'project-1', name: 'almyty-abc123-boot' },
      spec: { type: 'NETWORK_SSD', sizeGibibytes: 256, sourceImageFamily: { imageFamily: 'ubuntu22.04-cuda12' } },
    });
    expect(diskCall[2].headers.Authorization).toBe('Bearer iam-valid');

    expect(instanceCall[0]).toBe('https://api.eu.nebius.cloud/compute/v1/instances');
    const spec = instanceCall[1].spec;
    expect(instanceCall[1].metadata).toEqual({ parentId: 'project-1', name: 'almyty-abc123' });
    expect(spec.resources).toEqual({ platform: 'gpu-l40s-a', preset: '1gpu-8vcpu-32gb' });
    expect(spec.bootDisk).toEqual({ attachMode: 'READ_WRITE', existingDisk: { id: ref.diskId } });
    expect(spec.networkInterfaces).toEqual([{ name: 'eth0', subnetId: 'vpcsubnet-1', ipAddress: {}, publicIpAddress: {} }]);
    const userData: string = spec.cloudInitUserData;
    expect(userData.startsWith('#cloud-config\n')).toBe(true);
    expect(userData).toContain('AWS_SECRET_ACCESS_KEY=SK');
    expect(userData).toContain('amazon/aws-cli s3 sync --endpoint-url https://minio.local s3://registry/models/q /model');
    expect(userData).toContain('vllm/vllm-openai:latest --model /model --served-model-name q --quantization awq --max-model-len 4096 --port 8000');
    expect(userData.split('\n').find((l) => l.includes('docker run -d'))).not.toContain('SK');
    expect(userData.length).toBeLessThan(32_768);
    expect(ref).toMatchObject({ name: 'almyty-abc123', parentId: 'project-1', hourlyRateCents: 0 });
    expect(JSON.stringify(ref)).not.toContain('SK');
    expect(JSON.stringify(ref)).not.toContain('PRIVATE KEY');
  });

  it('reads state from the instance plus the vLLM probe, stops and starts by operation, and deletes disk after instance', async () => {
    const f = fixtureHttp();
    const a = fresh(f);
    const ref = await a.deploy(s3Request, creds);
    const ready = await a.readEndpoint(ref, creds);
    expect(ready).toMatchObject({ state: 'ready', replicas: 1, hardware: 'gpu-l40s-a/1gpu-8vcpu-32gb' });
    expect(ready.url).toMatch(/^http:\/\/198\.51\.100\.\d+:8000\/v1$/);

    await a.scale(ref, 0, creds);
    expect(f.http.post.mock.calls.at(-1)![0]).toBe(`https://api.eu.nebius.cloud/compute/v1/instances/${ref.instanceId}:stop`);
    expect((await a.readEndpoint(ref, creds)).state).toBe('stopped');
    await a.scale(ref, 1, creds);
    expect(f.http.post.mock.calls.at(-1)![0]).toBe(`https://api.eu.nebius.cloud/compute/v1/instances/${ref.instanceId}:start`);
    expect((await a.readEndpoint(ref, creds)).state).toBe('ready');
    await expect(a.scale(ref, 2, creds)).rejects.toMatchObject({ code: 'ADAPTER_UNSUPPORTED_OPERATION' });

    await a.teardown(ref, creds);
    expect(f.http.delete.mock.calls.map((c) => c[0])).toEqual([
      `https://api.eu.nebius.cloud/compute/v1/instances/${ref.instanceId}`,
      `https://api.eu.nebius.cloud/compute/v1/disks/${ref.diskId}`,
    ]);
    expect(f.disks.size).toBe(0);
    // One exchange served every call: the token is cached for the service account.
    expect(f.http.post.mock.calls.filter((c) => c[0].includes('/oauth2/token/exchange')).length).toBe(1);
  });

  it('drops the boot disk when the instance cannot be created', async () => {
    const f = fixtureHttp();
    const a = fresh(f);
    await expect(a.deploy({ ...s3Request, providerConfig: { ...s3Request.providerConfig, preset: '8gpu-128vcpu-1600gb' } }, creds)).rejects.toMatchObject({ code: 'ADAPTER_QUOTA_EXCEEDED' });
    expect(f.disks.size).toBe(0);
  });

  it('maps every documented instance state', async () => {
    const f = fixtureHttp();
    const a = fresh(f);
    const ref = await a.deploy({ ...s3Request, version: tiny }, { accessToken: 'iam-valid' });
    await a.readEndpoint(ref, { accessToken: 'iam-valid' });
    const inst = f.instances.get(ref.instanceId);
    for (const [raw, expected] of Object.entries({ STARTING: 'deploying', UPDATING: 'scaling', RUNNING: 'ready', STOPPING: 'scaling', STOPPED: 'stopped', DELETING: 'stopped', ERROR: 'failed' })) {
      inst.status.state = raw;
      expect((await a.readEndpoint(ref, { accessToken: 'iam-valid' })).state).toBe(expected);
    }
    expect(f.http.post.mock.calls.some((c) => c[0].includes('/oauth2/'))).toBe(false);
  });
});
