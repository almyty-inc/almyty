import * as http from 'http';
import { AddressInfo } from 'net';

import { ConnectionValidationService, KubeProbeClientFactory } from '../connection-validation.service';
import { KUBERNETES_CONNECTOR } from '../connector-catalog';
import { ssrfSafeHttpsAgent } from '../../../common/security/ssrf-safe-agent';
import { KubeApiClient, KubeApiError, KubeResourceAttributes } from '../../hosted-runners/adapters/kubernetes/kube-api.client';
import { HOSTED_RUNNER_ACCESS } from '../../hosted-runners/adapters/kubernetes/access';
import { snapshotEnv } from '../../../test/env';

/**
 * "Check again" on a Kubernetes cluster connection asks the cluster: the
 * API server answers /version with the saved CA and token, and the token
 * may do everything the hosted runner adapter does, in a namespace under
 * the configured prefix. Anything less is the cluster's own reason.
 */
describe('kubernetes connection check', () => {
  const restore = snapshotEnv('HOSTED_RUNNERS_SETTINGS', 'HOSTED_RUNNERS_SETTINGS_FILE', 'KUBERNETES_ALLOW_PRIVATE_URLS');
  beforeEach(() => {
    process.env.HOSTED_RUNNERS_SETTINGS = JSON.stringify({ cluster: { namespacePrefix: 'almyty-rt-stg-' } });
    delete process.env.HOSTED_RUNNERS_SETTINGS_FILE;
    delete process.env.KUBERNETES_ALLOW_PRIVATE_URLS;
  });
  afterEach(restore);

  const config = { server: 'https://kube.example.com:6443/', caCert: '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----', token: 'sa-token' };

  function check(fake: { version?: () => Promise<{ gitVersion: string }>; canI?: (a: KubeResourceAttributes) => Promise<boolean> }) {
    const reviews: KubeResourceAttributes[] = [];
    const factory = jest.fn<ReturnType<KubeProbeClientFactory>, Parameters<KubeProbeClientFactory>>(() => ({
      version: fake.version ?? (async () => ({ gitVersion: 'v1.31.2' })),
      canI: async (a) => {
        reviews.push(a);
        return fake.canI ? fake.canI(a) : true;
      },
    }));
    const http = jest.fn();
    const service = new ConnectionValidationService({ get: (k: string) => process.env[k] } as any, http as any, undefined, undefined, factory);
    return { run: (c: Record<string, any> = config) => service.validate(KUBERNETES_CONNECTOR, c, { organizationId: 'org-1' }), factory, reviews, http };
  }

  it('is the catalog entry\'s check', () => {
    expect(KUBERNETES_CONNECTOR.validation).toEqual({ kind: 'kubernetes', accountLabelFrom: 'server' });
  });

  it('works when the cluster answers and the token may do what provisioning does', async () => {
    const { run, factory, reviews, http } = check({});
    const result = await run();
    expect(result).toEqual({ ok: true, status: 'valid', accountLabel: 'https://kube.example.com:6443', detail: 'Kubernetes v1.31.2' });
    const [conn, options] = factory.mock.calls[0];
    expect(conn).toEqual({ server: 'https://kube.example.com:6443', caCert: config.caCert, token: 'sa-token' });
    expect(options.timeoutMs).toBeGreaterThan(0);
    expect(options.agent).toBe(ssrfSafeHttpsAgent);
    // One review per thing the adapter does, in the namespace it would use.
    expect(reviews).toHaveLength(HOSTED_RUNNER_ACCESS.length);
    expect(reviews).toContainEqual({ verb: 'create', group: '', resource: 'namespaces' });
    expect(reviews).toContainEqual({ verb: 'create', group: 'apps', resource: 'deployments', namespace: 'almyty-rt-stg-org-1' });
    expect(reviews).toContainEqual({ verb: 'patch', group: 'apps', resource: 'deployments', subresource: 'scale', namespace: 'almyty-rt-stg-org-1' });
    expect(reviews).toContainEqual({ verb: 'list', group: '', resource: 'pods', namespace: 'almyty-rt-stg-org-1' });
    expect(http).not.toHaveBeenCalled();
  });

  it('names what the token may not do', async () => {
    const { run } = check({ canI: async (a) => !((a.resource === 'namespaces' && a.verb === 'create') || (a.resource === 'deployments' && a.verb === 'create' && !a.subresource)) });
    const result = await run();
    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.error).toBe('cannot create namespaces; cannot create deployments in almyty-rt-stg-*');
    expect(result.detail).toBeUndefined();
  });

  it('says the token was rejected', async () => {
    const { run } = check({ canI: async () => { throw new KubeApiError(401, 'review access failed: HTTP 401 Unauthorized'); } });
    expect(await run()).toEqual({ ok: false, status: 'failed', error: 'the cluster rejected the token (401)' });
  });

  it('says the certificate is not trusted', async () => {
    const { run } = check({ version: async () => { throw Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }); } });
    const result = await run();
    expect(result.error).toBe("TLS: the cluster's certificate is not trusted (SELF_SIGNED_CERT_IN_CHAIN); check the CA certificate");
  });

  it('says the cluster is unreachable', async () => {
    const { run } = check({ version: async () => { throw Object.assign(new Error('connect ECONNREFUSED kube.example.com:6443'), { code: 'ECONNREFUSED' }); } });
    expect((await run()).error).toBe('could not reach kube.example.com:6443: connect ECONNREFUSED kube.example.com:6443');
  });

  it('refuses a private server URL without dialing it', async () => {
    const { run, factory } = check({});
    const result = await run({ ...config, server: 'https://10.0.0.5' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^server URL refused/);
    expect(factory).not.toHaveBeenCalled();
  });

  it('dials a private server only under KUBERNETES_ALLOW_PRIVATE_URLS, exempting that host alone', async () => {
    process.env.KUBERNETES_ALLOW_PRIVATE_URLS = 'true';
    const { run, factory } = check({});
    expect((await run({ ...config, server: 'https://10.0.0.5' })).ok).toBe(true);
    expect(factory.mock.calls[0][1].agent).not.toBe(ssrfSafeHttpsAgent);
  });

  it('refuses a connection that is not https or has no token', async () => {
    const { run, factory } = check({});
    expect((await run({ ...config, server: 'http://kube.example.com' })).error).toMatch(/https server URL/);
    expect((await run({ ...config, token: '' })).error).toMatch(/ServiceAccount token/);
    expect(factory).not.toHaveBeenCalled();
  });
});

