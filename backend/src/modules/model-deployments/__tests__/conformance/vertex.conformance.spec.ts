import { createVerify, generateKeyPairSync } from 'crypto';

import { VertexAdapter } from '../../adapters/vertex.adapter';
import { liveRequested, runConformance } from './conformance.suite';

/**
 * Fixture mode: an in-memory stand-in for the Vertex AI REST API and the
 * Google OAuth2 token endpoint, faithful to the documented resource
 * paths, the long-running Operation envelope, and the google.rpc error
 * envelope ({error: {code, message, status}}). The token endpoint
 * verifies the RS256 assertion against a key pair generated here, so the
 * service-account flow is exercised for real. Live mode
 * (CONFORMANCE_LIVE=vertex with GOOGLE_SERVICE_ACCOUNT_JSON,
 * VERTEX_PROJECT_ID, VERTEX_LOCATION, VERTEX_TEST_S3_URI and registry
 * keys) runs the same cases against a real project; never in CI.
 */
const validKey = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const strayKey = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const VALID_EMAIL = 'almyty@valid-project.iam.gserviceaccount.com';
const serviceAccount = (email: string, privateKey: string) => JSON.stringify({ type: 'service_account', client_email: email, private_key: privateKey, token_uri: 'https://oauth2.googleapis.com/token' });

