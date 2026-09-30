import {
  ChannelBranding,
  ChannelCapabilities,
  ChannelType,
  MESSAGING_CHANNEL_TYPES,
  VisitorAuthMode,
  VisitorLimits,
  VisitorPrivacy,
  VisitorRules,
  visitorPrivacyFrom,
} from '../../entities/agent-channel.entity';
import { PUBLISH_REFUSALS, missingCredentials, servesOverGateway } from './channel-publish';

/**
 * The rules that decide whether a channel may go live or be built, and
 * what an agent's branding and visitor rules come to on one channel.
 *
 * Pure functions with no repository access, so the same checks run on the
 * channel page before an operator saves, in the API before it accepts, and
 * before a build is queued. A rule that only exists in one of those places
 * is a rule someone routes around.
 */

const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** Names we route ourselves, so a channel address cannot take them. */
export const RESERVED_CHANNEL_SLUGS = Object.freeze([
  'www', 'api', 'app', 'admin', 'docs', 'status', 'staging', 'dev',
  'chat', 'mail', 'assets', 'static', 'cdn', 'download', 'install',
]);

/** Why this address cannot be used, or null when it can. */
export function channelSlugError(slug: string | null | undefined): string | null {
  const value = (slug || '').trim().toLowerCase();
  if (!value) return 'Pick an address.';
  if (value.length < 3) return 'Must be at least 3 characters.';
  if (value.length > 63) return 'Must be 63 characters or fewer.';
  if (!SLUG_PATTERN.test(value)) {
    return 'Use lowercase letters, numbers and hyphens. It cannot start or end with a hyphen.';
  }
  if (RESERVED_CHANNEL_SLUGS.includes(value)) return 'That address is reserved.';
  return null;
}

/**
 * A usable address from a display name: lowercase letters, digits and
 * single hyphens, 3 to 63 characters, not reserved, and not one `taken`
 * answers yes to. A clash gets `-2`, `-3`, ... so the result is free.
 */
export function channelSlugFromName(name: string, taken: (slug: string) => boolean): string {
  let base = (name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|(?<!-)-+$/g, '')
    .slice(0, 50)
    .replace(/(?<!-)-+$/, '');
  if (channelSlugError(base)) base = base ? `${base}-chat` : 'chat';
  if (channelSlugError(base)) base = 'agent-chat';
  if (!taken(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken(candidate)) return candidate;
  }
}

/** Channels that have an address or a file name: the web chat and the downloads. */
export const SLUGGED_CHANNEL_TYPES: readonly ChannelType[] = Object.freeze([
  ChannelType.WEB,
  ChannelType.DESKTOP,
  ChannelType.TUI,
]);

/** What a new channel is called until its owner names it: the type's label. */
export const CHANNEL_DEFAULT_NAMES: Readonly<Record<ChannelType, string>> = Object.freeze({
  [ChannelType.WEB]: 'Web chat',
  [ChannelType.WIDGET]: 'Website widget',
  [ChannelType.A2A]: 'Other agents (A2A)',
  [ChannelType.TUI]: 'Terminal app',
  [ChannelType.DESKTOP]: 'Desktop app',
  [ChannelType.SLACK]: 'Slack',
  [ChannelType.DISCORD]: 'Discord',
  [ChannelType.TELEGRAM]: 'Telegram',
  [ChannelType.WHATSAPP]: 'WhatsApp (Twilio)',
  [ChannelType.WHATSAPP_CLOUD]: 'WhatsApp (Meta Cloud)',
  [ChannelType.SMS]: 'SMS',
  [ChannelType.IMESSAGE_SENDBLUE]: 'iMessage (Sendblue)',
  [ChannelType.IMESSAGE_LOOPMESSAGE]: 'iMessage (LoopMessage)',
  [ChannelType.MICROSOFT_TEAMS]: 'Microsoft Teams',
  [ChannelType.GOOGLE_CHAT]: 'Google Chat',
  [ChannelType.EMAIL]: 'Email',
  [ChannelType.SIGNAL]: 'Signal',
  [ChannelType.MATRIX]: 'Matrix',
  [ChannelType.IRC]: 'IRC',
  [ChannelType.WEBHOOK]: 'Webhook',
});

