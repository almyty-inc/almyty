import { buildHarness, principal } from './test-support';
import { makeTestCa, TestCa } from '../../../common/security/__tests__/test-ca';

/**
 * A `format: 'pem'` field (the kubernetes connector's caCert) is stored as
 * canonical PEM, whatever the connect form did to its newlines, on connect
 * and on replace-key alike. Text that is no certificate is refused.
 */
describe('connect with a certificate field', () => {
  const ORG = 'org-1';
  const admin = principal('u-admin', ORG, 'admin');
  const server = 'https://kube.example.com';
  let ca: TestCa;

  beforeAll(() => {
    ca = makeTestCa('connect test CA');
  });

  it('stores a CA pasted on one line as canonical PEM', async () => {
    const h = buildHarness();
    const done = await h.service.connect(admin, ORG, 'kubernetes', { input: { server, caCert: ca.caCert.replace(/\n/g, ''), token: 'sa-token-value' } });
    if (done.pending !== false) throw new Error('expected a connection');
    expect(h.credentials.rows).toHaveLength(1);
    expect(h.credentials.rows[0].config.caCert).toBe(ca.caCert);
  });

  it('normalises the CA again when the key is replaced', async () => {
    const h = buildHarness();
    const done = await h.service.connect(admin, ORG, 'kubernetes', { input: { server, token: 'sa-token-value' } });
    if (done.pending !== false) throw new Error('expected a connection');
    const rotated = await h.service.rotate(admin, ORG, done.connection.id, { input: { token: 'sa-token-second', caCert: ca.caCert.replace(/\n/g, ' ') } });
    if (rotated.pending !== false) throw new Error('expected a connection');
    expect(h.credentials.rows).toHaveLength(1);
    expect(h.credentials.rows[0].config.caCert).toBe(ca.caCert);
  });

  it('refuses a CA that is not a certificate before saving anything', async () => {
    const h = buildHarness();
    await expect(h.service.connect(admin, ORG, 'kubernetes', { input: { server, caCert: 'paste here', token: 'sa-token-value' } }))
      .rejects.toMatchObject({ response: { code: 'CONNECT_INPUT_INVALID', errors: [expect.stringMatching(/^caCert: CA certificate \(PEM\) is not a PEM certificate/)] } });
    expect(h.credentials.rows).toHaveLength(0);
  });
});
