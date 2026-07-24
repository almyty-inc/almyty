/**
 * PostHog product analytics wrapper.
 *
 * Cross-domain funnel stitching: almyty.com (marketing) already runs
 * PostHog Cloud EU cookieless. This wrapper mirrors that setup inside the
 * app so a site visit → signup → activation funnel can be stitched by
 * identifying the logged-in user.
 *
 * Delivery: events are NOT sent to eu.i.posthog.com directly — ad
 * blockers (uBlock, Brave, Safari ITP) drop that hostname on sight. We
 * point `api_host` at a SAME-ORIGIN reverse proxy path ('/ingest' by
 * default) which nginx forwards to PostHog EU. The browser only ever
 * talks to the app's own domain, so there is nothing for a blocker to
 * match. `ui_host` stays on the real PostHog origin so toolbar/session
 * links still resolve.
 *
 * Privacy posture (matches almyty.com/privacy):
 *   - Cookieless: persistence is 'memory' — no cookies, no localStorage.
 *   - EU host (via the proxy) by default.
 *   - person_profiles: 'identified_only' — anonymous visitors never get a
 *     profile; a profile only exists once we identify() after login, which
 *     is a deliberate authenticated action (contract basis).
 *   - identify() carries the minimum: user id, org id, and plan. Nothing
 *     more.
 *
 * SPA pageviews: capture_pageview is DISABLED here. PostHog's automatic
 * pageview only fires on the initial hard load; client-side react-router
 * navigations send nothing. We capture $pageview manually on every route
 * change via capturePageview() (see usePageviews hook), and PostHog emits
 * the matching $pageleave automatically.
 *
 * Turnkey / no-op contract:
 *   - Reads VITE_POSTHOG_KEY at init. If it is unset, PostHog is NEVER
 *     loaded — no network, no cookies, no errors. Every exported function
 *     becomes a safe no-op. The app runs identically with or without the
 *     key, so this can ship dark and be lit up by setting an env var.
 */
import type { PostHog } from 'posthog-js'

// Same-origin reverse-proxy path. nginx (frontend/nginx.conf) forwards
// /ingest/* to PostHog EU. Overridable per-environment via
// VITE_POSTHOG_HOST — e.g. an absolute 'https://app.almyty.com/ingest'
// once the marketing + app origins are aligned. THIS is the one default
// to change if the external proxy path ever moves.
const DEFAULT_HOST = '/ingest'
// Where the PostHog toolbar/app links should point (real PH origin), so
// they keep working even though events flow through the proxy.
const UI_HOST = 'https://eu.posthog.com'

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

export type AppEnvironment = 'production' | 'staging' | 'development'

/**
 * Which deployment this bundle is running in. Used to (a) keep development
 * completely untracked and (b) tag staging vs production events so they are
 * cleanly separable in one shared PostHog project.
 *
 * Resolution: an explicit VITE_APP_ENV build override wins; otherwise infer
 * from the host. Anything that isn't the known prod/staging host — localhost,
 * *.dev.*, preview builds, unknown — is treated as development (untracked),
 * which is the safe default: we never want to pollute analytics with local or
 * unrecognized traffic.
 */
export function readEnvironment(): AppEnvironment {
  const explicit = import.meta.env.VITE_APP_ENV
  if (explicit === 'production' || explicit === 'staging' || explicit === 'development') {
    return explicit
  }
  const host = typeof window !== 'undefined' ? window.location.hostname : ''
  if (host === 'app.almyty.com') return 'production'
  if (host.includes('.staging.')) return 'staging'
  return 'development'
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
  // Development (and localhost / preview / unknown hosts) is never tracked —
  // only staging and production emit events. Import nothing, touch no network.
  const environment = readEnvironment()
  if (environment === 'development') return
  initStarted = true

  const { default: posthog } = await import('posthog-js')
  posthog.init(key, {
    // Events flow through the same-origin proxy so ad blockers can't
    // drop them; ui_host keeps toolbar/session links on the real PH app.
    api_host: readHost(),
    ui_host: UI_HOST,
    // Cookieless: keep everything in memory, cleared on reload.
    persistence: 'memory',
    autocapture: true,
    // Disabled: PostHog's auto pageview only fires on the initial hard
    // load. SPA route changes are captured manually via capturePageview()
    // (usePageviews hook). PostHog still emits $pageleave automatically.
    capture_pageview: false,
    // Anonymous visitors never get a person profile; only identified
    // (post-login) users do. This is the cookieless funnel contract.
    person_profiles: 'identified_only',
    // Session replay config. Two things make a B2B auth-page replay both
    // usable AND privacy-safe:
    //   Privacy — maskAllInputs masks EVERY <input>, so the password and
    //   email fields on /auth/* are never captured as plaintext. We do NOT
    //   set maskTextSelector/maskAllText: masking text too would blank the
    //   whole page (the replay becomes empty boxes). The static labels and
    //   headings here carry nothing sensitive.
    //   Styling — inlineStylesheet copies the app's CSS *into* each
    //   snapshot. Without it rrweb leaves the built stylesheet as a bare
    //   <link href="/assets/index-<hash>.css">, which the replay player (a
    //   sandboxed iframe on the PostHog origin) cannot fetch — and the hash
    //   changes every deploy — so the DOM renders unstyled and the logo
    //   <img> balloons to its intrinsic size. The "giant centered almyty
    //   logo" replay was exactly that: an un-inlined stylesheet.
    session_recording: {
      maskAllInputs: true,
      inlineStylesheet: true,
      recordCrossOriginIframes: false,
    },
    // Hold recording until the document has fully loaded (see
    // startRecordingOnLoad). initAnalytics() runs at the top of main.tsx —
    // before React mounts and, on a cold load, before /assets/index-<hash>
    // .css has parsed. A first full snapshot taken in that window can't read
    // the stylesheet's CSSOM yet, so the CSS isn't inlined and the replay is
    // unstyled. Deferring the first snapshot to 'load' guarantees the CSS is
    // present and that the mounted form is what gets captured.
    disable_session_recording: true,
  })
  // Tag every event with the deployment so staging and production stay
  // cleanly separable inside the one shared project (filter/breakdown on
  // `environment`). register() persists it as a super-property on all events.
  posthog.register({ environment })
  client = posthog
  // Recording was held at init (disable_session_recording); turn it on
  // once the stylesheet is guaranteed loaded so the first snapshot renders.
  startRecordingOnLoad(posthog)
}

/**
 * Begin session replay only after the document has fully loaded, so the
 * app stylesheet is parsed and rrweb can inline it into the very first full
 * snapshot (see the disable_session_recording note in initAnalytics). By
 * 'load' React has also mounted, so the captured DOM is the real page — not
 * a pre-mount bootstrap frame. If the document is already complete (e.g. a
 * warm client-side entry), start immediately.
 */
function startRecordingOnLoad(posthog: PostHog): void {
  if (typeof document === 'undefined') return
  const start = () => posthog.startSessionRecording()
  if (document.readyState === 'complete') {
    start()
  } else {
    window.addEventListener('load', start, { once: true })
  }
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

/**
 * Capture a manual $pageview for the current SPA route. Called by the
 * usePageviews hook on every client-side navigation, since
 * capture_pageview is disabled at init. No-op when analytics is
 * disabled. Passing the current path as $current_url keeps PostHog's
 * pageview URL accurate for history-based SPA routing.
 */
export function capturePageview(path?: string): void {
  if (!client) return
  const props =
    path && typeof window !== 'undefined'
      ? { $current_url: window.location.origin + path }
      : undefined
  client.capture('$pageview', props)
}