export const MAX_CHANNEL_NAME_LENGTH = 120;

/** Why a channel name cannot be used, or null. */
export function channelNameError(name: unknown): string | null {
  if (typeof name !== 'string' || !name.trim()) return 'Give the channel a name.';
  if (name.trim().length > MAX_CHANNEL_NAME_LENGTH) return `Keep the name to ${MAX_CHANNEL_NAME_LENGTH} characters.`;
  return null;
}

/** The type's label, numbered when the agent already has a channel of that name. */
export function defaultChannelName(type: ChannelType, taken: (name: string) => boolean): string {
  const base = CHANNEL_DEFAULT_NAMES[type] ?? String(type);
  if (!taken(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken(candidate)) return candidate;
  }
}

/**
 * The channels that talk to people, and so carry the AI disclosure switch:
 * the web chat, the website widget and every messaging platform. A desktop
 * app shows its web chat, so it follows that web chat's switch.
 */
export function carriesDisclosure(type: ChannelType | string): boolean {
  return type === ChannelType.WEB || type === ChannelType.WIDGET || MESSAGING_CHANNEL_TYPES.includes(type as ChannelType);
}

/** The per-channel AI disclosure switch: on unless it was turned off. */
export function disclosureOn(configuration: Record<string, any> | null | undefined): boolean {
  return configuration?.aiDisclosure !== false;
}

/**
 * Reason codes for refusing to publish or build. Each is paired with a
 * sentence an operator can act on.
 */
export const CHANNEL_REFUSALS = Object.freeze({
  SLUG_INVALID: 'The channel address is missing or not usable.',
  PUBLIC_NEEDS_COST_CAP:
    'Anyone with the link or the download can use this, so it needs a spend limit per run first. Without one, a stranger can spend against your model keys.',
  PUBLIC_NEEDS_RATE_LIMIT:
    'A channel open to anyone needs a per-visitor and a per-IP message limit, so one visitor cannot use it up for everyone else.',
  SSO_NOT_ENTITLED: 'Signing in with your own directory requires a commercial licence.',
  WHITE_LABEL_NOT_ENTITLED: 'Removing the almyty mark requires a commercial licence.',
  DISCLOSURE_REMOVAL_NOT_ENTITLED:
    'Removing the AI disclosure requires the white-label entitlement (EU AI Act Art. 50).',
  LOCAL_ACCESS_NEEDS_APPROVAL_GATE:
    'An app that can run local commands must ask the user before it does. Add an approval requirement, or turn shell access off.',
  LOCAL_ACCESS_ON_PUBLIC:
    'An app anyone can download must not have local filesystem or shell access. Restrict who can use it, or remove the access.',
  MISSING_CREDENTIALS: 'This platform still needs its keys before it can go live: ',
  WIDGET_HAS_NO_SIGN_IN: PUBLISH_REFUSALS.WIDGET_HAS_NO_SIGN_IN,
  BUNDLE_ID_INVALID:
    'Desktop and terminal apps need a reverse-domain identifier such as com.acme.assistant.',
  DESKTOP_NEEDS_WEB_CHAT: PUBLISH_REFUSALS.DESKTOP_NEEDS_WEB_CHAT,
});

export type ChannelRefusalCode = keyof typeof CHANNEL_REFUSALS;

export interface ChannelCheck {
  ok: boolean;
  refusals: Array<{ code: ChannelRefusalCode; message: string }>;
}

/** What a check needs to know that is not on the channel: the org's entitlements. */
export interface ChannelContext {
  hasWhiteLabel?: boolean;
  hasEnterpriseAuth?: boolean;
}

