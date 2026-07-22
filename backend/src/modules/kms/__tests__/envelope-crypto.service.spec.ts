import { EnvelopeCryptoService } from '../envelope-crypto.service';
import { KmsClientFactory, KmsKeyRef } from '../kms.service';
import { OrgKmsConfig } from '../../../entities/org-kms-config.entity';
import { EE_ENTITLEMENTS } from '../../licensing/license.constants';
import {
  decryptField,
  isEncrypted,
} from '../../../common/security/field-crypto';

/**
 * Deterministic in-memory stand-in for the AWS KMS client. `encrypt` prefixes
 * a marker + XORs the DEK with a per-key stream; `decrypt` reverses it. No AWS
 * SDK, no network, no credentials — a wrapped blob round-trips exactly.
 *
 * `failDecrypt` makes `decrypt` throw, modeling a denied/rotated CMK so we can
 * assert the crypto layer surfaces the error instead of leaking plaintext.
 */
class FakeKmsClientFactory {
  failDecrypt = false;
  encryptCalls: Array<{ ref: KmsKeyRef; plaintext: Buffer }> = [];
  decryptCalls: Array<{ ref: KmsKeyRef; ciphertext: Buffer }> = [];

  private mask(keyArn: string, buf: Buffer): Buffer {
    const seed = Buffer.from(keyArn);
    const out = Buffer.alloc(buf.length);
    for (let i = 0; i < buf.length; i++) {
      out[i] = buf[i] ^ seed[i % seed.length];
    }
    return out;
  }

  async encrypt(ref: KmsKeyRef, plaintext: Buffer): Promise<Buffer> {
    this.encryptCalls.push({ ref, plaintext });
    // Prepend a marker so a "wrapped" blob is visibly not the raw DEK.
    return Buffer.concat([Buffer.from('KMS:'), this.mask(ref.keyArn, plaintext)]);
  }

  async decrypt(ref: KmsKeyRef, ciphertext: Buffer): Promise<Buffer> {
    this.decryptCalls.push({ ref, ciphertext });
    if (this.failDecrypt) {
      throw new Error('KMS AccessDeniedException: not authorized to Decrypt');
    }
    const marker = ciphertext.subarray(0, 4).toString();
    if (marker !== 'KMS:') {
      throw new Error('KMS InvalidCiphertext');
    }
    return this.mask(ref.keyArn, ciphertext.subarray(4));
  }
}

class FakeKmsConfigRepo {
  rows: OrgKmsConfig[] = [];
  async findOne({ where }: any): Promise<OrgKmsConfig | null> {
    return (
      this.rows.find((r) =>
        Object.entries(where).every(([k, v]) => (r as any)[k] === v),
      ) ?? null
    );
  }
}

class FakeOrgLicenseResolver {
  entitled = new Set<string>();
  async hasForOrg(_orgId: string, entitlement: string): Promise<boolean> {
    return this.entitled.has(entitlement);
  }
}

const CMK_ARN =
  'arn:aws:kms:us-east-1:123456789012:key/abcd1234-ab12-cd34-ef56-abcdef123456';

/**
 * Provision an org config the way the provisioning service would: mint a random
 * 32-byte DEK, wrap it via the fake KMS, store the base64 wrapped blob.
 */
async function provision(
  kms: FakeKmsClientFactory,
  repo: FakeKmsConfigRepo,
  organizationId: string,
  opts: { enabled?: boolean } = {},
) {
  const dek = require('crypto').randomBytes(32) as Buffer;
  const wrapped = await kms.encrypt({ keyArn: CMK_ARN, region: 'us-east-1' }, dek);
  repo.rows.push({
    id: `k_${organizationId}`,
    organizationId,
    enabled: opts.enabled ?? true,
    cmkArn: CMK_ARN,
    awsRegion: 'us-east-1',
    wrappedDek: wrapped.toString('base64'),
    createdAt: new Date(),
    updatedAt: new Date(),
  } as OrgKmsConfig);
  return dek;
}

