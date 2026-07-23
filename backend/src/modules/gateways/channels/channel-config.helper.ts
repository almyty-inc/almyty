import { decryptField, isEncrypted } from '../../../common/security/field-crypto';

/**
 * Org-aware envelope encryptor. `encryptChannelConfigSecrets` needs an async
 * encrypt so a BYO-KMS org's secrets are wrapped `encrypted:kms:` while every
 * other org keeps the same platform `encrypted:gcm:` value. Kept as a narrow
 * structural type so the helper doesn't depend on the KMS module directly.
 */
export interface ChannelSecretEnvelope {
  encryptForOrg(organizationId: string, plaintext: string): Promise<string>;
}

/**
 * Channel gateway configuration helpers.
 *
 * Two concerns live here because they share the same read path:
 *
 * 1. Key normalization — the agent-detail deploy dialog historically
 *    stored camelCase keys (`botToken`) while every adapter reads
 *    snake_case (`bot_token`). The dialog now writes snake_case, but
 *    pre-existing rows must keep working, so reads normalize legacy
 *    camelCase keys onto their canonical snake_case names.
 *
 * 2. Secret encryption — channel secrets (bot tokens, signing
 *    secrets, ...) are encrypted at rest by GatewaysService and
 *    decrypted here, at the single point where adapters / registrars /
 *    test-connection receive the config. decryptField passes plaintext
 *    through unchanged, so legacy unencrypted rows keep working.
 */

/**
 * Configuration keys that hold channel secrets. Values under these
 * keys are encrypted at rest (GatewaysService.encryptConfigSecrets),
 * decrypted on read (getChannelConfig) and masked in API responses
 * (maskChannelConfigSecrets). CamelCase spellings cover rows written
 * by the pre-snake_case deploy dialog.
 */
export const CHANNEL_SECRET_CONFIG_KEYS: readonly string[] = [
  // Multi-workspace OAuth app secret (Slack installs)
  'client_secret',
  'clientSecret',
  // Slack / Discord / Telegram
  'bot_token',
  'botToken',
  // Microsoft Teams (Bot Framework app password)
  'bot_password',
  'botPassword',
  'signing_secret',
  'signingSecret',
  // Twilio (WhatsApp / SMS)
  'auth_token',
  'authToken',
  'twilio_auth_token',
  // WhatsApp Cloud (Meta) / Matrix
  'access_token',
  'accessToken',
  'app_secret',
  'appSecret',
  'verify_token',
  'verifyToken',
  // Email (Resend)
  'resend_api_key',
  'resendApiKey',
  'resend_inbound_signing_secret',
  // IRC bridge
  'bridge_token',
  'inbound_token',
];

/**
 * Legacy camelCase key -> canonical snake_case key the adapters read.
 * Used read-side only; we never rewrite stored rows.
 */
export const LEGACY_CHANNEL_CONFIG_KEY_MAP: Readonly<Record<string, string>> = {
  botToken: 'bot_token',
  signingSecret: 'signing_secret',
  clientSecret: 'client_secret',
  accountSid: 'twilio_account_sid',
  authToken: 'twilio_auth_token',
  phoneNumber: 'phone_number',
  accessToken: 'access_token',
  phoneNumberId: 'phone_number_id',
  verifyToken: 'verify_token',
  appSecret: 'app_secret',
  resendApiKey: 'resend_api_key',
  replyFrom: 'reply_from',
  receiveAddress: 'inbound_address',
  callbackUrl: 'callback_url',
  webhookUrl: 'webhook_url',
  verificationToken: 'verification_token',
  homeserverUrl: 'homeserver_url',
  roomId: 'room_id',
  apiUrl: 'api_url',
  botId: 'bot_id',
  botPassword: 'bot_password',
  serviceUrl: 'service_url',
  bridgeToken: 'bridge_token',
  inboundToken: 'inbound_token',
};

/** Placeholder returned in place of secret values on the API surface. */
export const MASKED_CHANNEL_SECRET = '********';

/**
 * Copy legacy camelCase keys onto their canonical snake_case names.
 * The snake_case key wins when both are present. Returns a new object;
 * the stored configuration is never mutated.
 */