/**
 * The limits an agent's channels start with.
 *
 * Open-to-anyone channels get a ceiling on every axis: sixty messages an
 * hour per visitor is a real conversation, one hundred and twenty per
 * address covers an office behind one NAT, and half a dollar per run
 * bounds a runaway tool loop. Gated channels (SSO) start with only the
 * cost cap, since the identity gate already stands between an unknown
 * visitor and the model keys.
 */
export const DEFAULT_PUBLIC_LIMITS: Readonly<VisitorLimits> = Object.freeze({
  costCapCents: 50,
  perUserRateLimit: 60,
  perIpRateLimit: 120,
});

/**
 * The auth modes that keep a stranger out.
 *
 * SSO is a gate: only the organization's own IdP can vouch for someone
 * (ee/modules/sso/hosted-chat-sso.controller.ts). Email codes and OAuth
 * have sign-in flows too but are NOT gates: anyone with an inbox, or an
 * account at a public provider, passes, so a channel set to either is
 * still open to the public and keeps every public cap.
 *
 * Adding a mode here without a route that binds an identity for it
 * re-opens the hole; auth-modes-fail-closed.guard.spec.ts checks the list
 * against the routes.
 */
export const GATED_AUTH_MODES: readonly VisitorAuthMode[] = Object.freeze([VisitorAuthMode.SSO]);

/** True when anyone holding the link or the download can use it. */
export function isOpenToAnyone(authMode: VisitorAuthMode | string | undefined | null): boolean {
  return !GATED_AUTH_MODES.includes((authMode ?? VisitorAuthMode.PUBLIC_LINK) as VisitorAuthMode);
}

export function defaultLimitsFor(authMode: VisitorAuthMode | string | undefined | null): VisitorLimits {
  if (isOpenToAnyone(authMode)) return { ...DEFAULT_PUBLIC_LIMITS };
  return { costCapCents: DEFAULT_PUBLIC_LIMITS.costCapCents, perUserRateLimit: null, perIpRateLimit: null };
}

/**
 * What an agent's channels may spend together. An open agent starts at
 * five dollars a UTC day and fifty a month; a gated one with none.
 */
export const DEFAULT_PUBLIC_DAILY_SPEND_CAP_CENTS = 500;
export const DEFAULT_PUBLIC_MONTHLY_SPEND_CAP_CENTS = 5000;

export interface SpendCaps {
  /** Null means no daily ceiling. */
  dailyCents: number | null;
  /** Null means no monthly ceiling. */
  monthlyCents: number | null;
}

function capFrom(value: unknown, fallback: number | null): number | null {
  // Missing is "the default"; null, zero or anything unusable is "none".
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

/** The effective spend caps: stored values over the defaults for the auth mode. */
export function spendCapsFrom(rules: { limits?: VisitorLimits | null; authMode?: VisitorAuthMode | string | null }): SpendCaps {
  const open = isOpenToAnyone(rules.authMode);
  return {
    dailyCents: capFrom(rules.limits?.dailySpendCapCents, open ? DEFAULT_PUBLIC_DAILY_SPEND_CAP_CENTS : null),
    monthlyCents: capFrom(rules.limits?.monthlySpendCapCents, open ? DEFAULT_PUBLIC_MONTHLY_SPEND_CAP_CENTS : null),
  };
}

/** The limit fields that are stored; anything else is dropped. */
export const LIMIT_FIELDS = [
  'costCapCents',
  'perUserRateLimit',
  'perIpRateLimit',
  'dailySpendCapCents',
  'monthlySpendCapCents',
] as const;

/** The spend-cap fields: a channel that sets either has a spend allowance of its own. */
export const SPEND_CAP_FIELDS = ['dailySpendCapCents', 'monthlySpendCapCents'] as const;

/**
 * Limits as stored: known fields only, each a whole number of zero or
 * more, or null. A field left out stays out, which means "the default"
 * (or, on a channel, "the agent's"); null means "none". Throws a message
 * the caller turns into a 400.
 */
export function normalizeLimits(limits: Record<string, any> | null | undefined): VisitorLimits | null {
  if (limits == null) return null;
  const out: Record<string, number | null> = {};
  for (const field of LIMIT_FIELDS) {
    if (!(field in limits)) continue;
    const value = limits[field];
    if (value === null) {
      out[field] = null;
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error('Limits must be whole numbers of zero or more, or empty.');
    }
    out[field] = Math.floor(value);
  }
  return out as VisitorLimits;
}

const PRIVACY_FIELDS = ['retentionDays', 'visitorCanDelete', 'visitorCanExport', 'visitorMemory'] as const;
const BRANDING_FIELDS = [
  'appName',
  'primaryColor',
  'logoUrl',
  'iconUrl',
  'greeting',
  'theme',
  'suggestedPrompts',
  'aiDisclosure',
  'whiteLabel',
] as const;

/** Only the known fields of an object, dropping the rest. Null stays null. */
function pick<T extends object>(value: unknown, fields: readonly string[]): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object.');
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in (value as Record<string, unknown>)) out[field] = (value as Record<string, unknown>)[field];
  }
  return out as T;
}

