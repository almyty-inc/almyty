import { z } from 'zod';

/**
 * Hosted chat: a tenant's own branded chat app on {slug}.almyty.app.
 *
 * Branding intentionally reuses the embeddable widget's vocabulary
 * (primaryColor, greeting, title, theme) rather than inventing a second
 * one. A tenant branding their widget and their hosted app wants the
 * same colours and the same greeting; two schemas would drift within a
 * release. The extra fields here are only the ones a full-page app needs
 * that a corner bubble does not: a logo, a product name, and starter
 * prompts to fill the empty state.
 */

const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Reserved so a tenant cannot claim a name we route ourselves. */
export const RESERVED_SLUGS = Object.freeze([
  'www',
  'api',
  'app',
  'admin',
  'docs',
  'status',
  'staging',
  'dev',
  'chat',
  'mail',
  'assets',
  'static',
  'cdn',
]);

/**
 * How a visitor proves who they are before they can talk to the agent.
 *
 *   public_link  anyone with the URL, tracked by cookie only
 *   email_otp    one-time code to an email address
 *   oauth        the tenant's own OAuth provider
 *   sso          enterprise SSO, commercial edition
 */
export const SURFACE_AUTH_MODES = ['public_link', 'email_otp', 'oauth', 'sso'] as const;
export type SurfaceAuthMode = (typeof SURFACE_AUTH_MODES)[number];

/** Auth modes that require a commercial licence to publish. */
export const EE_AUTH_MODES: readonly SurfaceAuthMode[] = Object.freeze(['sso']);

export const hostedChatConfigSchema = z.object({
  /** Subdomain label: {slug}.almyty.app. */
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(3, 'Slug must be at least 3 characters')
    .max(63, 'Slug must be 63 characters or fewer')
    // DNS label rules: lowercase alphanumerics and hyphens, not leading
    // or trailing, since this becomes a hostname.
    .regex(
      /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
      'Slug may contain lowercase letters, numbers and hyphens, and cannot start or end with a hyphen',
    )
    .refine((slug) => !RESERVED_SLUGS.includes(slug), {
      message: 'That slug is reserved',
    }),

  /** Product name shown in the header and the browser tab. */
  appName: z.string().trim().min(1, 'Name is required').max(60, 'Name must be 60 characters or fewer'),

  /** Shared with the widget builder. */
  primaryColor: z.string().trim().regex(HEX_COLOR, 'Must be a hex color like #8b5cf6'),
  greeting: z.string().max(300, 'Greeting must be 300 characters or fewer').default(''),
  theme: z.enum(['dark', 'light', 'auto']).default('auto'),

  /** Data URI or uploaded file URL. Optional; falls back to the initial. */
  logoUrl: z.string().trim().max(2048).nullable().default(null),

  /** Fills the empty state. Kept short so they fit on a phone. */
  suggestedPrompts: z
    .array(z.string().trim().min(1).max(120))
    .max(4, 'At most 4 suggested prompts')
    .default([]),

  authMode: z.enum(SURFACE_AUTH_MODES).default('public_link'),

  /**
   * Art. 50 disclosure. Present by default on every hosted chat surface;
   * clearing it requires the white-label entitlement and is audited.
   */
  aiDisclosure: z.string().max(300).nullable().default(null),

  /** Removes almyty branding. Commercial edition. */
  whiteLabel: z.boolean().default(false),
});

export type HostedChatConfig = z.infer<typeof hostedChatConfigSchema>;

export const HOSTED_CHAT_DEFAULTS: HostedChatConfig = Object.freeze({
  slug: '',
  appName: 'Assistant',
  primaryColor: '#8b5cf6',
  greeting: '',
  theme: 'auto',
  logoUrl: null,
  suggestedPrompts: [],
  authMode: 'public_link',
  aiDisclosure: null,
  whiteLabel: false,
});

