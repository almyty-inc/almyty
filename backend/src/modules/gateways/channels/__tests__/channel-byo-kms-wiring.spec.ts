import { EnvelopeCryptoService } from '../../../kms/envelope-crypto.service';
import { KmsClientFactory, KmsKeyRef } from '../../../kms/kms.service';
import { OrgKmsConfig } from '../../../../entities/org-kms-config.entity';
import { EE_ENTITLEMENTS } from '../../../licensing/license.constants';
import {
  encryptField,
  registerEnvelopeUnwrapHook,
} from '../../../../common/security/field-crypto';
import {
  encryptChannelConfigSecrets,
  getChannelConfig,
} from '../channel-config.helper';
import { ChannelInstallationService } from '../channel-installation.service';
import { SlackInstallService } from '../slack-install.service';
import { ChannelInstallation } from '../../../../entities/channel-installation.entity';
import { Gateway } from '../../../../entities/gateway.entity';
import * as crypto from 'crypto';

/**
 * BYO-KMS wiring proof for the gateways/channels secret call-sites (the
 * follow-up to the earlier llm-providers / credentials / mcp-sources wiring).
 * Each call-site is asserted end-to-end through the real EnvelopeCryptoService:
 *  (a) a CMK-enabled org round-trips via the kms path (encrypted:kms:),
 *  (b) a non-CMK org round-trips via the platform path unchanged
 *      (byte-compatible with the old field-crypto: encrypted:gcm:),
 *  (c) a value stored BEFORE the wiring (platform ciphertext / plaintext)
 *      still decrypts via prefix routing.
 *
 * The KMS client is faked — no live AWS.
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

describe('BYO-KMS wiring — gateways/channels secrets', () => {
  let kms: FakeKmsClientFactory;
  let repo: FakeKmsConfigRepo;
  let license: FakeOrgLicenseResolver;
  let envelope: EnvelopeCryptoService;

  beforeEach(async () => {
    kms = new FakeKmsClientFactory();
    repo = new FakeKmsConfigRepo();
    license = new FakeOrgLicenseResolver();
    license.entitled.add(EE_ENTITLEMENTS.BYO_KMS);
    envelope = new EnvelopeCryptoService(
      repo as any,
      license as any,
      kms as unknown as KmsClientFactory,
    );
    // Register the sync unwrap hook the same way the real module lifecycle does.
    envelope.onModuleInit();
    await provision(kms, repo, KMS_ORG);
  });

  afterEach(() => {
    registerEnvelopeUnwrapHook(null);
  });

  // ── channel-config.helper (gateway.configuration secrets) ────────────────

  describe('channel gateway configuration secrets', () => {
    it('(a) CMK org: encrypts to encrypted:kms: and getChannelConfig round-trips after warm', async () => {
      const config: Record<string, any> = {
        bot_token: 'xoxb-live-token',
        signing_secret: 'sign-me',
        phone_number: '+15551234567', // non-secret, untouched
      };

      await encryptChannelConfigSecrets(config, KMS_ORG, envelope);

      expect(config.bot_token.startsWith('encrypted:kms:')).toBe(true);
      expect(config.signing_secret.startsWith('encrypted:kms:')).toBe(true);
      expect(config.bot_token).not.toContain('xoxb-live-token');
      expect(config.phone_number).toBe('+15551234567');

      // Sync read path requires the DEK warmed first (service layer does this).
      await envelope.warmOrg(KMS_ORG);
      const out = getChannelConfig(config, KMS_ORG);
      expect(out.bot_token).toBe('xoxb-live-token');
      expect(out.signing_secret).toBe('sign-me');
    });

    it('(a2) reading a kms config value with a cold DEK cache throws (never leaks ciphertext)', async () => {
      const config: Record<string, any> = { bot_token: 'xoxb-live-token' };
      await encryptChannelConfigSecrets(config, KMS_ORG, envelope);
      envelope.invalidate(KMS_ORG);
      expect(() => getChannelConfig(config, KMS_ORG)).toThrow(/warmed DEK/i);
    });

    it('(b) non-CMK org: produces platform encrypted:gcm: and round-trips unchanged', async () => {
      const config: Record<string, any> = { bot_token: 'xoxb-live-token' };
      await encryptChannelConfigSecrets(config, PLAIN_ORG, envelope);

      expect(config.bot_token.startsWith('encrypted:gcm:')).toBe(true);
      // No KMS calls for a non-CMK org (only the provision() wrap fired).
      expect(kms.encryptCalls.length).toBe(1);

      // Platform values decrypt directly — no warm needed.
      const out = getChannelConfig(config, PLAIN_ORG);
      expect(out.bot_token).toBe('xoxb-live-token');
    });

    it('(c) historical platform ciphertext still decrypts (prefix routing)', () => {
      // A row written by the OLD path, even for a now-CMK org.
      const config: Record<string, any> = {
        bot_token: encryptField('xoxb-legacy'),
        signing_secret: 'legacy-plaintext', // pre-encryption row
      };
      const out = getChannelConfig(config, KMS_ORG);
      expect(out.bot_token).toBe('xoxb-legacy');
      expect(out.signing_secret).toBe('legacy-plaintext');
    });

    it('re-encrypt is idempotent (already-encrypted values are left alone)', async () => {
      const config: Record<string, any> = { bot_token: 'xoxb-live-token' };
      await encryptChannelConfigSecrets(config, KMS_ORG, envelope);
      const once = config.bot_token;
      await encryptChannelConfigSecrets(config, KMS_ORG, envelope);
      expect(config.bot_token).toBe(once);
    });
  });

  // ── ChannelInstallationService (multi-workspace credentials) ─────────────

  describe('ChannelInstallationService credentials', () => {
    const makeRepo = () => {
      let last: any = null;
      return {
        findOne: jest.fn(async () => null),
        create: jest.fn((data: any) => Object.assign(new ChannelInstallation(), data)),
        save: jest.fn(async (inst: any) => {
          last = { id: 'inst-1', ...inst };
          return last;
        }),
        getLastSaved: () => last,
      };
    };

    const gatewayFor = (orgId: string): Gateway =>
      ({ id: 'gw-1', organizationId: orgId } as unknown as Gateway);

    it('(a) CMK org: stores bot_token as encrypted:kms: and resolveCredentials round-trips', async () => {
      const repoMock = makeRepo();
      const service = new ChannelInstallationService(repoMock as any, envelope);

      await service.upsert(gatewayFor(KMS_ORG), {
        externalTenantId: 'T111',
        credentials: { bot_token: 'xoxb-workspace', bot_user_id: 'U42' },
      });
      const saved = repoMock.getLastSaved();
      expect(saved.credentials.bot_token.startsWith('encrypted:kms:')).toBe(true);
      // Non-secret credential keys are untouched.
      expect(saved.credentials.bot_user_id).toBe('U42');

      // resolveCredentials reads installation.organizationId off the row.
      repoMock.findOne.mockResolvedValue({
        ...saved,
        organizationId: KMS_ORG,
        status: 'active',
      });
      const creds = await service.resolveCredentials('gw-1', 'T111');
      expect(creds).toEqual({ bot_token: 'xoxb-workspace', bot_user_id: 'U42' });
    });

    it('(b) non-CMK org: stores encrypted:gcm: and round-trips unchanged', async () => {
      const repoMock = makeRepo();
      const service = new ChannelInstallationService(repoMock as any, envelope);

      await service.upsert(gatewayFor(PLAIN_ORG), {
        externalTenantId: 'T222',
        credentials: { bot_token: 'xoxb-workspace' },
      });
      const saved = repoMock.getLastSaved();
      expect(saved.credentials.bot_token.startsWith('encrypted:gcm:')).toBe(true);

      repoMock.findOne.mockResolvedValue({
        ...saved,
        organizationId: PLAIN_ORG,
        status: 'active',
      });
      const creds = await service.resolveCredentials('gw-1', 'T222');
      expect(creds).toEqual({ bot_token: 'xoxb-workspace' });
    });

    it('(c) historical gcm credentials still decrypt for a now-CMK org', async () => {
      const repoMock = makeRepo();
      const service = new ChannelInstallationService(repoMock as any, envelope);
      repoMock.findOne.mockResolvedValue({
        id: 'inst-1',
        gatewayId: 'gw-1',
        organizationId: KMS_ORG,
        externalTenantId: 'T333',
        status: 'active',
        credentials: { bot_token: encryptField('xoxb-legacy') },
      });
      const creds = await service.resolveCredentials('gw-1', 'T333');
      expect(creds).toEqual({ bot_token: 'xoxb-legacy' });
    });
  });

  // ── SlackInstallService (OAuth client_secret) ────────────────────────────

  describe('SlackInstallService client secret', () => {
    const configService = { get: jest.fn(() => 'https://api.example.com') };
    const makeService = () =>
      new SlackInstallService(
        configService as any,
        { upsert: jest.fn() } as any,
        envelope,
      );

    const slackGw = (orgId: string, clientSecret: string): Gateway =>
      ({
        id: 'gw-slack',
        organizationId: orgId,
        configuration: { client_id: '123.456', client_secret: clientSecret },
      } as unknown as Gateway);

    it('(a) CMK org: decrypts a kms-wrapped client_secret via the CMK', async () => {
      const wrapped = await envelope.encryptForOrg(KMS_ORG, 'shh-secret');
      expect(wrapped.startsWith('encrypted:kms:')).toBe(true);

      const service = makeService();
      const { clientId, clientSecret } = await service.getClientCredentials(
        slackGw(KMS_ORG, wrapped),
      );
      expect(clientId).toBe('123.456');
      expect(clientSecret).toBe('shh-secret');
    });

    it('(b) non-CMK org: decrypts a platform gcm client_secret unchanged', async () => {
      const service = makeService();
      const { clientSecret } = await service.getClientCredentials(
        slackGw(PLAIN_ORG, encryptField('shh-secret')),
      );
      expect(clientSecret).toBe('shh-secret');
    });

    it('(c) historical gcm client_secret still decrypts for a now-CMK org', async () => {
      const service = makeService();
      const { clientSecret } = await service.getClientCredentials(
        slackGw(KMS_ORG, encryptField('legacy-secret')),
      );
      expect(clientSecret).toBe('legacy-secret');
    });
  });
});
