import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/**
 * Authenticated field-level encryption for secrets stored in JSON columns
 * (e.g. an LLM provider's API key). Same AES-256-GCM scheme and key
 * derivation as the Credential entity, so a single ENCRYPTION_KEY covers
 * both.
 *
 *   ciphertext format: `encrypted:gcm:<iv-hex>:<authTag-hex>:<ct-hex>`
 *
 * decryptField also understands the legacy unauthenticated CBC format
 * (`encrypted:<iv>:<ct>`) for read compatibility, and returns any value
 * that isn't prefixed `encrypted:` unchanged — so a plaintext (not yet
 * migrated) value passes straight through.
 */

let warned = false;

function getKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'ENCRYPTION_KEY environment variable is required in production.',
      );
    }
    if (!warned) {
      // eslint-disable-next-line no-console
      console.warn(
        '[SECURITY WARNING] ENCRYPTION_KEY not set. Using default key (dev/test only). Set ENCRYPTION_KEY in production!',
      );
      warned = true;
    }
  }
  return createHash('sha256')
    .update(key || 'default-encryption-key-change-me!')
    .digest();
}

export function isEncrypted(value: string): boolean {
  return typeof value === 'string' && value.startsWith('encrypted:');
}

/**
 * Prefix for customer-managed (BYO-KMS) envelope values. A column may hold a
 * mix of `encrypted:kms:` (customer CMK) and `encrypted:gcm:` (platform) rows;
 * routing is by prefix so platform/plaintext values are never misread.
 */
export const KMS_ENVELOPE_PREFIX = 'encrypted:kms:';

export function isKmsEnvelope(value: string): boolean {
  return typeof value === 'string' && value.startsWith(KMS_ENVELOPE_PREFIX);
}

/**
 * Synchronous unwrap hook for `encrypted:kms:` values, registered by
 * `EnvelopeCryptoService` at module init. It decrypts from the in-process DEK
 * cache, so callers on the sync read path (entity methods) must have warmed the
 * org's DEK first (via `EnvelopeCryptoService.warmOrg`). When no hook is
 * registered (KMS module absent) or the value isn't a kms envelope, the
 * platform path runs unchanged — so non-KMS deployments and existing
 * gcm/cbc/plaintext values behave exactly as before.
 */
export type EnvelopeUnwrapHook = (organizationId: string, value: string) => string;
let envelopeUnwrapHook: EnvelopeUnwrapHook | null = null;

export function registerEnvelopeUnwrapHook(hook: EnvelopeUnwrapHook | null): void {
  envelopeUnwrapHook = hook;
}

export function encryptField(value: string): string {
  const iv = randomBytes(12); // 96-bit IV, GCM standard
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  let ct = cipher.update(value, 'utf8', 'hex');
  ct += cipher.final('hex');
  const tag = cipher.getAuthTag();
  return `encrypted:gcm:${iv.toString('hex')}:${tag.toString('hex')}:${ct}`;
}

/**
 * Decrypt a stored field. Routing is by the stored ciphertext prefix:
 *  - `encrypted:kms:` (customer-managed) delegates to the registered envelope
 *    unwrap hook — `organizationId` is required to pick the org's DEK.
 *  - `encrypted:gcm:` / legacy `encrypted:` / plaintext take the unchanged
 *    platform path, so existing data keeps decrypting regardless of KMS state.
 */
export function decryptField(value: string, organizationId?: string): string {
  if (isKmsEnvelope(value)) {
    if (!envelopeUnwrapHook) {
      throw new Error(
        'Encountered a customer-managed (encrypted:kms:) value but no envelope ' +
          'unwrap hook is registered. Is KmsModule loaded?',
      );
    }
    if (!organizationId) {
      throw new Error(
        'Cannot decrypt a customer-managed (encrypted:kms:) value without an ' +
          'organizationId to select the CMK-wrapped DEK.',
      );
    }
    return envelopeUnwrapHook(organizationId, value);
  }

  if (!isEncrypted(value)) return value; // plaintext / not-yet-migrated

  const parts = value.split(':');
  if (parts.length < 3) {
    throw new Error('Malformed encrypted value: expected `encrypted:[gcm:]<iv>:<...>`');
  }
  const key = getKey();

  // New format: encrypted:gcm:<iv>:<authTag>:<ct>
  if (parts[1] === 'gcm') {
    if (parts.length !== 5) {
      throw new Error('Malformed encrypted value: expected `encrypted:gcm:<iv>:<authTag>:<ct>`');
    }
    const iv = Buffer.from(parts[2], 'hex');
    const tag = Buffer.from(parts[3], 'hex');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    let pt = decipher.update(parts[4], 'hex', 'utf8');
    pt += decipher.final('utf8');
    return pt;
  }

  // Legacy format: encrypted:<iv>:<ct> (AES-256-CBC, read-only support).
  const iv = Buffer.from(parts[1], 'hex');
  const ct = parts.slice(2).join(':');
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  let pt = decipher.update(ct, 'hex', 'utf8');
  pt += decipher.final('utf8');
  return pt;
}