function fixtureHttp() {
  const endpoints = new Map<string, any>();
  const models = new Map<string, any>();
  const operations = new Map<string, any>();
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; data?: any; params?: any }> = [];
  let seq = 0;
  const gError = (code: number, status: string, message: string) => Object.assign(new Error(`${code}`), { response: { status: code, data: { error: { code, message, status } } } });
  const op = (parent: string, done: boolean, response?: any, error?: any) => {
    const name = `${parent}/operations/${++seq}`;
    const o: any = { name, done, ...(response ? { response } : {}), ...(error ? { error } : {}) };
    operations.set(name, o);
    return o;
  };

  const http = {
    request: jest.fn(async (config: { method: string; url: string; headers: Record<string, string>; data?: any; params?: Record<string, string> }) => {
      calls.push(config);
      if (config.url === 'https://oauth2.googleapis.com/token') {
        const assertion = new URLSearchParams(config.data).get('assertion') ?? '';
        const [h, c, s] = assertion.split('.');
        const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
        const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(validKey.publicKey, Buffer.from(s, 'base64url'));
        if (!ok || claims.iss !== VALID_EMAIL || claims.aud !== 'https://oauth2.googleapis.com/token') {
          throw Object.assign(new Error('400'), { response: { status: 400, data: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } } });
        }
        return { status: 200, data: { access_token: 'ya29.valid', token_type: 'Bearer', expires_in: 3600 } };
      }
      if (config.headers.Authorization !== 'Bearer ya29.valid') throw gError(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.');

      const m = config.url.match(/^https:\/\/([a-z0-9-]+)-aiplatform\.googleapis\.com\/v1\/(.+)$/);
      if (!m) throw new Error(`unexpected url ${config.url}`);
      const path = m[2];
      const parent = path.match(/^(projects\/[^/]+\/locations\/[^/]+)/)![1];

      if (config.method === 'GET' && /\/operations\//.test(path)) {
        const o = operations.get(path);
        if (!o) throw gError(404, 'NOT_FOUND', 'operation not found');
        // A deploy finishes on the first read after it was started.
        if (!o.done && o.finish) o.finish();
        return { status: 200, data: { ...o, finish: undefined } };
      }
      if (config.method === 'POST' && path === `${parent}/endpoints`) {
        const name = `${parent}/endpoints/${config.params?.endpointId ?? ++seq}`;
        endpoints.set(name, { name, displayName: config.data.displayName, deployedModels: [], dedicatedEndpointEnabled: config.data.dedicatedEndpointEnabled, ...(config.data.dedicatedEndpointEnabled ? { dedicatedEndpointDns: `${seq}.${m[1]}-1.prediction.vertexai.goog` } : {}) });
        return { status: 200, data: op(name, true, { name }) };
      }
      if (config.method === 'POST' && path === `${parent}/models:upload`) {
        const name = `${parent}/models/${++seq}`;
        models.set(name, { name, ...config.data.model });
        return { status: 200, data: op(name, true, { model: name, modelVersionId: '1' }) };
      }
      const ep = path.match(/^(projects\/[^/]+\/locations\/[^/]+\/endpoints\/[^/:]+)(?::(\w+))?$/);
      if (ep) {
        const endpoint = endpoints.get(ep[1]);
        if (!endpoint) throw gError(404, 'NOT_FOUND', `Endpoint ${ep[1]} is not found.`);
        if (config.method === 'GET') return { status: 200, data: JSON.parse(JSON.stringify(endpoint)) };
        if (config.method === 'DELETE') {
          if (endpoint.deployedModels.length) throw gError(400, 'FAILED_PRECONDITION', 'Endpoint has deployed models.');
          endpoints.delete(ep[1]);
          return { status: 200, data: op(ep[1], true, {}) };
        }
        if (ep[2] === 'deployModel') {
          const dm = config.data.deployedModel;
          if (dm.dedicatedResources.machineSpec.acceleratorType === 'NVIDIA_H100_80GB') throw gError(429, 'RESOURCE_EXHAUSTED', 'The following quotas are exceeded: CustomModelServingH100GPUsPerProjectPerRegion');
          const id = String(++seq);
          const o = op(ep[1], false, { deployedModel: { id } });
          o.finish = () => {
            o.done = true;
            endpoint.deployedModels.push({ id, model: `${dm.model}@1`, displayName: dm.displayName, dedicatedResources: dm.dedicatedResources, createTime: new Date().toISOString() });
            endpoint.trafficSplit = { [id]: 100 };
          };
          return { status: 200, data: { name: o.name, done: false } };
        }
        if (ep[2] === 'undeployModel') {
          endpoint.deployedModels = endpoint.deployedModels.filter((d: any) => d.id !== config.data.deployedModelId);
          return { status: 200, data: op(ep[1], true, {}) };
        }
        if (ep[2] === 'mutateDeployedModel') {
          const dm = endpoint.deployedModels.find((d: any) => d.id === config.data.deployedModel.id);
          if (!dm) throw gError(404, 'NOT_FOUND', 'deployed model not found');
          dm.dedicatedResources = { ...dm.dedicatedResources, ...config.data.deployedModel.dedicatedResources };
          return { status: 200, data: op(ep[1], true, {}) };
        }
      }
      const model = path.match(/^(projects\/[^/]+\/locations\/[^/]+\/models\/[^/:]+)$/);
      if (model && config.method === 'DELETE') {
        if (!models.delete(model[1])) throw gError(404, 'NOT_FOUND', 'model not found');
        return { status: 200, data: op(model[1], true, {}) };
      }
      throw new Error(`unexpected request ${config.method} ${config.url}`);
    }),
  };
  return { endpoints, models, operations, calls, http };
}

const live = liveRequested('vertex');
const fixture = fixtureHttp();
const adapter = () => (live ? new VertexAdapter() : new VertexAdapter(fixture.http, { pollIntervalMs: 0 }));
const validCreds = live
  ? { serviceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON, registryAccessKeyId: process.env.REGISTRY_ACCESS_KEY_ID, registrySecretAccessKey: process.env.REGISTRY_SECRET_ACCESS_KEY }
  : { serviceAccountJson: serviceAccount(VALID_EMAIL, validKey.privateKey), registryAccessKeyId: 'AK', registrySecretAccessKey: 'SK' };
