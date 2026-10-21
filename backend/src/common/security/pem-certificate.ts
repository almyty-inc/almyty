import { X509Certificate } from 'crypto';

/**
 * Turns pasted certificate text into the PEM that TLS accepts.
 *
 * A CA certificate reaches us through a connect form, and a single-line
 * input (or a chat, or a terminal) loses its newlines. Node's TLS then
 * cannot read the bundle and every call fails with "unable to verify the
 * first certificate". So: take every BEGIN/END CERTIFICATE block, drop
 * the whitespace inside its base64 body and wrap that at 64 characters.
 * Bundles keep every certificate, in order.
 *
 * Text without BEGIN/END markers is read as base64 of a PEM, which is how
 * a kubeconfig carries it (`certificate-authority-data`). Anything that is
 * not a certificate is refused with CREDENTIAL_INVALID rather than stored
 * and failing later at the first TLS handshake.
 *
 * The scan uses indexOf, not a regex over the whole input, and the input
 * is capped, so pasted junk cannot hold the event loop.
 */

const BEGIN = '-----BEGIN CERTIFICATE-----';
const END = '-----END CERTIFICATE-----';
const MAX_INPUT = 256 * 1024;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const HINT = 'paste the PEM text from -----BEGIN CERTIFICATE----- to -----END CERTIFICATE-----, or the base64 certificate-authority-data from a kubeconfig';

export class PemCertificateError extends Error {
  readonly code = 'CREDENTIAL_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'PemCertificateError';
  }
}

function wrap(body: string): string {
  const lines: string[] = [];
  for (let i = 0; i < body.length; i += 64) lines.push(body.slice(i, i + 64));
  return `${BEGIN}\n${lines.join('\n')}\n${END}`;
}

/** base64 of a PEM (kubeconfig certificate-authority-data), decoded; null when it is not that. */
function decodeBase64Pem(text: string): string | null {
  const compact = text.replace(/\s+/g, '');
  if (!compact || compact.length % 4 !== 0 || !BASE64.test(compact)) return null;
  const decoded = Buffer.from(compact, 'base64').toString('utf8');
  return decoded.includes(BEGIN) ? decoded : null;
}

/**
 * The certificates in `input`, one canonical PEM block each, joined by
 * newlines and ending with one. Throws PemCertificateError (code
 * CREDENTIAL_INVALID) when the text holds no readable certificate.
 */
export function normalizePemCertificates(input: string, label = 'the CA certificate'): string {
  if (typeof input !== 'string') throw new PemCertificateError(`${label} must be text: ${HINT}`);
  if (input.length > MAX_INPUT) throw new PemCertificateError(`${label} is too large`);
  let text = input.trim();
  if (!text) throw new PemCertificateError(`${label} is empty: ${HINT}`);
  if (!text.includes(BEGIN)) {
    const decoded = decodeBase64Pem(text);
    if (!decoded) throw new PemCertificateError(`${label} is not a PEM certificate: ${HINT}`);
    text = decoded;
  }

  const blocks: string[] = [];
  let at = 0;
  for (;;) {
    const begin = text.indexOf(BEGIN, at);
    if (begin < 0) break;
    const end = text.indexOf(END, begin + BEGIN.length);
    if (end < 0) throw new PemCertificateError(`${label} has a BEGIN CERTIFICATE line with no END CERTIFICATE line`);
    const body = text.slice(begin + BEGIN.length, end).replace(/\s+/g, '');
    if (!body || body.length % 4 !== 0 || !BASE64.test(body)) {
      throw new PemCertificateError(`certificate ${blocks.length + 1} of ${label} is not valid base64: ${HINT}`);
    }
    const pem = wrap(body);
    try {
      new X509Certificate(pem);
    } catch {
      throw new PemCertificateError(`certificate ${blocks.length + 1} of ${label} is not a readable X.509 certificate`);
    }
    blocks.push(pem);
    at = end + END.length;
  }
  if (blocks.length === 0) throw new PemCertificateError(`${label} holds no certificate: ${HINT}`);
  return `${blocks.join('\n')}\n`;
}
