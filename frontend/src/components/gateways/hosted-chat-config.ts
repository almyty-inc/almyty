import { hostedChatBaseDomain, RESERVED_SLUGS } from '@/lib/tenant-host'

/**
 * Client mirror of
 * backend/src/modules/gateways/channels/hosted-chat.config.ts.
 *
 * The backend is what enforces these; this exists so an operator sees
 * why a chat app cannot go live while it is still fixable, instead of
 * after the API refuses the save. Any rule added there needs adding
 * here, and the wording is copied verbatim so the two never disagree in
 * front of a user.
 */

export type SurfaceAuthMode = 'public_link' | 'email_otp' | 'oauth' | 'sso'

export interface HostedChatConfig {
  slug: string
  appName: string
  primaryColor: string
  greeting: string
  theme: 'dark' | 'light' | 'auto'
  logoUrl: string | null
  suggestedPrompts: string[]
  authMode: SurfaceAuthMode
  aiDisclosure: string | null
  whiteLabel: boolean
}

export const HOSTED_CHAT_DEFAULTS: HostedChatConfig = {
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
}

const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

/** Why this slug is not usable, or null when it is fine. */
export function slugError(slug: string): string | null {
  const value = (slug || '').trim().toLowerCase()
  if (!value) return 'Pick a subdomain.'
  if (value.length < 3) return 'Must be at least 3 characters.'
  if (value.length > 63) return 'Must be 63 characters or fewer.'
  if (!SLUG_PATTERN.test(value)) {
    return 'Use lowercase letters, numbers and hyphens. It cannot start or end with a hyphen.'
  }
  if (RESERVED_SLUGS.includes(value)) return 'That subdomain is reserved.'
  return null
}

export function hostedChatUrl(slug: string): string {
  return `https://${slug}.${hostedChatBaseDomain()}`
}

export function hostedChatConfigFrom(
  configuration: Record<string, any> | null | undefined,
): HostedChatConfig {
  const raw = configuration?.hostedChat
  const merged = {
    ...HOSTED_CHAT_DEFAULTS,
    ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}),
  }
  return {
    ...merged,
    suggestedPrompts: Array.isArray(merged.suggestedPrompts)
      ? merged.suggestedPrompts.slice(0, 4)
      : [],
  }
}

/** Copied verbatim from HOSTED_CHAT_REFUSALS on the backend. */
export const HOSTED_CHAT_REFUSALS = {
  SLUG_INVALID: 'The subdomain is missing or not a valid hostname label.',
  PUBLIC_LINK_NEEDS_COST_CAP:
    'A public link has no gate in front of it, so it needs a cost cap before it can go live. Without one, anyone with the URL can spend against your model keys.',
  PUBLIC_LINK_NEEDS_RATE_LIMIT:
    'A public link needs both a per-visitor and a per-IP rate limit before it can go live, so one visitor cannot exhaust the surface for everyone else.',
  DISCLOSURE_REMOVAL_NOT_ENTITLED:
    'Removing the AI disclosure requires the white-label entitlement (EU AI Act Art. 50).',
  AUTH_MODE_NOT_ENTITLED: 'That sign-in method requires a commercial licence.',
} as const

export type HostedChatRefusalCode = keyof typeof HOSTED_CHAT_REFUSALS

export interface HostedChatPublishContext {
  costCapCents?: number | null
  perEndUserRateLimit?: number | null
  perIpRateLimit?: number | null
  hasWhiteLabel?: boolean
  hasEnterpriseAuth?: boolean
}

export interface HostedChatPublishCheck {
  publishable: boolean
  refusals: Array<{ code: HostedChatRefusalCode; message: string }>
}

export function canPublishHostedChat(
  config: HostedChatConfig,
  context: HostedChatPublishContext = {},
): HostedChatPublishCheck {
  const refusals: Array<{ code: HostedChatRefusalCode; message: string }> = []
  const refuse = (code: HostedChatRefusalCode) =>
    refusals.push({ code, message: HOSTED_CHAT_REFUSALS[code] })

  if (slugError(config.slug)) refuse('SLUG_INVALID')

  if (config.authMode === 'public_link') {
    if (!context.costCapCents || context.costCapCents <= 0) refuse('PUBLIC_LINK_NEEDS_COST_CAP')
    if ((context.perEndUserRateLimit ?? 0) <= 0 || (context.perIpRateLimit ?? 0) <= 0) {
      refuse('PUBLIC_LINK_NEEDS_RATE_LIMIT')
    }
  }

  if (config.authMode === 'sso' && !context.hasEnterpriseAuth) refuse('AUTH_MODE_NOT_ENTITLED')

  // Null means "use the default line"; an empty string is a removal.
  const removesDisclosure = config.aiDisclosure !== null && config.aiDisclosure.trim() === ''
  if (removesDisclosure && !context.hasWhiteLabel) refuse('DISCLOSURE_REMOVAL_NOT_ENTITLED')

  return { publishable: refusals.length === 0, refusals }
}
