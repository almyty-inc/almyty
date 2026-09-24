/**
 * What a version snapshot may keep.
 *
 * The version subscriber writes the whole entity into the `version` table
 * on every save of a @VersionedEntity, and nothing ever removes those rows
 * when the entity changes. For a credential that meant every secret it had
 * ever held stayed on disk: wiping or rotating a key rewrote the credential
 * row and left the old value, encrypted or not, in every earlier snapshot,
 * readable again through GET /versions and restorable through rollback.
 * Rotating a leaked key did not get rid of it.
 *
 * So a snapshot never holds a secret. A key is dropped when its name says
 * it is one, or its value is ciphertext from field-crypto (`encrypted:`),
 * which is only ever written for a secret. The Change History view still
 * shows what changed around it; it just cannot show the secret.
 */
import { isEncrypted } from './security/field-crypto';

/** Names that are a secret on their own, compared lowercase with separators removed. */
const SECRET_NAMES = new Set([
  'token',
  'key',
  'bearer',
  'certificate',
  'headervalue',
  'serviceaccountjson',
  'tokenid',
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
]);

/** Name endings that mark a secret: `clientSecret`, `bot_token`, `x-api-key`, ... */
const SECRET_SUFFIXES = [
  'secret',
  'password',
  'passwd',
  'passphrase',
  'apikey',
  'accesskey',
  'accesskeyid',
  'secretkey',
  'privatekey',
  'signingkey',
  'encryptionkey',
  'token',
];

/**
 * Whether a property of that name holds a secret. `maxTokens` and
 * `tokensPerMinute` do not end in `token`, so the counters stay.
 */
export function isSecretPropertyName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!normalized) return false;
  if (SECRET_NAMES.has(normalized)) return true;
  return SECRET_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function redact(value: unknown, depth: number): unknown {
  if (depth > 32 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretPropertyName(key)) continue;
    if (typeof inner === 'string' && isEncrypted(inner)) continue;
    out[key] = redact(inner, depth + 1);
  }
  return out;
}

/**
 * A copy of a serialized entity with every secret removed, at any depth.
 * Pure: the entity the caller is saving is not touched.
 */
export function redactVersionSnapshot<T>(snapshot: T): T {
  return redact(snapshot, 0) as T;
}
