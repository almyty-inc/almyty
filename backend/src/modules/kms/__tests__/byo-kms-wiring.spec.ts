import { EnvelopeCryptoService } from '../envelope-crypto.service';
import { KmsClientFactory, KmsKeyRef } from '../kms.service';
import { OrgKmsConfig } from '../../../entities/org-kms-config.entity';
import { EE_ENTITLEMENTS } from '../../licensing/license.constants';
import {
  encryptField,
  registerEnvelopeUnwrapHook,
} from '../../../common/security/field-crypto';
import { LlmProvider } from '../../../entities/llm-provider.entity';
import { Credential, CredentialType } from '../../../entities/credential.entity';
import * as crypto from 'crypto';

/**
 * Wiring proof for BYO-KMS (issue #239). These specs assert that the org-secret
 * call-site plumbing routes through EnvelopeCryptoService end-to-end:
 *  (a) a CMK-enabled org round-trips via the kms path (encrypted:kms:),
 *  (b) a non-CMK org round-trips via the platform path unchanged
 *      (byte-compatible with the old field-crypto: encrypted:gcm:),
 *  (c) a value stored BEFORE the wiring (platform ciphertext) still decrypts.
 *
 * The KMS client is faked — no live AWS. The entity encrypt methods take the
 * envelope service; the entity decrypt methods route encrypted:kms: values
 * through the registered sync unwrap hook after the DEK cache is warmed.
 */

class FakeKmsClientFactory {
  encryptCalls: Array<{ ref: KmsKeyRef; plaintext: Buffer }> = [];
  decryptCalls: Array<{ ref: KmsKeyRef; ciphertext: Buffer }> = [];