/** The client the check uses is the hosted runner adapter's, speaking the real wire format. */
describe('KubeApiClient version and access reviews', () => {
  let server: http.Server;
  let url: string;
  const seen: Array<{ method?: string; path?: string; auth?: string; body: any }> = [];
  let hang = false;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
        seen.push({ method: req.method, path: req.url, auth: req.headers.authorization, body });
        if (hang) return; // never answers
        res.writeHead(req.url === '/version' ? 200 : 201, { 'Content-Type': 'application/json' });
        if (req.url === '/version') return res.end(JSON.stringify({ gitVersion: 'v1.31.2' }));
        const allowed = body?.spec?.resourceAttributes?.resource !== 'secrets';
        res.end(JSON.stringify({ ...body, status: { allowed } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('reads the version and asks access reviews with the token', async () => {
    const client = new KubeApiClient({ server: url, token: 'sa-token' });
    expect(await client.version()).toEqual({ gitVersion: 'v1.31.2' });
    expect(await client.canI({ verb: 'create', group: '', resource: 'pods', namespace: 'almyty-rt-x' })).toBe(true);
    expect(await client.canI({ verb: 'create', group: '', resource: 'secrets', namespace: 'almyty-rt-x' })).toBe(false);
    const review = seen.find((s) => s.method === 'POST');
    expect(review?.path).toBe('/apis/authorization.k8s.io/v1/selfsubjectaccessreviews');
    expect(review?.auth).toBe('Bearer sa-token');
    expect(review?.body).toEqual({
      apiVersion: 'authorization.k8s.io/v1',
      kind: 'SelfSubjectAccessReview',
      spec: { resourceAttributes: { verb: 'create', group: '', resource: 'pods', namespace: 'almyty-rt-x' } },
    });
  });

  it('gives up after its timeout', async () => {
    hang = true;
    try {
      const client = new KubeApiClient({ server: url, token: 't' }, { timeoutMs: 50 });
      await expect(client.version()).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    } finally {
      hang = false;
    }
  });
});
