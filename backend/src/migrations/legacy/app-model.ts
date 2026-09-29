import { GatewayType } from '../../entities/gateway.entity';

/**
 * The app model as the migrations of 2026-09 knew it, frozen.
 *
 * Apps and their places were replaced by channels on the agent
 * (1750813700000-ChannelsOnTheAgent). Two migrations that ran before that
 * one still build app rows (EveryChatSurfaceHasAnApp,
 * EveryWidgetAndA2aHasAnApp), and a fresh database has to run them exactly
 * as production did, so what they read is copied here rather than imported
 * from code that has since moved on. Nothing outside migrations/ may
 * import this file.
 */

export enum AppAuthMode {
  PUBLIC_LINK = 'public_link',
  EMAIL_OTP = 'email_otp',
  OAUTH = 'oauth',
  SSO = 'sso',
}

export interface AppBranding {
  appName?: string;
  primaryColor?: string;
  logoUrl?: string | null;
  iconUrl?: string | null;
  greeting?: string;
  theme?: 'dark' | 'light' | 'auto';
  suggestedPrompts?: string[];
  aiDisclosure?: string | null;
  whiteLabel?: boolean;
}

export interface AppLimits {
  costCapCents?: number | null;
  perUserRateLimit?: number | null;
  perIpRateLimit?: number | null;
  dailySpendCapCents?: number | null;
  monthlySpendCapCents?: number | null;
}

export interface AppRow {
  organizationId: string;
  name: string;
  slug: string;
  description: string | null;
  agentIds: string[];
  branding: AppBranding;
  authMode: AppAuthMode;
  capabilities: Record<string, any>;
  limits: AppLimits;
  privacy: Record<string, any> | null;
  isActive: boolean;
}

export enum DistributionTarget {
  WEB = 'web',
  TUI = 'tui',
  DESKTOP = 'desktop',
  BINARY = 'binary',
  WIDGET = 'widget',
  A2A = 'a2a',
  SLACK = 'slack',
  DISCORD = 'discord',
  TELEGRAM = 'telegram',
  WHATSAPP = 'whatsapp',
  WHATSAPP_CLOUD = 'whatsapp_cloud',
  SMS = 'sms',
  MICROSOFT_TEAMS = 'microsoft_teams',
  GOOGLE_CHAT = 'google_chat',
  EMAIL = 'email',
  SIGNAL = 'signal',
  MATRIX = 'matrix',
  IRC = 'irc',
  WEBHOOK = 'webhook',
}

export const GATEWAY_TYPE_FOR_TARGET: Record<string, GatewayType | null> = Object.freeze({
  [DistributionTarget.WEB]: GatewayType.HOSTED_CHAT,
  [DistributionTarget.SLACK]: GatewayType.SLACK,
  [DistributionTarget.DISCORD]: GatewayType.DISCORD,
  [DistributionTarget.TELEGRAM]: GatewayType.TELEGRAM,
  [DistributionTarget.WHATSAPP]: GatewayType.WHATSAPP,
  [DistributionTarget.WHATSAPP_CLOUD]: GatewayType.WHATSAPP_CLOUD,
  [DistributionTarget.SMS]: GatewayType.SMS,
  [DistributionTarget.EMAIL]: GatewayType.EMAIL,
  [DistributionTarget.WEBHOOK]: GatewayType.WEBHOOK,
  [DistributionTarget.GOOGLE_CHAT]: GatewayType.GOOGLE_CHAT,
  [DistributionTarget.MICROSOFT_TEAMS]: GatewayType.MICROSOFT_TEAMS,
  [DistributionTarget.SIGNAL]: GatewayType.SIGNAL,
  [DistributionTarget.MATRIX]: GatewayType.MATRIX,
  [DistributionTarget.IRC]: GatewayType.IRC,
  [DistributionTarget.WIDGET]: GatewayType.CHAT_WIDGET,
  [DistributionTarget.A2A]: GatewayType.A2A,
  [DistributionTarget.TUI]: null,
  [DistributionTarget.DESKTOP]: null,
  [DistributionTarget.BINARY]: null,
});

export const REQUIRED_CREDENTIALS: Record<string, readonly string[]> = Object.freeze({
  [DistributionTarget.SLACK]: ['bot_token', 'signing_secret'],
  [DistributionTarget.DISCORD]: ['bot_token'],
  [DistributionTarget.TELEGRAM]: ['bot_token'],
  [DistributionTarget.WHATSAPP]: ['twilio_account_sid', 'twilio_auth_token', 'phone_number'],
  [DistributionTarget.WHATSAPP_CLOUD]: ['access_token', 'phone_number_id', 'app_secret', 'verify_token'],
  [DistributionTarget.SMS]: ['twilio_account_sid', 'twilio_auth_token', 'phone_number'],
  [DistributionTarget.EMAIL]: ['resend_api_key', 'inbound_address', 'reply_from'],
  [DistributionTarget.WEBHOOK]: ['callback_url', 'secret'],
  [DistributionTarget.GOOGLE_CHAT]: ['webhook_url', 'verification_token'],
  [DistributionTarget.MICROSOFT_TEAMS]: ['bot_id', 'bot_password', 'service_url'],
  [DistributionTarget.SIGNAL]: ['api_url', 'phone_number'],
  [DistributionTarget.MATRIX]: ['homeserver_url', 'access_token', 'room_id'],
  [DistributionTarget.IRC]: ['webhook_url', 'bridge_token', 'nick', 'channel'],
  [DistributionTarget.WEB]: [],
  [DistributionTarget.WIDGET]: [],
  [DistributionTarget.A2A]: [],
  [DistributionTarget.TUI]: [],
  [DistributionTarget.DESKTOP]: [],
  [DistributionTarget.BINARY]: [],
});

export const CREDENTIAL_ALTERNATIVES: Record<string, { instead: readonly string[]; all: readonly string[] }> =
  Object.freeze({
    [DistributionTarget.SLACK]: { instead: ['bot_token'], all: ['client_id', 'client_secret'] },
  });

const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const RESERVED_APP_SLUGS = Object.freeze([
  'www', 'api', 'app', 'admin', 'docs', 'status', 'staging', 'dev',
  'chat', 'mail', 'assets', 'static', 'cdn', 'download', 'install',
]);

export function appSlugError(slug: string): string | null {
  const value = (slug || '').trim().toLowerCase();
  if (!value) return 'Pick a name for the app.';
  if (value.length < 3) return 'Must be at least 3 characters.';
  if (value.length > 63) return 'Must be 63 characters or fewer.';
  if (!SLUG_PATTERN.test(value)) {
    return 'Use lowercase letters, numbers and hyphens. It cannot start or end with a hyphen.';
  }
  if (RESERVED_APP_SLUGS.includes(value)) return 'That name is reserved.';
  return null;
}

/** The limits a new app started with: every axis for an open app, the cost cap alone for SSO. */
export function defaultLimitsFor(authMode: AppAuthMode | undefined): AppLimits {
  if ((authMode ?? AppAuthMode.PUBLIC_LINK) !== AppAuthMode.SSO) {
    return { costCapCents: 50, perUserRateLimit: 60, perIpRateLimit: 120 };
  }
  return { costCapCents: 50, perUserRateLimit: null, perIpRateLimit: null };
}