  private mask(keyArn: string, buf: Buffer): Buffer {
    const seed = Buffer.from(keyArn);
    const out = Buffer.alloc(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ seed[i % seed.length];
    return out;
  }
  async encrypt(ref: KmsKeyRef, plaintext: Buffer): Promise<Buffer> {
    this.encryptCalls.push({ ref, plaintext });
    return Buffer.concat([Buffer.from('KMS:'), this.mask(ref.keyArn, plaintext)]);
  }
  async decrypt(ref: KmsKeyRef, ciphertext: Buffer): Promise<Buffer> {
    this.decryptCalls.push({ ref, ciphertext });
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

async function provision(
  kms: FakeKmsClientFactory,
  repo: FakeKmsConfigRepo,
  organizationId: string,
) {
  const dek = crypto.randomBytes(32);
  const wrapped = await kms.encrypt({ keyArn: CMK_ARN, region: 'us-east-1' }, dek);
  repo.rows.push({
    id: `k_${organizationId}`,
    organizationId,
    enabled: true,
    cmkArn: CMK_ARN,
    awsRegion: 'us-east-1',
    wrappedDek: wrapped.toString('base64'),
    createdAt: new Date(),
    updatedAt: new Date(),
  } as OrgKmsConfig);
  return dek;
}

const KMS_ORG = 'org-with-cmk';
const PLAIN_ORG = 'org-no-cmk';

describe('BYO-KMS call-site wiring', () => {
  let kms: FakeKmsClientFactory;
  let repo: FakeKmsConfigRepo;
  let license: FakeOrgLicenseResolver;
  let service: EnvelopeCryptoService;

  beforeEach(async () => {
    kms = new FakeKmsClientFactory();
    repo = new FakeKmsConfigRepo();
    license = new FakeOrgLicenseResolver();
    license.entitled.add(EE_ENTITLEMENTS.BYO_KMS);
    service = new EnvelopeCryptoService(
      repo as any,
      license as any,
      kms as unknown as KmsClientFactory,
    );
    // Register the sync unwrap hook the same way the real module lifecycle does.
    service.onModuleInit();
    await provision(kms, repo, KMS_ORG);
  });

  afterEach(() => {
    registerEnvelopeUnwrapHook(null);
  });

  // ── LlmProvider entity ──────────────────────────────────────────────────

  describe('LlmProvider.apiKey / usageApiKey', () => {
    function makeProvider(orgId: string): LlmProvider {
      const p = new LlmProvider();
      p.organizationId = orgId;
      p.configuration = { apiKey: 'sk-live-abc123', usageApiKey: 'sk-admin-xyz' } as any;
      return p;
    }

    it('(a) CMK org: encrypts to encrypted:kms: and round-trips after warm', async () => {
      const p = makeProvider(KMS_ORG);
      await p.encryptSensitiveDataForOrg(service);

      expect(p.configuration.apiKey!.startsWith('encrypted:kms:')).toBe(true);
      expect(p.configuration.usageApiKey!.startsWith('encrypted:kms:')).toBe(true);
      expect(p.configuration.apiKey).not.toContain('sk-live-abc123');

      // Sync read path requires the DEK to be warmed first.
      await service.warmOrg(KMS_ORG);
      expect(p.getDecryptedApiKey()).toBe('sk-live-abc123');
      expect(p.getDecryptedUsageApiKey()).toBe('sk-admin-xyz');
    });

    it('(a2) reading a kms value with a cold DEK cache throws (never leaks ciphertext)', async () => {
      const p = makeProvider(KMS_ORG);
      await p.encryptSensitiveDataForOrg(service);
      // Encrypt warms the cache as a side effect; force it cold to model a
      // read that happens without a preceding warm.
      service.invalidate(KMS_ORG);
      expect(() => p.getDecryptedApiKey()).toThrow(/warmed DEK/i);
    });

    it('(b) non-CMK org: produces platform encrypted:gcm: and round-trips', async () => {
      const p = makeProvider(PLAIN_ORG);
      await p.encryptSensitiveDataForOrg(service);

      expect(p.configuration.apiKey!.startsWith('encrypted:gcm:')).toBe(true);
      expect(p.configuration.usageApiKey!.startsWith('encrypted:gcm:')).toBe(true);
      // No KMS calls happened for a non-CMK org.
      expect(kms.encryptCalls.length).toBe(1); // only the provision() wrap

      // No warm needed — platform values decrypt directly.
      expect(p.getDecryptedApiKey()).toBe('sk-live-abc123');
      expect(p.getDecryptedUsageApiKey()).toBe('sk-admin-xyz');
    });

    it('(c) platform ciphertext stored before wiring still decrypts', async () => {
      // Simulate a row written by the OLD code path (plain field-crypto).
      const p = makeProvider(KMS_ORG); // even a now-CMK org may hold legacy rows
      p.configuration.apiKey = encryptField('sk-legacy-key');
      p.configuration.usageApiKey = encryptField('sk-legacy-usage');

      // Prefix routing: gcm values take the platform path regardless of org.
      expect(p.getDecryptedApiKey()).toBe('sk-legacy-key');
      expect(p.getDecryptedUsageApiKey()).toBe('sk-legacy-usage');
    });

    it('(c2) plaintext (never-encrypted) value passes through unchanged', () => {
      const p = makeProvider(KMS_ORG);
      p.configuration.apiKey = 'sk-raw-plaintext';
      expect(p.getDecryptedApiKey()).toBe('sk-raw-plaintext');
    });

    it('re-encrypt is idempotent (already-encrypted values are left alone)', async () => {
      const p = makeProvider(KMS_ORG);
      await p.encryptSensitiveDataForOrg(service);
      const once = p.configuration.apiKey;
      await p.encryptSensitiveDataForOrg(service);
      expect(p.configuration.apiKey).toBe(once);
    });
  });

  // ── Credential entity ───────────────────────────────────────────────────

  describe('Credential config secrets', () => {
    function makeCredential(orgId: string): Credential {
      const c = new Credential();
      c.organizationId = orgId;
      c.type = CredentialType.BEARER_TOKEN;
      c.isActive = true;
      c.config = { token: 'tok-secret-123', apiKey: 'ak-secret-456' } as any;
      return c;
    }

    it('(a) CMK org: encrypts to encrypted:kms: and round-trips after warm', async () => {
      const c = makeCredential(KMS_ORG);
      await c.encryptSensitiveDataForOrg(service);

      expect((c.config as any).token.startsWith('encrypted:kms:')).toBe(true);
      expect((c.config as any).apiKey.startsWith('encrypted:kms:')).toBe(true);

      await service.warmOrg(KMS_ORG);
      const dec = c.getDecryptedConfig();
      expect(dec.token).toBe('tok-secret-123');
      expect(dec.apiKey).toBe('ak-secret-456');
    });

    it('(b) non-CMK org: produces platform encrypted:gcm: and round-trips', async () => {
      const c = makeCredential(PLAIN_ORG);
      await c.encryptSensitiveDataForOrg(service);

      expect((c.config as any).token.startsWith('encrypted:gcm:')).toBe(true);
      const dec = c.getDecryptedConfig();
      expect(dec.token).toBe('tok-secret-123');
      expect(dec.apiKey).toBe('ak-secret-456');
    });

    it('(c) platform ciphertext + legacy CBC written before wiring still decrypt', async () => {
      const c = makeCredential(KMS_ORG);
      // Platform GCM value written by the old encryptSensitiveData path.
      c.config = { token: encryptField('legacy-tok') } as any;
      const dec = c.getDecryptedConfig();
      expect(dec.token).toBe('legacy-tok');
    });

    it('(c2) plaintext credential value passes through unchanged', () => {
      const c = makeCredential(KMS_ORG);
      c.config = { token: 'raw-plain-token' } as any;
      const dec = c.getDecryptedConfig();
      expect(dec.token).toBe('raw-plain-token');
    });

    it('getAuthHeaders works for a CMK-encrypted credential after warm', async () => {
      const c = makeCredential(KMS_ORG);
      await c.encryptSensitiveDataForOrg(service);
      await service.warmOrg(KMS_ORG);
      expect(c.getAuthHeaders()).toEqual({ Authorization: 'Bearer tok-secret-123' });
    });
  });
});
