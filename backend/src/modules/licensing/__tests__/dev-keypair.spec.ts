import { generateKeyPairSync } from 'crypto';
import { signLicense, verifyLicense } from '../license-token';
import { LicenseService } from '../license.service';

/**
 * Round-trips the Ed25519 sign/verify path and LicenseService activation
 * using an EPHEMERAL keypair generated at test time.
 *
 * We deliberately do NOT commit a private key to the repo: secret scanning
 * blocks it, and — more importantly — the embedded DEFAULT_LICENSE_PUBLIC_KEY
 * is a verification key whose private counterpart must never live in git, or
 * anyone with the source could forge valid entitlement tokens. For local dev,
 * `mint-license.js` takes the signing key via `--key`/env instead.
 */
describe('license keypair sign/verify round-trip', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  it('a token signed by a private key verifies against its public key', () => {
    const token = signLicense(
      { entitlements: ['example_ee_feature'], limits: {}, expiresAt: null },
      privateKey,
    );
    expect(verifyLicense(token, publicKey).valid).toBe(true);
  });

  it('LicenseService activates a signed token via a public-key override', () => {
    const token = signLicense(
      { entitlements: ['example_ee_feature'], limits: { seats: 3 }, expiresAt: null },
      privateKey,
    );

    const svc = new LicenseService();
    svc.load({ token, publicKeyPem: publicKey });

    expect(svc.has('example_ee_feature')).toBe(true);
    expect(svc.limit('seats')).toBe(3);
  });

  it('rejects a token whose signature does not match the public key', () => {
    const other = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const token = signLicense(
      { entitlements: ['example_ee_feature'], limits: {}, expiresAt: null },
      privateKey,
    );
    expect(verifyLicense(token, other.publicKey).valid).toBe(false);
  });
});
