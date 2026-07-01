import { generateKeyPairSync } from 'crypto';
import { signLicense, verifyLicense, LicensePayload } from '../license-token';

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

const basePayload: LicensePayload = {
  entitlements: ['sso', 'advanced_rbac'],
  limits: { seats: 50 },
  expiresAt: null,
  issuedTo: 'acme-corp',
};

describe('license-token', () => {
  it('signs and verifies a valid perpetual token', () => {
    const { publicPem, privatePem } = keypair();
    const token = signLicense(basePayload, privatePem);
    const result = verifyLicense(token, publicPem);

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload.entitlements).toEqual(['sso', 'advanced_rbac']);
      expect(result.payload.limits.seats).toBe(50);
    }
  });

  it('accepts a base64-encoded PEM public key (env-var friendly)', () => {
    const { publicPem, privatePem } = keypair();
    const token = signLicense(basePayload, privatePem);
    const b64Key = Buffer.from(publicPem, 'utf8').toString('base64');

    expect(verifyLicense(token, b64Key).valid).toBe(true);
  });

  it('rejects a token whose payload was tampered with', () => {
    const { publicPem, privatePem } = keypair();
    const token = signLicense(basePayload, privatePem);

    const [version, payload, sig] = token.split('.');
    const forged: LicensePayload = { ...basePayload, entitlements: ['sso', 'byo_kms'] };
    const forgedPayload = Buffer.from(JSON.stringify(forged), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const tampered = `${version}.${forgedPayload}.${sig}`;

    const result = verifyLicense(tampered, publicPem);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('signature');
  });

  it('rejects a token signed by a different (attacker) key', () => {
    const victim = keypair();
    const attacker = keypair();
    const token = signLicense(basePayload, attacker.privatePem);

    const result = verifyLicense(token, victim.publicPem);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('signature');
  });

  it('rejects an expired token', () => {
    const { publicPem, privatePem } = keypair();
    const token = signLicense(
      { ...basePayload, expiresAt: new Date(Date.now() - 1000).toISOString() },
      privatePem,
    );

    const result = verifyLicense(token, publicPem);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('expired');
  });

  it('accepts a not-yet-expired token', () => {
    const { publicPem, privatePem } = keypair();
    const token = signLicense(
      { ...basePayload, expiresAt: new Date(Date.now() + 60_000).toISOString() },
      privatePem,
    );

    expect(verifyLicense(token, publicPem).valid).toBe(true);
  });

  it('rejects malformed tokens', () => {
    const { publicPem } = keypair();
    expect(verifyLicense('', publicPem)).toEqual({ valid: false, reason: 'malformed' });
    expect(verifyLicense('garbage', publicPem)).toEqual({ valid: false, reason: 'malformed' });
    expect(verifyLicense('v2.a.b', publicPem)).toEqual({ valid: false, reason: 'malformed' });
    expect(verifyLicense('v1.only-two', publicPem)).toEqual({
      valid: false,
      reason: 'malformed',
    });
  });
});
