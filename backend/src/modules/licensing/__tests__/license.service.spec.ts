import { generateKeyPairSync } from 'crypto';
import { LicenseService } from '../license.service';
import { signLicense, LicensePayload } from '../license-token';
import {
  EDITION_COMMUNITY,
  EDITION_ENTERPRISE,
  EE_ENTITLEMENTS,
  UNLIMITED,
} from '../license.constants';

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

describe('LicenseService', () => {
  it('defaults to the community edition when no token is present', () => {
    const svc = new LicenseService();
    svc.load({ token: '' });

    expect(svc.getEdition()).toBe(EDITION_COMMUNITY);
    expect(svc.isCommunity()).toBe(true);
    // Core features on...
    expect(svc.has('agents')).toBe(true);
    expect(svc.has('byok')).toBe(true);
    // ...EE features off.
    expect(svc.has(EE_ENTITLEMENTS.SSO)).toBe(false);
    expect(svc.has(EE_ENTITLEMENTS.ADVANCED_RBAC)).toBe(false);
  });

  it('unlocks EE features from a valid signed token and unions the community set', () => {
    const { publicPem, privatePem } = keypair();
    const payload: LicensePayload = {
      entitlements: [EE_ENTITLEMENTS.SSO, EE_ENTITLEMENTS.AUDIT_EXPORT],
      limits: { seats: 25 },
      expiresAt: null,
      issuedTo: 'acme',
    };
    const token = signLicense(payload, privatePem);

    const svc = new LicenseService();
    svc.load({ publicKeyPem: publicPem, token });

    expect(svc.getEdition()).toBe(EDITION_ENTERPRISE);
    expect(svc.has(EE_ENTITLEMENTS.SSO)).toBe(true);
    expect(svc.has(EE_ENTITLEMENTS.AUDIT_EXPORT)).toBe(true);
    // EE feature NOT in the token stays denied.
    expect(svc.has(EE_ENTITLEMENTS.BYO_KMS)).toBe(false);
    // Community features still granted.
    expect(svc.has('agents')).toBe(true);
    // Limits resolve.
    expect(svc.limit('seats')).toBe(25);
    expect(svc.limit('unset')).toBe(UNLIMITED);
  });

  it('falls back to community when the token is tampered', () => {
    const { publicPem, privatePem } = keypair();
    const token = signLicense(
      { entitlements: [EE_ENTITLEMENTS.SSO], limits: {}, expiresAt: null },
      privatePem,
    );
    const tampered = token.slice(0, -4) + 'AAAA';

    const svc = new LicenseService();
    svc.load({ publicKeyPem: publicPem, token: tampered });

    expect(svc.isCommunity()).toBe(true);
    expect(svc.has(EE_ENTITLEMENTS.SSO)).toBe(false);
  });

  it('falls back to community when the token is expired', () => {
    const { publicPem, privatePem } = keypair();
    const token = signLicense(
      {
        entitlements: [EE_ENTITLEMENTS.SSO],
        limits: {},
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      },
      privatePem,
    );

    const svc = new LicenseService();
    svc.load({ publicKeyPem: publicPem, token });

    expect(svc.isCommunity()).toBe(true);
    expect(svc.has(EE_ENTITLEMENTS.SSO)).toBe(false);
  });

  it('falls back to community when the token was signed by the wrong key', () => {
    const attacker = keypair();
    const deployment = keypair();
    const token = signLicense(
      { entitlements: [EE_ENTITLEMENTS.SSO], limits: {}, expiresAt: null },
      attacker.privatePem,
    );

    const svc = new LicenseService();
    svc.load({ publicKeyPem: deployment.publicPem, token });

    expect(svc.isCommunity()).toBe(true);
    expect(svc.has(EE_ENTITLEMENTS.SSO)).toBe(false);
  });

  it('reads token + public key from env when no options are given', () => {
    const { publicPem, privatePem } = keypair();
    const token = signLicense(
      { entitlements: [EE_ENTITLEMENTS.SSO], limits: {}, expiresAt: null },
      privatePem,
    );
    process.env.ALMYTY_LICENSE_PUBLIC_KEY = publicPem;
    process.env.ALMYTY_LICENSE_KEY = token;

    try {
      const svc = new LicenseService();
      svc.load();
      expect(svc.has(EE_ENTITLEMENTS.SSO)).toBe(true);
    } finally {
      delete process.env.ALMYTY_LICENSE_PUBLIC_KEY;
      delete process.env.ALMYTY_LICENSE_KEY;
    }
  });

  it('produces a serializable snapshot', () => {
    const svc = new LicenseService();
    svc.load({ token: '' });
    const snap = svc.snapshot();

    expect(snap.edition).toBe(EDITION_COMMUNITY);
    expect(Array.isArray(snap.entitlements)).toBe(true);
    expect(snap.entitlements).toContain('agents');
    expect(snap.entitlements).not.toContain(EE_ENTITLEMENTS.SSO);
  });
});