const tiny = {
  id: 'v1',
  name: 'qwen3-0.6b',
  registryUri: live ? `${process.env.VERTEX_TEST_S3_URI}@live` : 's3://registry/models/qwen3-0.6b@etag1',
  base: 'qwen3-0.6b',
  quantizations: [],
  manifestSha: 'sha',
};
const config = { projectId: live ? process.env.VERTEX_PROJECT_ID : 'valid-project', location: live ? process.env.VERTEX_LOCATION ?? 'us-central1' : 'us-central1', machineType: 'g2-standard-12', acceleratorType: 'NVIDIA_L4', acceleratorCount: 1, hourlyRateCents: 120 };

runConformance(live ? 'vertex (LIVE)' : 'vertex (fixture)', {
  adapter,
  credentials: validCreds,
  badCredentials: { serviceAccountJson: serviceAccount(VALID_EMAIL, strayKey.privateKey) },
  tinyVersion: tiny,
  providerConfig: config,
  quotaExceededConfig: live ? undefined : { ...config, machineType: 'a3-highgpu-8g', acceleratorType: 'NVIDIA_H100_80GB', acceleratorCount: 8 },
  vanish: live ? undefined : (_a, ref) => { fixture.endpoints.delete(ref.endpointName); },
  chat: live ? undefined : async () => 'fixture reply',
  readyTimeoutMs: live ? 30 * 60_000 : 5_000,
});

