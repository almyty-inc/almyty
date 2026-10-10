import * as https from 'https';
import { AddressInfo } from 'net';

import { PemCertificateError, normalizePemCertificates } from '../pem-certificate';
import { normalizeFormattedFields } from '../../../modules/connections/connector-schema';
import { makeTestCa, TestCa } from './test-ca';

/**
 * Pasted certificate text loses its newlines (a single-line form input, a
 * chat, a terminal) and Node's TLS then fails every call with "unable to
 * verify the first certificate". The normaliser puts the PEM back.
 */
describe('normalizePemCertificates', () => {
  let ca: TestCa;
  let other: TestCa;

  beforeAll(() => {
    ca = makeTestCa('almyty test CA');
    other = makeTestCa('another test CA');
  });

  const flatten = (pem: string) => pem.replace(/\r?\n/g, '');

  it('keeps a canonical PEM as it is', () => {
    expect(normalizePemCertificates(ca.caCert)).toBe(ca.caCert);
  });

  it('restores a PEM whose newlines were stripped', () => {
    expect(flatten(ca.caCert)).not.toContain('\n');
    expect(normalizePemCertificates(flatten(ca.caCert))).toBe(ca.caCert);
  });

  it('restores a PEM whose newlines became spaces', () => {
    expect(normalizePemCertificates(ca.caCert.replace(/\n/g, ' '))).toBe(ca.caCert);
  });

  it('restores CRLF line endings and surrounding whitespace', () => {
    expect(normalizePemCertificates(`\r\n  ${ca.caCert.replace(/\n/g, '\r\n')}  \r\n`)).toBe(ca.caCert);
  });

  it('keeps every certificate of a bundle, in order', () => {
    const bundle = flatten(other.caCert) + ' ' + flatten(ca.caCert);
    expect(normalizePemCertificates(bundle)).toBe(`${other.caCert}${ca.caCert}`);
  });

  it('decodes base64 of a PEM, as kubeconfig certificate-authority-data carries it', () => {
    const data = Buffer.from(ca.caCert).toString('base64');
    expect(normalizePemCertificates(data)).toBe(ca.caCert);
    // Wrapped base64 too.
    expect(normalizePemCertificates(data.replace(/(.{76})/g, '$1\n'))).toBe(ca.caCert);
  });

  it.each([
    ['plain words', 'PEM'],
    ['base64 of something that is not a PEM', Buffer.from('hello world').toString('base64')],
    ['a BEGIN line with no END line', '-----BEGIN CERTIFICATE-----MIIB'],
    ['a body that is not base64', '-----BEGIN CERTIFICATE-----not base64!!-----END CERTIFICATE-----'],
    ['a body that is base64 but no certificate', `-----BEGIN CERTIFICATE-----${Buffer.from('x'.repeat(60)).toString('base64')}-----END CERTIFICATE-----`],
    ['a private key', '-----BEGIN PRIVATE KEY-----MIIB-----END PRIVATE KEY-----'],
    ['only whitespace', '   \n '],
  ])('refuses %s with CREDENTIAL_INVALID', (_label, input) => {
    let error: unknown;
    try {
      normalizePemCertificates(input);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PemCertificateError);
    expect((error as PemCertificateError).code).toBe('CREDENTIAL_INVALID');
    expect((error as Error).message).toMatch(/certificate/i);
  });

  it('normalises format: pem fields of a connect form and nothing else', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        server: { type: 'string' as const, format: 'uri' },
        caCert: { type: 'string' as const, title: 'CA certificate (PEM)', format: 'pem' },
      },
    };
    const ok = normalizeFormattedFields({ server: 'https://x ', caCert: flatten(ca.caCert) }, schema);
    expect(ok.errors).toEqual([]);
    expect(ok.values).toEqual({ server: 'https://x ', caCert: ca.caCert });

    const bad = normalizeFormattedFields({ server: 'https://x', caCert: 'not a cert' }, schema);
    expect(bad.errors).toHaveLength(1);
    expect(bad.errors[0]).toMatch(/^caCert: CA certificate \(PEM\) is not a PEM certificate/);

    expect(normalizeFormattedFields({ server: 'https://x' }, schema)).toEqual({ values: { server: 'https://x' }, errors: [] });
  });

  describe('against a TLS server', () => {
    let server: https.Server;
    let port: number;

    beforeAll(async () => {
      server = https.createServer({ cert: ca.serverCert, key: ca.serverKey }, (_req, res) => res.end('ok'));
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const get = (ca: string) =>
      new Promise<number>((resolve, reject) => {
        const req = https.request({ host: '127.0.0.1', port, path: '/', method: 'GET', ca, agent: false }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', reject);
        req.end();
      });

    it('a flattened CA fails as it did on staging', async () => {
      await expect(get(flatten(ca.caCert))).rejects.toThrow(/unable to verify the first certificate/);
    });

    it('the same CA connects once normalised, alone or in a bundle', async () => {
      expect(await get(normalizePemCertificates(flatten(ca.caCert)))).toBe(200);
      expect(await get(normalizePemCertificates(`${flatten(other.caCert)}${flatten(ca.caCert)}`))).toBe(200);
    });
  });
});