export function normalizeChannelConfigKeys(
  configuration?: Record<string, any> | null,
): Record<string, any> {
  const out: Record<string, any> = { ...(configuration || {}) };
  for (const [legacy, canonical] of Object.entries(LEGACY_CHANNEL_CONFIG_KEY_MAP)) {
    if (out[canonical] === undefined && out[legacy] !== undefined) {
      out[canonical] = out[legacy];
    }
  }
  return out;
}

/**
 * Decrypt secret keys in a channel configuration copy. Plaintext
 * (pre-encryption) values pass through unchanged via decryptField.
 *
 * `organizationId` routes customer-managed (`encrypted:kms:`) values through
 * the registered envelope unwrap hook; platform (`encrypted:gcm:`) / legacy /
 * plaintext values decrypt exactly as before regardless of it. A BYO-KMS org
 * must have had its DEK warmed (`EnvelopeCryptoService.warmOrg`) before this
 * SYNCHRONOUS read, otherwise the kms unwrap throws — the same contract every
 * other sync entity read follows.
 */
export function decryptChannelConfig(
  configuration?: Record<string, any> | null,
  organizationId?: string,
): Record<string, any> {
  const out: Record<string, any> = { ...(configuration || {}) };
  for (const key of CHANNEL_SECRET_CONFIG_KEYS) {
    if (typeof out[key] === 'string' && out[key]) {
      out[key] = decryptField(out[key], organizationId);
    }
  }
  return out;
}

/**
 * The channel read path: normalized keys + decrypted secrets. This is
 * what adapters, webhook registrars, transports and test-connection
 * must receive instead of the raw stored `gateway.configuration`.
 *
 * Pass the gateway's `organizationId` so BYO-KMS values decrypt; omitting it
 * keeps the previous behavior for platform/plaintext values.
 */
export function getChannelConfig(
  configuration?: Record<string, any> | null,
  organizationId?: string,
): Record<string, any> {
  return decryptChannelConfig(normalizeChannelConfigKeys(configuration), organizationId);
}

/**
 * Encrypt secret keys in place (idempotent — already-encrypted values
 * are left alone). Used by GatewaysService on create/update.
 *
 * Org-aware: a BYO-KMS org's new secrets are wrapped `encrypted:kms:` via the
 * envelope service; every other org gets the SAME platform `encrypted:gcm:`
 * value as before (EnvelopeCryptoService falls back to the platform path when
 * no CMK is in play). Already-encrypted values (either prefix) are skipped, so
 * this stays idempotent and never re-wraps a stored secret.
 */
export async function encryptChannelConfigSecrets(
  configuration: Record<string, any> | null | undefined,
  organizationId: string,
  envelope: ChannelSecretEnvelope,
): Promise<void> {
  if (!configuration) return;
  for (const key of CHANNEL_SECRET_CONFIG_KEYS) {
    const value = configuration[key];
    if (typeof value === 'string' && value && !isEncrypted(value) && value !== MASKED_CHANNEL_SECRET) {
      configuration[key] = await envelope.encryptForOrg(organizationId, value);
    }
  }
}

/**
 * Response-surface masking: replace secret values with a fixed
 * placeholder. Non-secret keys are untouched. Returns a new object.
 */
export function maskChannelConfigSecrets(
  configuration?: Record<string, any> | null,
): Record<string, any> | null | undefined {
  if (configuration == null) return configuration;
  const out: Record<string, any> = { ...configuration };
  for (const key of CHANNEL_SECRET_CONFIG_KEYS) {
    if (typeof out[key] === 'string' && out[key]) {
      out[key] = MASKED_CHANNEL_SECRET;
    }
  }
  return out;
}

/**
 * Update-path counterpart of masking: a client that round-trips a
 * masked configuration (edit dialogs send the full object back) must
 * not overwrite stored secrets with the placeholder. Replace masked
 * values with the currently stored ones; a masked key with no stored
 * counterpart is dropped.
 */
export function restoreMaskedChannelSecrets(
  incoming: Record<string, any> | undefined | null,
  stored: Record<string, any> | undefined | null,
): void {
  if (!incoming) return;
  for (const key of CHANNEL_SECRET_CONFIG_KEYS) {
    if (incoming[key] === MASKED_CHANNEL_SECRET) {
      const existing = stored?.[key];
      if (existing !== undefined) {
        incoming[key] = existing;
      } else {
        delete incoming[key];
      }
    }
  }
}