/** Read the hosted chat block off a gateway, falling back to defaults. */
export function hostedChatConfigFrom(
  configuration: Record<string, any> | null | undefined,
): HostedChatConfig {
  const raw = configuration?.hostedChat;
  const merged = {
    ...HOSTED_CHAT_DEFAULTS,
    ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}),
  };
  const parsed = hostedChatConfigSchema.safeParse(merged);
  return parsed.success ? parsed.data : { ...HOSTED_CHAT_DEFAULTS };
}

/**
 * Reason codes for refusing to publish a hosted chat surface. Machine
 * readable so a caller can act, paired with a sentence a person can act
 * on, per the same contract the run limits use.
 */
export const HOSTED_CHAT_REFUSALS = Object.freeze({
  SLUG_INVALID: 'The subdomain is missing or not a valid hostname label.',
  PUBLIC_LINK_NEEDS_COST_CAP:
    'A public link has no gate in front of it, so it needs a cost cap before it can go live. Without one, anyone with the URL can spend against your model keys.',
  PUBLIC_LINK_NEEDS_RATE_LIMIT:
    'A public link needs both a per-visitor and a per-IP rate limit before it can go live, so one visitor cannot exhaust the surface for everyone else.',
  DISCLOSURE_REMOVAL_NOT_ENTITLED:
    'Removing the AI disclosure requires the white-label entitlement (EU AI Act Art. 50).',
  AUTH_MODE_NOT_ENTITLED: 'That sign-in method requires a commercial licence.',
});

export type HostedChatRefusalCode = keyof typeof HOSTED_CHAT_REFUSALS;

export interface HostedChatPublishCheck {
  publishable: boolean;
  refusals: Array<{ code: HostedChatRefusalCode; message: string }>;
}

export interface HostedChatPublishContext {
  /** Resolved cost ceiling for a run on this surface, in cents. */
  costCapCents?: number | null;
  /** Per-end-user request ceiling. */
  perEndUserRateLimit?: number | null;
  /** Per-IP request ceiling. */
  perIpRateLimit?: number | null;
  /** Whether the org holds the white-label entitlement. */
  hasWhiteLabel?: boolean;
  /** Whether the org holds an entitlement covering EE auth modes. */
  hasEnterpriseAuth?: boolean;
}

/**
 * Whether a hosted chat surface may go live.
 *
 * The public-link rules are enforced here rather than documented,
 * because the failure mode is not cosmetic: on bring-your-own-key, an
 * unprotected public chat URL is a way to hand strangers the customer's
 * model spend. A surface that cannot satisfy them is refused, with the
 * reason, rather than published in a state we would have to apologise
 * for later.
 */
export function canPublishHostedChat(
  config: HostedChatConfig,
  context: HostedChatPublishContext = {},
): HostedChatPublishCheck {
  const refusals: Array<{ code: HostedChatRefusalCode; message: string }> = [];
  const refuse = (code: HostedChatRefusalCode) =>
    refusals.push({ code, message: HOSTED_CHAT_REFUSALS[code] });

  if (!hostedChatConfigSchema.shape.slug.safeParse(config.slug).success) {
    refuse('SLUG_INVALID');
  }

  if (config.authMode === 'public_link') {
    if (!context.costCapCents || context.costCapCents <= 0) {
      refuse('PUBLIC_LINK_NEEDS_COST_CAP');
    }
    const perEndUser = context.perEndUserRateLimit ?? 0;
    const perIp = context.perIpRateLimit ?? 0;
    if (perEndUser <= 0 || perIp <= 0) {
      refuse('PUBLIC_LINK_NEEDS_RATE_LIMIT');
    }
  }

  if (EE_AUTH_MODES.includes(config.authMode) && !context.hasEnterpriseAuth) {
    refuse('AUTH_MODE_NOT_ENTITLED');
  }

  // An empty string is an explicit removal; null means "use the default
  // line", which is always allowed.
  const removesDisclosure = config.aiDisclosure !== null && config.aiDisclosure.trim() === '';
  if (removesDisclosure && !context.hasWhiteLabel) {
    refuse('DISCLOSURE_REMOVAL_NOT_ENTITLED');
  }

  return { publishable: refusals.length === 0, refusals };
}