describe('EnvelopeCryptoService', () => {
  let kms: FakeKmsClientFactory;
  let repo: FakeKmsConfigRepo;
  let license: FakeOrgLicenseResolver;
  let service: EnvelopeCryptoService;

  beforeEach(() => {
    kms = new FakeKmsClientFactory();
    repo = new FakeKmsConfigRepo();
    license = new FakeOrgLicenseResolver();
    service = new EnvelopeCryptoService(
      repo as any,
      license as any,
      kms as unknown as KmsClientFactory,
    );
  });

  describe('with a CMK configured and entitled', () => {
    const ORG = 'org-kms';
    beforeEach(async () => {
      license.entitled.add(EE_ENTITLEMENTS.BYO_KMS);
      await provision(kms, repo, ORG);
    });

    it('round-trips a secret through wrap -> store -> unwrap -> decrypt', async () => {
      const secret = 'sk-super-secret-api-key';
      const enc = await service.encryptForOrg(ORG, secret);

      expect(EnvelopeCryptoService.isEnvelope(enc)).toBe(true);
      expect(enc.startsWith('encrypted:kms:')).toBe(true);
      expect(enc).not.toContain(secret);

      const dec = await service.decryptForOrg(ORG, enc);
      expect(dec).toBe(secret);
      // The DEK was unwrapped via KMS at least once.
      expect(kms.decryptCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('does NOT produce the platform field-crypto format', async () => {
      const enc = await service.encryptForOrg(ORG, 'x');
      // Platform format is `encrypted:gcm:` — envelope must be distinguishable.
      expect(enc.startsWith('encrypted:gcm:')).toBe(false);
    });

    it('caches the unwrapped DEK across calls (one KMS Decrypt for many ops)', async () => {
      const a = await service.encryptForOrg(ORG, 'a');
      await service.decryptForOrg(ORG, a);
      const b = await service.encryptForOrg(ORG, 'b');
      await service.decryptForOrg(ORG, b);
      expect(kms.decryptCalls.length).toBe(1);
    });

    it('surfaces an error (never plaintext) when KMS Decrypt fails', async () => {
      const enc = await service.encryptForOrg(ORG, 'top-secret');
      service.invalidate(ORG); // force a fresh unwrap
      kms.failDecrypt = true;
      await expect(service.decryptForOrg(ORG, enc)).rejects.toThrow(
        /AccessDenied|Decrypt/,
      );
    });
  });

  describe('without a CMK (platform-managed path unchanged)', () => {
    const ORG = 'org-plain';

    it('uses the platform field-crypto format when no config exists', async () => {
      license.entitled.add(EE_ENTITLEMENTS.BYO_KMS); // entitled but no config
      const enc = await service.encryptForOrg(ORG, 'hello');
      expect(enc.startsWith('encrypted:gcm:')).toBe(true);
      expect(EnvelopeCryptoService.isEnvelope(enc)).toBe(false);
      expect(kms.encryptCalls.length).toBe(0);
      // And it decrypts via the platform path.
      expect(await service.decryptForOrg(ORG, enc)).toBe('hello');
    });

    it('the platform ciphertext is identical to calling field-crypto directly', async () => {
      const enc = await service.encryptForOrg(ORG, 'compat');
      // Independent verification: the shared decryptField reads it unchanged.
      expect(isEncrypted(enc)).toBe(true);
      expect(decryptField(enc)).toBe('compat');
    });

    it('falls back to the platform path when config exists but is disabled', async () => {
      license.entitled.add(EE_ENTITLEMENTS.BYO_KMS);
      await provision(kms, repo, ORG, { enabled: false });
      const enc = await service.encryptForOrg(ORG, 'staged');
      expect(enc.startsWith('encrypted:gcm:')).toBe(true);
    });
  });

  describe('entitlement gating', () => {
    const ORG = 'org-unlicensed';

    it('uses the platform path when the org lacks the byo_kms entitlement', async () => {
      await provision(kms, repo, ORG); // config present...
      // ...but NOT entitled.
      const enc = await service.encryptForOrg(ORG, 'secret');
      expect(enc.startsWith('encrypted:gcm:')).toBe(true);
      expect(EnvelopeCryptoService.isEnvelope(enc)).toBe(false);
    });
  });

  describe('prefix-routed decryption (mixed data)', () => {
    it('reads a legacy platform value even for an org that now has a CMK', async () => {
      const ORG = 'org-migrating';
      license.entitled.add(EE_ENTITLEMENTS.BYO_KMS);
      // A value encrypted BEFORE the CMK was attached (platform format).
      const legacy = await new EnvelopeCryptoService(
        new FakeKmsConfigRepo() as any,
        new FakeOrgLicenseResolver() as any,
        kms as unknown as KmsClientFactory,
      ).encryptForOrg('someone-else', 'legacy-secret');
      expect(legacy.startsWith('encrypted:gcm:')).toBe(true);

      // Now the org has a CMK; decrypting the legacy value must still use the
      // platform path (routed by prefix), not KMS.
      await provision(kms, repo, ORG);
      const dec = await service.decryptForOrg(ORG, legacy);
      expect(dec).toBe('legacy-secret');
      expect(kms.decryptCalls.length).toBe(0);
    });
  });
});
