import * as crypto from 'crypto';

/**
 * How a webhook channel checks that a delivery came from its sender.
 *
 * Every sender signs differently: the header the signature travels in,
 * the hash, hex or base64, a scheme prefix such as `v1=` or `sha256=`, and
 * what exactly was signed (the body, or a timestamp header and the body).
 * All of it is channel configuration, so any service that signs with an
 * HMAC of a shared secret can call the channel; no sender is named in
 * code. The defaults are almyty's own scheme: `X-Webhook-Signature`, the
 * hex HMAC-SHA256 of the raw body, no prefix.
 *
 * Configuration keys (all optional, beside `secret`):
 *   signature_header     header carrying the signature
 *   signature_algorithm  sha256 | sha1 | sha512
 *   signature_encoding   hex | base64
 *   signature_prefix     scheme prefix in front of each signature (`v1=`)
 *   signed_content       what was signed: `{body}` is the raw body,
 *                        `{header:Name}` a request header, e.g.
 *                        `{header:X-Timestamp}.{body}`
 *
 * A header may carry several signatures separated by commas (senders do
 * this while rotating secrets); any one that matches is enough.
 */
export const WEBHOOK_SIGNATURE_ALGORITHMS = ['sha256', 'sha1', 'sha512'] as const;
export const WEBHOOK_SIGNATURE_ENCODINGS = ['hex', 'base64'] as const;

export type WebhookSignatureAlgorithm = (typeof WEBHOOK_SIGNATURE_ALGORITHMS)[number];
export type WebhookSignatureEncoding = (typeof WEBHOOK_SIGNATURE_ENCODINGS)[number];

export interface WebhookSignatureSettings {
  header: string;
  algorithm: WebhookSignatureAlgorithm;
  encoding: WebhookSignatureEncoding;
  prefix: string;
  signedContent: string;
}

export const WEBHOOK_SIGNATURE_DEFAULTS: Readonly<WebhookSignatureSettings> = Object.freeze({
  header: 'X-Webhook-Signature',
  algorithm: 'sha256',
  encoding: 'hex',
  prefix: '',
  signedContent: '{body}',
});

const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * The channel's signature settings, defaults filled in. Throws on a value
 * that cannot be honoured (an unknown algorithm, a malformed header name):
 * a typo must not quietly fall back to a scheme the sender does not use.
 */
export function webhookSignatureSettings(config: Record<string, any> | null | undefined): WebhookSignatureSettings {
  const c = config ?? {};
  const header = text(c.signature_header) ?? WEBHOOK_SIGNATURE_DEFAULTS.header;
  if (!HEADER_NAME_RE.test(header)) throw new Error(`signature_header is not a header name: ${JSON.stringify(header)}`);
  const algorithm = (text(c.signature_algorithm)?.toLowerCase() ?? WEBHOOK_SIGNATURE_DEFAULTS.algorithm) as WebhookSignatureAlgorithm;
  if (!WEBHOOK_SIGNATURE_ALGORITHMS.includes(algorithm)) {
    throw new Error(`signature_algorithm must be one of ${WEBHOOK_SIGNATURE_ALGORITHMS.join(', ')}`);
  }
  const encoding = (text(c.signature_encoding)?.toLowerCase() ?? WEBHOOK_SIGNATURE_DEFAULTS.encoding) as WebhookSignatureEncoding;
  if (!WEBHOOK_SIGNATURE_ENCODINGS.includes(encoding)) {
    throw new Error(`signature_encoding must be one of ${WEBHOOK_SIGNATURE_ENCODINGS.join(', ')}`);
  }
  // The prefix is compared as written: `v1=` and `sha256=` are literal.
  const prefix = typeof c.signature_prefix === 'string' ? c.signature_prefix.trim() : WEBHOOK_SIGNATURE_DEFAULTS.prefix;
  const signedContent = text(c.signed_content) ?? WEBHOOK_SIGNATURE_DEFAULTS.signedContent;
  if (!signedContent.includes('{body}')) throw new Error('signed_content must include {body}');
  return { header, algorithm, encoding, prefix, signedContent };
}

function headerValue(headers: Record<string, any>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() !== lower) continue;
    const v = Array.isArray(value) ? value.join(',') : value;
    return typeof v === 'string' ? v : v === undefined || v === null ? undefined : String(v);
  }
  return undefined;
}

/**
 * The bytes the sender signed, built from the template. Null when the
 * template names a header the request does not carry (fail closed).
 */
export function signedContentOf(template: string, body: string, headers: Record<string, any>): string | null {
  let missing = false;
  const out = template.replace(/\{body\}|\{header:([^}]+)\}/g, (match, name?: string) => {
    if (match === '{body}') return body;
    const v = headerValue(headers, String(name).trim());
    if (v === undefined) missing = true;
    return v ?? '';
  });
  return missing ? null : out;
}

/** The signature candidates a header value carries, prefix removed. */
export function signatureCandidates(value: string, prefix: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .filter((part) => !prefix || part.startsWith(prefix))
    .map((part) => (prefix ? part.slice(prefix.length) : part).trim());
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  // Length first: timingSafeEqual throws on mismatched lengths.
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Does this delivery carry a valid signature under the channel's settings?
 * False without a secret, without the header, with settings that cannot be
 * honoured, or when no candidate matches.
 */
export function verifyWebhookSignature(
  config: Record<string, any> | null | undefined,
  headers: Record<string, any>,
  rawBody: string,
): boolean {
  const secret = config?.secret;
  if (typeof secret !== 'string' || secret.length === 0) return false;
  let settings: WebhookSignatureSettings;
  try {
    settings = webhookSignatureSettings(config);
  } catch {
    return false;
  }
  const sent = headerValue(headers, settings.header);
  if (!sent) return false;
  const content = signedContentOf(settings.signedContent, rawBody, headers);
  if (content === null) return false;
  const expected = crypto.createHmac(settings.algorithm, secret).update(content).digest(settings.encoding);
  // hex is compared case-insensitively (senders differ); base64 is exact.
  const norm = (s: string) => (settings.encoding === 'hex' ? s.toLowerCase() : s);
  return signatureCandidates(sent, settings.prefix).some((candidate) => sameSecret(norm(expected), norm(candidate)));
}
