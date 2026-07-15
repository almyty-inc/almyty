/**
 * PostHog product analytics wrapper.
 *
 * Cross-domain funnel stitching: almyty.com (marketing) already runs
 * PostHog Cloud EU cookieless. This wrapper mirrors that setup inside the
 * app so a site visit → signup → activation funnel can be stitched by
 * identifying the logged-in user.
 *
 * Privacy posture (matches almyty.com/privacy):
 *   - Cookieless: persistence is 'memory' — no cookies, no localStorage.
 *   - EU host by default (https://eu.i.posthog.com).
 *   - person_profiles: 'identified_only' — anonymous visitors never get a
 *     profile; a profile only exists once we identify() after login, which
 *     is a deliberate authenticated action (contract basis).
 *   - identify() carries the minimum: user id, org id, and plan. Nothing
 *     more.
 *
 * Turnkey / no-op contract:
 *   - Reads VITE_POSTHOG_KEY at init. If it is unset, PostHog is NEVER
 *     loaded — no network, no cookies, no errors. Every exported function
 *     becomes a safe no-op. The app runs identically with or without the
 *     key, so this can ship dark and be lit up by setting an env var.
 */
import type { PostHog } from 'posthog-js'

const DEFAULT_HOST = 'https://eu.i.posthog.com'

// Live PostHog client, or null while uninitialized / disabled.
let client: PostHog | null = null
// Guards against double-init (e.g. React StrictMode double-invoke).
let initStarted = false

export interface IdentifyTraits {
  /** Authenticated user id. */
  id: string
  /** Current organization id, if one is selected. */
  orgId?: string
  /** Organization plan (free, pro, ...), if available. */
  plan?: string
}

function readKey(): string | undefined {
  const key = import.meta.env.VITE_POSTHOG_KEY
  return typeof key === 'string' && key.trim() !== '' ? key.trim() : undefined
}

function readHost(): string {
  const host = import.meta.env.VITE_POSTHOG_HOST
  return typeof host === 'string' && host.trim() !== '' ? host.trim() : DEFAULT_HOST
}

/**
 * Initialize PostHog once at app bootstrap. No-op (and never touches the
 * network) when VITE_POSTHOG_KEY is unset. Safe to call more than once —
 * subsequent calls are ignored.
 */
export async function initAnalytics(): Promise<void> {
  if (initStarted) return
  const key = readKey()
  // No key → analytics stays completely dark. Do not import posthog-js.
  if (!key) return
  initStarted = true

  const { default: posthog } = await import('posthog-js')
  posthog.init(key, {
    api_host: readHost(),
    // Cookieless: keep everything in memory, cleared on reload.
    persistence: 'memory',
    autocapture: true,
    capture_pageview: true,
    // Anonymous visitors never get a person profile; only identified
    // (post-login) users do. This is the cookieless funnel contract.
    person_profiles: 'identified_only',
  })
  client = posthog
}

/**
 * Associate the current PostHog session with the logged-in user. Call
 * only AFTER authentication (contract basis for processing). No-op when
 * analytics is disabled.
 */
export function identifyUser(traits: IdentifyTraits): void {
  if (!client || !traits?.id) return
  const props: Record<string, string> = {}
  if (traits.orgId) props.orgId = traits.orgId
  if (traits.plan) props.plan = traits.plan
  client.identify(traits.id, props)
}

/**
 * Reset the PostHog session on logout so the next user isn't stitched to
 * the previous identity. No-op when analytics is disabled.
 */
export function resetAnalytics(): void {
  if (!client) return
  client.reset()
}

/**
 * Capture a product event. No-op when analytics is disabled.
 */
export function captureEvent(name: string, props?: Record<string, unknown>): void {
  if (!client || !name) return
  client.capture(name, props)
}
