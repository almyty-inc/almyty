import { buildHarness, principal } from './test-support';
import { makeTestCa, TestCa } from '../../../common/security/__tests__/test-ca';
import type { KubeProbeClientFactory } from '../connection-validation.service';

/**
 * A `format: 'pem'` field (the kubernetes connector's caCert) is stored as
 * canonical PEM, whatever the connect form did to its newlines, on connect
 * and on replace-key alike. Text that is no certificate is refused.
 *
 * Saving a kubernetes connection asks the cluster (validation kind
 * `kubernetes`); here a stand-in cluster answers, and records the CA the
 * check dialed with, which must be the normalised one too.
 */
describe('connect with a certificate field', () => {
  const ORG = 'org-1';
  const admin = principal('u-admin', ORG, 'admin');
  const server = 'https://kube.example.com';
  let ca: TestCa;
  const dialedWith: Array<string | undefined> = [];
  const cluster: KubeProbeClientFactory = (conn) => {
    dialedWith.push(conn.caCert);
    return { version: async () => ({ gitVersion: 'v1.31.2' }), canI: async () => true };
  };
  const harness = () => buildHarness({ kubeFactory: cluster });

  beforeAll(() => {
    ca = makeTestCa('connect test CA');
  });
  beforeEach(() => {
    dialedWith.length = 0;
  });

  it('stores a CA pasted on one line as canonical PEM', async () => {
    const h = harness();
    const done = await h.service.connect(admin, ORG, 'kubernetes', { input: { server, caCert: ca.caCert.replace(/\n/g, ''), token: 'sa-token-value' } });
    if (done.pending !== false) throw new Error('expected a connection');
    expect(h.credentials.rows).toHaveLength(1);
    expect(h.credentials.rows[0].config.caCert).toBe(ca.caCert);
    expect(dialedWith).toEqual([ca.caCert]);
  });

  it('normalises the CA again when the key is replaced', async () => {
    const h = harness();
    const done = await h.service.connect(admin, ORG, 'kubernetes', { input: { server, token: 'sa-token-value' } });
    if (done.pending !== false) throw new Error('expected a connection');
    const rotated = await h.service.rotate(admin, ORG, done.connection.id, { input: { token: 'sa-token-second', caCert: ca.caCert.replace(/\n/g, ' ') } });
    if (rotated.pending !== false) throw new Error('expected a connection');
    expect(h.credentials.rows).toHaveLength(1);
    expect(h.credentials.rows[0].config.caCert).toBe(ca.caCert);
    expect(dialedWith).toEqual([undefined, ca.caCert]);
  });

  it('refuses a CA that is not a certificate before saving anything', async () => {
    const h = harness();
    await expect(h.service.connect(admin, ORG, 'kubernetes', { input: { server, caCert: 'paste here', token: 'sa-token-value' } }))
      .rejects.toMatchObject({ response: { code: 'CONNECT_INPUT_INVALID', errors: [expect.stringMatching(/^caCert: CA certificate \(PEM\) is not a PEM certificate/)] } });
    expect(h.credentials.rows).toHaveLength(0);
  });
});
