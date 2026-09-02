/**
 * Which tenant, if any, this page was loaded for.
 *
 * Mirrors slugFromHost in
 * backend/src/modules/gateways/channels/hosted-chat.config.ts. The base
 * domain is build-time configuration rather than a constant, because the
 * hosted chat app is Apache core: a self-hoster points a wildcard at
 * their own deployment and sets their own domain. almyty.app is what
 * almyty.com happens to run, not a requirement of the feature.
 */

// Last-resort default when neither the runtime config nor the dev
// ALMYTY_ var is set. Real deployments always set HOSTED_CHAT_BASE_DOMAIN.
export const DEFAULT_HOSTED_CHAT_BASE_DOMAIN = 'almyty.app'

/** Hosts we route ourselves, which can never be a tenant. */
export const RESERVED_SLUGS = [
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
]

export function hostedChatBaseDomain(): string {
  // Production reads the domain from k8s at runtime: docker-entrypoint.sh
  // writes it into /runtime-config.js from HOSTED_CHAT_BASE_DOMAIN, so the
  // image itself is environment-agnostic. ALMYTY_ is only a dev fallback.
  const runtime =
    typeof window !== 'undefined'
      ? String((window as unknown as {
          __ALMYTY_RUNTIME__?: { hostedChatBaseDomain?: string }
        }).__ALMYTY_RUNTIME__?.hostedChatBaseDomain ?? '')
          .trim()
          .toLowerCase()
      : ''
  if (runtime) return runtime

  const configured = String(import.meta.env?.ALMYTY_HOSTED_CHAT_BASE_DOMAIN ?? '')
    .trim()
    .toLowerCase()
  return configured || DEFAULT_HOSTED_CHAT_BASE_DOMAIN
}

/**
 * The tenant slug for a hostname, or null when this is not a tenant
 * subdomain. Returning null is what lets the dashboard keep serving
 * app.almyty.com and localhost unchanged.
 */
export function slugFromHost(host: string | undefined, baseDomain = hostedChatBaseDomain()): string | null {
  if (!host) return null
  const hostname = host.split(':')[0].trim().toLowerCase()
  if (!hostname.endsWith(`.${baseDomain}`)) return null

  const label = hostname.slice(0, -(baseDomain.length + 1))
  // A single label only: a.b.almyty.app is not a tenant.
  if (!label || label.includes('.')) return null
  if (RESERVED_SLUGS.includes(label)) return null
  return label
}

/**
 * Local development escape hatch. Without a wildcard DNS entry there is
 * no way to reach a tenant host on localhost, so `?__slug=acme` stands
 * in. Confined to dev builds so it can never be used to address another
 * tenant in production.
 */
export function devSlugOverride(search: string): string | null {
  if (!import.meta.env?.DEV) return null
  const slug = new URLSearchParams(search).get('__slug')
  return slug && slug.trim() ? slug.trim().toLowerCase() : null
}

/** The tenant this page is serving, if any. */
export function currentTenantSlug(location: Location = window.location): string | null {
  return devSlugOverride(location.search) ?? slugFromHost(location.hostname)
}

/** True on {slug}.almyty.app (or a configured base), where the dashboard must not run. */
export function isHostedChatHost(location: Location = window.location): boolean {
  return currentTenantSlug(location) !== null
}