describe('vertex request shape', () => {
  const creds = { accessToken: 'ya29.valid', registryAccessKeyId: 'AK', registrySecretAccessKey: 'SK' };
  const request = (overrides: Partial<Parameters<VertexAdapter['deploy']>[0]> = {}) => ({
    deploymentId: 'abc-123',
    organizationId: 'org-1',
    version: { id: 'v', name: 'q', registryUri: 's3://registry/models/q@etag', base: 'qwen3-0.6b', quantizations: [], manifestSha: 's' },
    desired: { replicas: 1, minScale: 1, maxScale: 2, hardware: 'g2-standard-24', region: 'europe-west4' },
    providerConfig: { projectId: 'p1', location: 'us-central1', acceleratorType: 'NVIDIA_L4', acceleratorCount: 2, registryEndpoint: 'https://minio.local', dedicatedEndpoint: true, hourlyRateCents: 120 },
    ...overrides,
  });

  it('creates the endpoint, uploads a vLLM model streaming the S3 registry prefix, then deploys with dedicated resources', async () => {
    const f = fixtureHttp();
    const a = new VertexAdapter(f.http, { pollIntervalMs: 0 });
    const ref = await a.deploy(request(), creds);
    const base = 'https://europe-west4-aiplatform.googleapis.com/v1/projects/p1/locations/europe-west4';
    const writes = f.calls.filter((c) => c.method !== 'GET');
    expect(writes.map((c) => [c.method, c.url])).toEqual([
      ['POST', `${base}/endpoints`],
      ['POST', `${base}/models:upload`],
      ['POST', `${base}/endpoints/almyty-abc123:deployModel`],
    ]);
    for (const c of f.calls) expect(c.headers.Authorization).toBe('Bearer ya29.valid');
    expect(f.calls.some((c) => c.url.includes('oauth2'))).toBe(false);

    expect(writes[0].params).toEqual({ endpointId: 'almyty-abc123' });
    expect(writes[0].data).toEqual({ displayName: 'almyty-abc123', dedicatedEndpointEnabled: true });

    const model = writes[1].data.model;
    expect(model.displayName).toBe('almyty-abc123');
    expect(model.containerSpec.imageUri).toBe('vllm/vllm-openai:latest');
    expect(model.containerSpec.args).toEqual(['--model', 's3://registry/models/q', '--load-format', 'runai_streamer', '--served-model-name', 'q', '--port', '8080']);
    expect(model.containerSpec.env).toEqual([
      { name: 'ALMYTY_REGISTRY_URI', value: 's3://registry/models/q@etag' },
      { name: 'AWS_ACCESS_KEY_ID', value: 'AK' },
      { name: 'AWS_SECRET_ACCESS_KEY', value: 'SK' },
      { name: 'AWS_ENDPOINT_URL', value: 'https://minio.local' },
    ]);
    expect(model.containerSpec.ports).toEqual([{ containerPort: 8080 }]);
    expect(model.containerSpec.predictRoute).toBe('/v1/chat/completions');
    expect(model.containerSpec.healthRoute).toBe('/health');
    expect(model.labels).toEqual({ 'almyty-deployment': 'abc-123', 'almyty-organization': 'org-1' });

    expect(writes[2].data).toEqual({
      deployedModel: {
        model: ref.modelName,
        displayName: 'almyty-abc123',
        dedicatedResources: { machineSpec: { machineType: 'g2-standard-24', acceleratorType: 'NVIDIA_L4', acceleratorCount: 2 }, minReplicaCount: 1, maxReplicaCount: 2 },
        enableAccessLogging: false,
      },
      trafficSplit: { '0': 100 },
    });
    expect(ref.modelName).toMatch(/^projects\/p1\/locations\/europe-west4\/models\//);
    expect(ref.deployOperation).toMatch(/\/endpoints\/almyty-abc123\/operations\//);
    expect(ref.url).toBe('https://europe-west4-aiplatform.googleapis.com/v1/projects/p1/locations/europe-west4/endpoints/almyty-abc123/chat/completions');
  });

  it('mints a bearer token from a service-account key once and reuses it', async () => {
    const f = fixtureHttp();
    const a = new VertexAdapter(f.http, { pollIntervalMs: 0 });
    const sa = { serviceAccountJson: serviceAccount(VALID_EMAIL, validKey.privateKey) };
    const ref = await a.deploy(request(), sa);
    await a.readEndpoint(ref, sa);
    const tokenCalls = f.calls.filter((c) => c.url === 'https://oauth2.googleapis.com/token');
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0].headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(new URLSearchParams(tokenCalls[0].data).get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const claims = JSON.parse(Buffer.from(new URLSearchParams(tokenCalls[0].data).get('assertion')!.split('.')[1], 'base64url').toString());
    expect(claims).toMatchObject({ iss: VALID_EMAIL, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: 'https://oauth2.googleapis.com/token' });
    expect(claims.exp - claims.iat).toBe(3600);
  });

  it('rejects an unparseable service account as an auth error without calling Google', async () => {
    const f = fixtureHttp();
    const a = new VertexAdapter(f.http, { pollIntervalMs: 0 });
    await expect(a.deploy(request(), { serviceAccountJson: 'not json' })).rejects.toMatchObject({ code: 'ADAPTER_AUTH' });
    await expect(a.deploy(request(), {})).rejects.toMatchObject({ code: 'ADAPTER_AUTH' });
    expect(f.calls).toHaveLength(0);
  });

  it('refuses a non-S3 registry source before calling Google', async () => {
    const f = fixtureHttp();
    const a = new VertexAdapter(f.http, { pollIntervalMs: 0 });
    await expect(a.deploy(request({ version: { id: 'v', name: 'q', registryUri: 'hf://Qwen/Qwen3-0.6B@main', base: 'q', quantizations: [], manifestSha: 's' } }), creds)).rejects.toMatchObject({ code: 'ADAPTER_UNSUPPORTED_OPERATION' });
    expect(f.calls).toHaveLength(0);
  });

  it('removes the endpoint and model again when deployModel is refused', async () => {
    const f = fixtureHttp();
    const a = new VertexAdapter(f.http, { pollIntervalMs: 0 });
    await expect(a.deploy(request({ providerConfig: { projectId: 'p1', acceleratorType: 'NVIDIA_H100_80GB', acceleratorCount: 8 } }), creds)).rejects.toMatchObject({ code: 'ADAPTER_QUOTA_EXCEEDED' });
    expect(f.endpoints.size).toBe(0);
    expect(f.models.size).toBe(0);
  });

  it('tracks the deploy operation, prefers the dedicated endpoint DNS once ready, and reports an operation error as failed', async () => {
    const f = fixtureHttp();
    const a = new VertexAdapter(f.http, { pollIntervalMs: 0 });
    const ref = await a.deploy(request(), creds);
    const first = await a.readEndpoint(ref, creds);
    expect(first.state).toBe('deploying');
    const ready = await a.readEndpoint(ref, creds);
    expect(ready.state).toBe('ready');
    expect(ready.replicas).toBe(1);
    expect(ready.hardware).toBe('g2-standard-24');
    expect(ready.url).toMatch(/^https:\/\/\d+\.europe-west4-1\.prediction\.vertexai\.goog\/v1\/projects\/p1\/locations\/europe-west4\/endpoints\/almyty-abc123\/chat\/completions$/);
    expect(ref.deployedModelId).toBe(ready.details!.deployedModelId);

    const broken = await a.deploy(request({ deploymentId: 'broken' }), creds);
    const op = f.operations.get(broken.deployOperation);
    op.finish = () => {
      op.done = true;
      op.error = { code: 8, message: 'Quota exceeded for NVIDIA_L4 in europe-west4' };
    };
    const failed = await a.readEndpoint(broken, creds);
    expect(failed.state).toBe('failed');
    expect(failed.message).toContain('Quota exceeded');
  });

  it('scales by mutating the replica range, undeploys for zero, redeploys from zero, and tears down in order', async () => {
    const f = fixtureHttp();
    const a = new VertexAdapter(f.http, { pollIntervalMs: 0 });
    const ref = await a.deploy(request(), creds);
    await a.readEndpoint(ref, creds);
    await a.readEndpoint(ref, creds);

    await a.scale(ref, 3, creds);
    const mutate = f.calls[f.calls.length - 1];
    expect(mutate.method).toBe('PATCH');
    expect(mutate.url).toMatch(/endpoints\/almyty-abc123:mutateDeployedModel$/);
    expect(mutate.data).toEqual({ deployedModel: { id: ref.deployedModelId, dedicatedResources: { minReplicaCount: 3, maxReplicaCount: 3 } }, updateMask: 'dedicatedResources.minReplicaCount,dedicatedResources.maxReplicaCount' });
    const scaled = await a.readEndpoint(ref, creds);
    expect(scaled.state).toBe('ready');
    expect(scaled.replicas).toBe(3);
    expect((await a.costSnapshot(ref, creds)).ratePerHourCents).toBe(360);

    await a.scale(ref, 0, creds);
    const undeploy = f.calls.find((c) => c.url.endsWith(':undeployModel'));
    expect(undeploy?.data).toEqual({ deployedModelId: scaled.details!.deployedModelId });
    const stopped = await a.readEndpoint(ref, creds);
    expect(stopped.state).toBe('stopped');
    expect((await a.costSnapshot(ref, creds)).ratePerHourCents).toBe(0);

    await a.scale(ref, 1, creds);
    expect(f.calls[f.calls.length - 1].url).toMatch(/:deployModel$/);
    expect(f.calls[f.calls.length - 1].data.deployedModel.dedicatedResources).toMatchObject({ minReplicaCount: 1, maxReplicaCount: 3 });
    expect((await a.readEndpoint(ref, creds)).state).toBe('deploying');
    expect((await a.readEndpoint(ref, creds)).state).toBe('ready');

    await a.teardown(ref, creds);
    const tail = f.calls.filter((c) => c.method !== 'GET').slice(-3).map((c) => [c.method, c.url.split('/v1/')[1]]);
    expect(tail).toEqual([
      ['POST', 'projects/p1/locations/europe-west4/endpoints/almyty-abc123:undeployModel'],
      ['DELETE', 'projects/p1/locations/europe-west4/endpoints/almyty-abc123'],
      ['DELETE', ref.modelName],
    ]);
    expect(f.endpoints.size + f.models.size).toBe(0);
    await expect(a.teardown(ref, creds)).resolves.toBeUndefined();
  });
});
