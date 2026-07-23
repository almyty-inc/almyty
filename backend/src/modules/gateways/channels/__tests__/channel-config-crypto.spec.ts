import {
  CHANNEL_SECRET_CONFIG_KEYS,
  MASKED_CHANNEL_SECRET,
  decryptChannelConfig,
  encryptChannelConfigSecrets,
  getChannelConfig,
  maskChannelConfigSecrets,
  normalizeChannelConfigKeys,
  restoreMaskedChannelSecrets,
} from '../channel-config.helper';
import { encryptField, isEncrypted } from '../../../../common/security/field-crypto';

/**
 * Platform-path envelope stub: mirrors EnvelopeCryptoService for a non-KMS
 * org (produces the same `encrypted:gcm:` value field-crypto does). Lets these
 * helper tests assert the unchanged platform behavior without a live KMS.
 */
const platformEnvelope = {
  encryptForOrg: (_orgId: string, plaintext: string) => Promise.resolve(encryptField(plaintext)),
};
const ORG = 'org-test';
import { ChannelGatewayService } from '../channel-gateway.service';
import { Gateway, GatewayType } from '../../../../entities/gateway.entity';
import { ChatWidgetAdapter } from '../adapters/chat-widget.adapter';
import { SlackAdapter } from '../adapters/slack.adapter';
import { DiscordAdapter } from '../adapters/discord.adapter';
import { TelegramAdapter } from '../adapters/telegram.adapter';
import { WhatsAppAdapter } from '../adapters/whatsapp.adapter';
import { WhatsAppCloudAdapter } from '../adapters/whatsapp-cloud.adapter';
import { SmsAdapter } from '../adapters/sms.adapter';
import { EmailAdapter } from '../adapters/email.adapter';
import { WebhookAdapter } from '../adapters/webhook.adapter';
import { GoogleChatAdapter } from '../adapters/google-chat.adapter';
import { MicrosoftTeamsAdapter } from '../adapters/microsoft-teams.adapter';
import { SignalAdapter } from '../adapters/signal.adapter';
import { MatrixAdapter } from '../adapters/matrix.adapter';
import { IrcAdapter } from '../adapters/irc.adapter';
import { installFetchMock } from '../adapters/__tests__/test-helpers';

/**
 * Channel config crypto + key-normalization helpers, plus the
 * testConnection read path that must receive decrypted, key-normalized
 * credentials.
 */

describe('teams bot_password coverage', () => {
  const { CHANNEL_SECRET_CONFIG_KEYS, LEGACY_CHANNEL_CONFIG_KEY_MAP } = require('../channel-config.helper');
  it('bot_password is treated as a secret (encrypted + masked) incl. legacy camelCase', () => {
    expect(CHANNEL_SECRET_CONFIG_KEYS).toContain('bot_password');
    expect(CHANNEL_SECRET_CONFIG_KEYS).toContain('botPassword');
    expect(LEGACY_CHANNEL_CONFIG_KEY_MAP.botPassword).toBe('bot_password');
  });
});

