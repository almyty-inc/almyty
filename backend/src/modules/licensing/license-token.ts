/**
 * Offline-verifiable license token: an Ed25519-signed, base64url-encoded
 * payload. Format (JWT-like but Ed25519-only, no alg confusion surface):
 *
 *   v1.<base64url(payloadJson)>.<base64url(signature)>
 *
 * The signature covers the ASCII string `v1.<base64url(payloadJson)>`.
 * Verification needs only the public key, so an air-gapped EE deployment can
 * validate its license without calling home.
 */
import {
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
  KeyObject,
} from 'crypto';

export interface LicensePayload {
  /** Feature flags unlocked by this license. */
  entitlements: string[];
  /** Numeric limits keyed by name (e.g. seats). Absent key = uncapped. */
  limits: Record<string, number>;
  /** ISO-8601 expiry, or null for a perpetual license. */
  expiresAt: string | null;
  /** Optional: who the license was issued to (org/customer name). */
  issuedTo?: string;
  /** Optional: ISO-8601 issue time. */
  issuedAt?: string;
}

/**
 * Result of an offline verification. `valid` is the discriminant; `reason` is
 * populated on failure and `payload` when the token could be decoded. Kept as a
 * flat interface (not a discriminated union) because this backend compiles with
 * `strictNullChecks: false`, where union narrowing is unreliable.
 */
export interface VerifyResult {
  valid: boolean;
  reason?: 'malformed' | 'signature' | 'expired';
  payload?: LicensePayload;
}

const TOKEN_VERSION = 'v1';

function base64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str: string): Buffer {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function toPublicKey(key: string | KeyObject): KeyObject {
  if (typeof key !== 'string') return key;
  // Accept raw PEM or base64-encoded PEM (env-var friendly).
  const pem = key.includes('BEGIN') ? key : Buffer.from(key, 'base64').toString('utf8');
  return createPublicKey(pem);
}

function toPrivateKey(key: string | KeyObject): KeyObject {
  if (typeof key !== 'string') return key;
  const pem = key.includes('BEGIN') ? key : Buffer.from(key, 'base64').toString('utf8');
  return createPrivateKey(pem);
}

/**
 * Sign a license payload with an Ed25519 private key. Used by the dev/EE
 * minting tooling and by tests — never at request time.
 */
export function signLicense(payload: LicensePayload, privateKey: string | KeyObject): string {
  const payloadPart = base64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signingInput = `${TOKEN_VERSION}.${payloadPart}`;
  const signature = edSign(null, Buffer.from(signingInput, 'utf8'), toPrivateKey(privateKey));
  return `${signingInput}.${base64urlEncode(signature)}`;
}

/**
 * Verify a token offline against an Ed25519 public key. Returns a discriminated
 * result; a tampered signature or an expired token is rejected. Never throws on
 * malformed input — callers fall back to the community entitlement set.
 */
export function verifyLicense(token: string, publicKey: string | KeyObject): VerifyResult {
  if (!token || typeof token !== 'string') return { valid: false, reason: 'malformed' };

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) {
    return { valid: false, reason: 'malformed' };
  }

  const [version, payloadPart, sigPart] = parts;
  const signingInput = `${version}.${payloadPart}`;

  let signatureOk = false;
  try {
    signatureOk = edVerify(
      null,
      Buffer.from(signingInput, 'utf8'),
      toPublicKey(publicKey),
      base64urlDecode(sigPart),
    );
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  if (!signatureOk) return { valid: false, reason: 'signature' };

  let payload: LicensePayload;
  try {
    payload = JSON.parse(base64urlDecode(payloadPart).toString('utf8'));
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  if (
    !payload ||
    !Array.isArray(payload.entitlements) ||
    typeof payload.limits !== 'object' ||
    payload.limits === null
  ) {
    return { valid: false, reason: 'malformed' };
  }

  if (payload.expiresAt) {
    const expMs = Date.parse(payload.expiresAt);
    if (Number.isNaN(expMs) || expMs <= Date.now()) {
      return { valid: false, reason: 'expired', payload };
    }
  }

  return { valid: true, payload };
}