export function normalizeBranding(branding: unknown): ChannelBranding | null {
  return pick<ChannelBranding>(branding, BRANDING_FIELDS);
}

/** Visitor rules as stored: known fields only, limits checked. */
export function normalizeVisitorRules(rules: unknown): VisitorRules | null {
  const picked = pick<Record<string, any>>(rules, ['authMode', 'limits', 'privacy']);
  if (!picked) return null;
  const out: VisitorRules = {};
  if ('authMode' in picked) {
    if (!(Object.values(VisitorAuthMode) as string[]).includes(picked.authMode)) {
      throw new Error('Who can use it must be one of public_link, email_otp, oauth or sso.');
    }
    out.authMode = picked.authMode;
  }
  if ('limits' in picked) out.limits = normalizeLimits(picked.limits);
  if ('privacy' in picked) out.privacy = pick<VisitorPrivacy>(picked.privacy, PRIVACY_FIELDS);
  return out;
}

/** The agent-side settings a channel inherits from. */
export interface AgentPublicSettings {
  name: string;
  branding?: ChannelBranding | null;
  visitorRules?: VisitorRules | null;
}

/** The channel-side overrides. */
export interface ChannelOverrides {
  branding?: ChannelBranding | null;
  visitorRules?: VisitorRules | null;
}

