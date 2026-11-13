import { createHash } from 'crypto';

/**
 * What a credential response shows in place of a stored secret: that one
 * is there, and nothing of it. Not its first or last characters, not its
 * length. Every list and read of a credential's config goes through
 * redactSecrets(); src/test/__tests__/credential-responses-no-secret.spec.ts
 * holds every such response to it.
 */
export const SECRET_PRESENT = '********';

// Field names (lower-cased, punctuation dropped, so x-api-key reads as
// xapikey) that hold a secret. Anything ending in "key" is one too
// (apikey, privatekey, clientkey, secretkey); the names that only point
// at one (tokenUrl, keyHeader, credentialId) are let through below.
const SECRET_NAME = /(password|passphrase|passwd|secret|token|apikey|accesskey|privatekey|credential|headervalue|bearer|serviceaccount|authorization|cookie|kubeconfig|signature|keystore|pfx|p12|pem)|key$/;
const POINTER_NAME = /(url|uri|endpoint|type|name|location|header|query|prefix|expiresat|expiry|scope|scopes|id|ids)$/;

const normalise = (field: string): string => field.toLowerCase().replace(/[^a-z0-9]/g, '');

/** True when a config field of this name holds a secret. */
export function isSecretFieldName(field: string): boolean {
  const name = normalise(field);
  return SECRET_NAME.test(name) && !POINTER_NAME.test(name);
}

/**
 * A copy of `config` with every secret value replaced by SECRET_PRESENT:
 * fields named like a secret, any value encrypted at rest, and every value
 * in a headers map or list (header values are where keys travel).
 */
export function redactSecrets<T>(config: T): T {
  return redact(config, false) as T;
}

const HEADER_NAME_FIELDS = new Set(['name', 'key', 'header']);

/**
 * `hidden`: the value sits under a secret name or in a headers map, so
 * every string in it is hidden. `headers`: inside a headers list, where
 * every string is hidden except an entry's name/key/header (the header's
 * name).
 */
function redact(value: unknown, hidden: boolean, headers = false): unknown {
  if (typeof value === 'string') {
    if (value.startsWith('encrypted:')) return SECRET_PRESENT;
    return (hidden || headers) && value ? SECRET_PRESENT : value;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, hidden, headers));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const isHeaders = normalise(k).endsWith('headers');
      if (headers && HEADER_NAME_FIELDS.has(k.toLowerCase()) && typeof v === 'string') out[k] = v;
      else if (isHeaders && Array.isArray(v)) out[k] = redact(v, hidden, true);
      else out[k] = redact(v, hidden || isSecretFieldName(k) || isHeaders, headers);
    }
    return out;
  }
  return value;
}

/**
 * A short, one-way label for a secret, for when a person has to tell two
 * stored keys apart: `sha256:` and the first 8 hex digits of its hash.
 * Never derived from the secret's own characters.
 */
export function secretFingerprint(secret: string): string {
  return `sha256:${createHash('sha256').update(secret).digest('hex').slice(0, 8)}`;
}