describe('channel-config.helper', () => {
  describe('encryptChannelConfigSecrets', () => {
    it('encrypts every secret key and leaves non-secrets alone', async () => {
      const config: Record<string, any> = {
        bot_token: 'xoxb-plain',
        signing_secret: 'shh',
        twilio_auth_token: 'tw-auth',
        access_token: 'meta-token',
        resend_api_key: 're_123',
        app_secret: 'app-s',
        verify_token: 'vt',
        bridge_token: 'bt',
        inbound_token: 'it',
        client_secret: 'cs',
        phone_number: '+15551234567',
        webhook_url: 'https://example.com/hook',
      };

      await encryptChannelConfigSecrets(config, ORG, platformEnvelope);

      for (const key of [
        'bot_token',
        'signing_secret',
        'twilio_auth_token',
        'access_token',
        'resend_api_key',
        'app_secret',
        'verify_token',
        'bridge_token',
        'inbound_token',
        'client_secret',
      ]) {
        expect(isEncrypted(config[key])).toBe(true);
      }
      // Non-secret keys stay readable.
      expect(config.phone_number).toBe('+15551234567');
      expect(config.webhook_url).toBe('https://example.com/hook');
    });

    it('is idempotent for already-encrypted values', async () => {
      const config: Record<string, any> = { bot_token: encryptField('xoxb-1') };
      const before = config.bot_token;
      await encryptChannelConfigSecrets(config, ORG, platformEnvelope);
      expect(config.bot_token).toBe(before);
    });

    it('never encrypts the masked placeholder', async () => {
      const config: Record<string, any> = { bot_token: MASKED_CHANNEL_SECRET };
      await encryptChannelConfigSecrets(config, ORG, platformEnvelope);
      expect(config.bot_token).toBe(MASKED_CHANNEL_SECRET);
    });
  });

  describe('decryptChannelConfig / getChannelConfig', () => {
    it('decrypts encrypted secrets and passes legacy plaintext through', () => {
      const config = {
        bot_token: encryptField('xoxb-secret'),
        signing_secret: 'legacy-plaintext', // pre-encryption row
        phone_number: '+15551234567',
      };
      const out = decryptChannelConfig(config);
      expect(out.bot_token).toBe('xoxb-secret');
      expect(out.signing_secret).toBe('legacy-plaintext');
      expect(out.phone_number).toBe('+15551234567');
      // Never mutates the stored object.
      expect(isEncrypted(config.bot_token)).toBe(true);
    });

    it('normalizes legacy camelCase keys onto adapter-read snake_case keys', () => {
      const out = normalizeChannelConfigKeys({
        botToken: 'xoxb-legacy',
        accountSid: 'AC1',
        authToken: 'tw',
        phoneNumber: '+1555',
        accessToken: 'meta',
        phoneNumberId: 'pnid',
        verifyToken: 'vt',
        appSecret: 'as',
        resendApiKey: 're_1',
      });
      expect(out.bot_token).toBe('xoxb-legacy');
      expect(out.twilio_account_sid).toBe('AC1');
      expect(out.twilio_auth_token).toBe('tw');
      expect(out.phone_number).toBe('+1555');
      expect(out.access_token).toBe('meta');
      expect(out.phone_number_id).toBe('pnid');
      expect(out.verify_token).toBe('vt');
      expect(out.app_secret).toBe('as');
      expect(out.resend_api_key).toBe('re_1');
    });

    it('prefers the canonical snake_case key when both spellings exist', () => {
      const out = normalizeChannelConfigKeys({ bot_token: 'canonical', botToken: 'legacy' });
      expect(out.bot_token).toBe('canonical');
    });

    it('getChannelConfig handles an encrypted legacy camelCase row end to end', () => {
      const out = getChannelConfig({ botToken: encryptField('xoxb-old-row') });
      expect(out.bot_token).toBe('xoxb-old-row');
    });

    it('is null/undefined safe', () => {
      expect(getChannelConfig(null)).toEqual({});
      expect(getChannelConfig(undefined)).toEqual({});
    });
  });

  describe('maskChannelConfigSecrets', () => {
    it('masks every secret key and keeps non-secrets readable', () => {
      const masked = maskChannelConfigSecrets({
        bot_token: encryptField('xoxb-1'),
        signing_secret: 'plain-legacy',
        phone_number: '+15551234567',
        aiDisclosure: true,
      })!;
      expect(masked.bot_token).toBe(MASKED_CHANNEL_SECRET);
      expect(masked.signing_secret).toBe(MASKED_CHANNEL_SECRET);
      expect(masked.phone_number).toBe('+15551234567');
      expect(masked.aiDisclosure).toBe(true);
    });

    it('never leaks a secret value for any key in the secret list', () => {
      const config: Record<string, any> = {};
      for (const key of CHANNEL_SECRET_CONFIG_KEYS) config[key] = `sensitive-${key}`;
      const masked = maskChannelConfigSecrets(config)!;
      for (const key of CHANNEL_SECRET_CONFIG_KEYS) {
        expect(masked[key]).toBe(MASKED_CHANNEL_SECRET);
      }
    });

    it('passes null/undefined through', () => {
      expect(maskChannelConfigSecrets(null)).toBeNull();
      expect(maskChannelConfigSecrets(undefined)).toBeUndefined();
    });
  });

  describe('restoreMaskedChannelSecrets', () => {
    it('swaps masked placeholders for the stored values', () => {
      const stored = { bot_token: encryptField('xoxb-stored'), phone_number: '+1' };
      const incoming: Record<string, any> = {
        bot_token: MASKED_CHANNEL_SECRET,
        phone_number: '+2',
      };
      restoreMaskedChannelSecrets(incoming, stored);
      expect(incoming.bot_token).toBe(stored.bot_token);
      expect(incoming.phone_number).toBe('+2');
    });

    it('drops a masked key with no stored counterpart', () => {
      const incoming: Record<string, any> = { bot_token: MASKED_CHANNEL_SECRET };
      restoreMaskedChannelSecrets(incoming, {});
      expect('bot_token' in incoming).toBe(false);
    });

    it('keeps genuinely new secret values untouched', () => {
      const incoming: Record<string, any> = { bot_token: 'xoxb-new' };
      restoreMaskedChannelSecrets(incoming, { bot_token: encryptField('xoxb-old') });
      expect(incoming.bot_token).toBe('xoxb-new');
    });
  });
});

