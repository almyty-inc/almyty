import * as https from 'https';
import { AddressInfo } from 'net';

import { KubeApiClient, kubeConnectionFrom } from '../adapters/kubernetes/kube-api.client';
import { makeTestCa, TestCa } from '../../../common/security/__tests__/test-ca';

/**
 * The cluster CA as the connect form used to save it: one line, newlines
 * gone. The reconcile then failed with "unable to verify the first
 * certificate". The client must reach a TLS API server signed by that CA.
 */
describe('KubeApiClient over TLS with a pasted CA', () => {
  let ca: TestCa;
  let server: https.Server;
  let url: string;
  const seen: Array<{ path?: string; auth?: string }> = [];

  beforeAll(async () => {
    ca = makeTestCa('kube test CA');
    server = https.createServer({ cert: ca.serverCert, key: ca.serverKey }, (req, res) => {
      seen.push({ path: req.url, auth: req.headers.authorization });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ kind: 'Namespace', metadata: { name: 'runners' } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('hands the client a canonical PEM however the CA was pasted', () => {
    const flat = ca.caCert.replace(/\n/g, '');
    expect(kubeConnectionFrom({ server: url, token: 't', caCert: flat }).caCert).toBe(ca.caCert);
    expect(kubeConnectionFrom({ server: url, token: 't', caCert: ca.caCert.replace(/\n/g, ' ') }).caCert).toBe(ca.caCert);
    expect(kubeConnectionFrom({ server: url, token: 't', caCert: Buffer.from(ca.caCert).toString('base64') }).caCert).toBe(ca.caCert);
    expect(kubeConnectionFrom({ server: url, token: 't', caCert: '  ' }).caCert).toBeUndefined();
  });

  it('refuses a CA that is not a certificate with CREDENTIAL_INVALID', () => {
    expect(() => kubeConnectionFrom({ server: url, token: 't', caCert: 'PEM' })).toThrow(expect.objectContaining({ code: 'CREDENTIAL_INVALID' }));
  });

  it('reaches the API server with a CA saved on one line', async () => {
    const client = new KubeApiClient(kubeConnectionFrom({ server: url, token: 'sa-token', caCert: ca.caCert.replace(/\n/g, '') }));
    const ns = await client.get('Namespace', 'runners');
    expect(ns?.metadata.name).toBe('runners');
    expect(seen[seen.length - 1]).toEqual({ path: '/api/v1/namespaces/runners', auth: 'Bearer sa-token' });
  });
});
