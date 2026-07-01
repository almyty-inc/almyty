import { readFileSync } from 'fs';
import { resolve } from 'path';
import { signLicense, verifyLicense } from '../license-token';
import { DEFAULT_LICENSE_PUBLIC_KEY } from '../license.constants';
import { LicenseService } from '../license.service';

/**
 * Guards against the embedded default public key drifting out of sync with the
 * committed dev private key. If these ever mismatch, locally-minted dev tokens
 * silently stop working (and `mint-license.js` becomes useless).
 */
describe('dev keypair <-> built-in default public key', () => {
  const devPrivatePem = readFileSync(
    resolve(__dirname, '../../../../scripts/license/dev-private-key.pem'),
    'utf8',
  );

  it('a token signed by the dev private key verifies against DEFAULT_LICENSE_PUBLIC_KEY', () => {
    const token = signLicense(
      { entitlements: ['example_ee_feature'], limits: {}, expiresAt: null },
      devPrivatePem,
    );

    const result = verifyLicense(token, DEFAULT_LICENSE_PUBLIC_KEY);
    expect(result.valid).toBe(true);
  });

  it('LicenseService activates a dev-minted token using only the built-in default key', () => {
    const token = signLicense(
      { entitlements: ['example_ee_feature'], limits: { seats: 3 }, expiresAt: null },
      devPrivatePem,
    );

    const svc = new LicenseService();
    // No publicKeyPem override → uses DEFAULT_LICENSE_PUBLIC_KEY.
    svc.load({ token });

    expect(svc.has('example_ee_feature')).toBe(true);
    expect(svc.limit('seats')).toBe(3);
  });
});