/** Defined fields of `override` over `base`. */
function overlay<T extends object>(base: T | null | undefined, override: T | null | undefined): T {
  const out: Record<string, unknown> = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

/** What a channel's visitors see: the agent's branding with the channel's fields over it. */
export function effectiveBranding(agent: AgentPublicSettings, channel?: ChannelOverrides | null): ChannelBranding & { appName: string } {
  const merged = overlay<ChannelBranding>(agent.branding, channel?.branding);
  return { ...merged, appName: (merged.appName ?? '').trim() || agent.name };
}

/** The visitor rules a channel applies, every field resolved. */
export interface EffectiveVisitorRules {
  authMode: VisitorAuthMode;
  limits: VisitorLimits;
  privacy: Required<VisitorPrivacy>;
  caps: SpendCaps;
  /** True when the channel has a spend allowance of its own rather than sharing the agent's. */
  ownSpend: boolean;
}

/**
 * The agent's visitor rules with the channel's fields over them.
 *
 * Limits missing on both take the defaults for the resolved auth mode, so
 * an agent nobody configured is still capped. Spend caps are scoped to
 * where they are set: a channel that sets either spend cap has its own
 * allowance; every other channel shares the agent's.
 */
export function effectiveVisitorRules(agent: AgentPublicSettings, channel?: ChannelOverrides | null): EffectiveVisitorRules {
  const agentRules = agent.visitorRules ?? {};
  const channelRules = channel?.visitorRules ?? {};
  const authMode = (channelRules.authMode ?? agentRules.authMode ?? VisitorAuthMode.PUBLIC_LINK) as VisitorAuthMode;
  const limits = overlay<VisitorLimits>(
    overlay<VisitorLimits>(defaultLimitsFor(authMode), agentRules.limits ?? undefined),
    channelRules.limits ?? undefined,
  );
  const ownSpend = SPEND_CAP_FIELDS.some((field) => channelRules.limits != null && field in channelRules.limits);
  // Spend caps default by whose allowance it is: the agent's pool reads the
  // agent's own mode, a channel's own pool the channel's.
  const capsFrom = ownSpend
    ? { limits: overlay<VisitorLimits>(agentRules.limits ?? undefined, channelRules.limits ?? undefined), authMode }
    : { limits: agentRules.limits ?? undefined, authMode: agentRules.authMode ?? VisitorAuthMode.PUBLIC_LINK };
  return {
    authMode,
    limits,
    privacy: visitorPrivacyFrom(overlay<VisitorPrivacy>(agentRules.privacy ?? undefined, channelRules.privacy ?? undefined)),
    caps: spendCapsFrom(capsFrom),
    ownSpend,
  };
}

/** True when a download grants any access to the machine it runs on. */
export function grantsLocalAccess(capabilities: ChannelCapabilities | null | undefined): boolean {
  if (!capabilities) return false;
  return (
    capabilities.shell === true ||
    (capabilities.filesystemRead?.length ?? 0) > 0 ||
    (capabilities.filesystemWrite?.length ?? 0) > 0
  );
}

export const BUNDLE_ID_PATTERN = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;

/** Apple's ceiling for a bundle identifier; nothing we build to takes more. */
export const MAX_BUNDLE_ID_LENGTH = 155;

/** Why this bundle identifier cannot go into a build, or null when it can. */
export function bundleIdError(bundleId: unknown): string | null {
  return typeof bundleId === 'string' &&
    bundleId.length <= MAX_BUNDLE_ID_LENGTH &&
    BUNDLE_ID_PATTERN.test(bundleId)
    ? null
    : CHANNEL_REFUSALS.BUNDLE_ID_INVALID;
}

/**
 * What a build version may look like: `1`, `1.2`, `1.2.3` or `1.2.3.4`,
 * optionally followed by a `-prerelease` and a `+build` tag. The version
 * reaches the packager's command line, so anything else is refused before
 * a build is queued.
 */
export const BUILD_VERSION_PATTERN =
  /^\d{1,9}(?:\.\d{1,9}){0,3}(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,39})?(?:\+[0-9A-Za-z][0-9A-Za-z.-]{0,39})?$/;

export const MAX_BUILD_VERSION_LENGTH = 64;

export const BUILD_VERSION_INVALID =
  'A build version is numbers separated by dots, such as 1.2.3, optionally with a -beta.1 or +build tag.';

/** Why this build version cannot go into a build, or null when it can (or is absent). */
export function buildVersionError(version: unknown): string | null {
  if (version === undefined || version === null) return null;
  return typeof version === 'string' &&
    version.length <= MAX_BUILD_VERSION_LENGTH &&
    BUILD_VERSION_PATTERN.test(version)
    ? null
    : BUILD_VERSION_INVALID;
}

/** Channels that produce a file someone installs, and so need a bundle id. */
const PACKAGED_TYPES: readonly ChannelType[] = Object.freeze([ChannelType.DESKTOP]);

/** Whether a channel produces a file someone installs (and so needs a bundle id). */
export function isPackagedType(type: ChannelType | string): boolean {
  return PACKAGED_TYPES.includes(type as ChannelType);
}

/** Channels built into a download rather than served. */
export const BUILDABLE_TYPES: readonly ChannelType[] = Object.freeze([ChannelType.TUI, ChannelType.DESKTOP]);

export function isBuildableType(type: ChannelType | string): boolean {
  return BUILDABLE_TYPES.includes(type as ChannelType);
}