describe('channel pipeline reads decrypted, key-normalized config', () => {
  let service: ChannelGatewayService;
  let fetchMock: ReturnType<typeof installFetchMock>;

  const gw = (type: GatewayType, configuration: Record<string, any>): Gateway =>
    ({ type, configuration } as unknown as Gateway);

  beforeEach(() => {
    service = new ChannelGatewayService(
      null as any,
      null as any,
      null as any,
      null as any,
      new ChatWidgetAdapter(null as any),
      new SlackAdapter(),
      new DiscordAdapter(),
      new TelegramAdapter(),
      new WhatsAppAdapter(),
      new WhatsAppCloudAdapter(),
      new SmsAdapter(),
      new EmailAdapter(),
      new WebhookAdapter(),
      new GoogleChatAdapter(),
      new MicrosoftTeamsAdapter(),
      new SignalAdapter(),
      new MatrixAdapter(),
      new IrcAdapter(),
    );
    fetchMock = installFetchMock();
  });
  afterEach(() => fetchMock.restore());

  it('testConnection uses the decrypted bot token, not the ciphertext', async () => {
    fetchMock.setNextResponse({ json: { ok: true, user: 'almytybot' } });
    const res = await service.testConnection(
      gw(GatewayType.SLACK, { bot_token: encryptField('xoxb-enc') }),
    );
    expect(fetchMock.calls[0].init.headers.Authorization).toBe('Bearer xoxb-enc');
    expect(res.ok).toBe(true);
  });

  it('testConnection still works for a legacy plaintext camelCase row', async () => {
    fetchMock.setNextResponse({ json: { ok: true, user: 'legacybot' } });
    const res = await service.testConnection(
      gw(GatewayType.SLACK, { botToken: 'xoxb-legacy' }),
    );
    expect(fetchMock.calls[0].init.headers.Authorization).toBe('Bearer xoxb-legacy');
    expect(res.ok).toBe(true);
  });

  it('adapters receive decrypted credentials on the outbound send path', async () => {
    const adapter = service.getAdapter(GatewayType.TELEGRAM);
    // Same decrypted view the pipeline hands to sendResponse.
    const config = getChannelConfig({ bot_token: encryptField('123456:ABC') });
    fetchMock.setNextResponse({ json: { ok: true } });

    await adapter.sendResponse(config, { chat_id: 'c1', text: 'hi' }, { threadId: 'c1' });

    expect(fetchMock.calls[0].url).toContain('/bot123456:ABC/');
  });
});