/**
 * The bundle identifier a packaged channel starts with, built from its
 * address: `support-bot` becomes `app.almyty.supportbot`.
 */
export function defaultBundleId(
  slug: string,
  namespace: string = process.env.APP_BUILD_BUNDLE_NAMESPACE ?? 'app.almyty',
): string {
  return `${namespace}.${slug.replace(/[^a-z0-9]+/gi, '').toLowerCase()}`;
}

/** The shape checkChannel reads: the channel and what it resolves to on its agent. */
export interface ChannelShape {
  type: ChannelType | string;
  slug?: string | null;
  configuration?: Record<string, any> | null;
  branding: ChannelBranding;
  rules: Pick<EffectiveVisitorRules, 'authMode' | 'limits'>;
}

/**
 * Whether a channel may go live or be built, and if not, why.
 *
 * The two rules worth stating out loud, because they turn a demo into an
 * incident: an open channel with no cost cap hands strangers the
 * customer's model spend, and a download with local access handed to
 * anyone is a shell on whoever installs it.
 */
export function checkChannel(channel: ChannelShape, context: ChannelContext = {}): ChannelCheck {
  const refusals: Array<{ code: ChannelRefusalCode; message: string }> = [];
  const refuse = (code: ChannelRefusalCode, detail = '') =>
    refusals.push({ code, message: `${CHANNEL_REFUSALS[code]}${detail}` });

  if (SLUGGED_CHANNEL_TYPES.includes(channel.type as ChannelType) && channelSlugError(channel.slug)) {
    refuse('SLUG_INVALID');
  }

  const { authMode, limits } = channel.rules;
  const open = isOpenToAnyone(authMode);
  if (open) {
    if (!limits.costCapCents || limits.costCapCents <= 0) refuse('PUBLIC_NEEDS_COST_CAP');
    if ((limits.perUserRateLimit ?? 0) <= 0 || (limits.perIpRateLimit ?? 0) <= 0) refuse('PUBLIC_NEEDS_RATE_LIMIT');
  }
  if (authMode === VisitorAuthMode.SSO && !context.hasEnterpriseAuth) refuse('SSO_NOT_ENTITLED');

  if (channel.branding.whiteLabel && !context.hasWhiteLabel) refuse('WHITE_LABEL_NOT_ENTITLED');
  // Null means the default line. An empty string is a removal.
  const disclosure = channel.branding.aiDisclosure;
  const switchedOff = carriesDisclosure(channel.type) && !disclosureOn(channel.configuration);
  if (((typeof disclosure === 'string' && disclosure.trim() === '') || switchedOff) && !context.hasWhiteLabel) {
    refuse('DISCLOSURE_REMOVAL_NOT_ENTITLED');
  }

  const capabilities = channel.configuration?.capabilities as ChannelCapabilities | undefined;
  if (isBuildableType(channel.type) && grantsLocalAccess(capabilities)) {
    if (open) refuse('LOCAL_ACCESS_ON_PUBLIC');
    if (capabilities?.shell && !capabilities.requireApprovalFor?.length) refuse('LOCAL_ACCESS_NEEDS_APPROVAL_GATE');
  }

  if (isPackagedType(channel.type)) {
    const bundleId = String(channel.configuration?.bundleId ?? '').trim();
    if (bundleIdError(bundleId)) refuse('BUNDLE_ID_INVALID');
  }

  // Checked here as well as at publish so the page does not say "ready"
  // while the key fields are empty.
  if (servesOverGateway(channel.type)) {
    const missing = missingCredentials(channel.type, channel.configuration);
    if (missing.length) refuse('MISSING_CREDENTIALS', missing.join(', '));
  }

  // The widget runs on someone else's page with no sign-in of ours.
  if (channel.type === ChannelType.WIDGET && authMode !== VisitorAuthMode.PUBLIC_LINK) {
    refuse('WIDGET_HAS_NO_SIGN_IN');
  }

  return { ok: refusals.length === 0, refusals };
}
