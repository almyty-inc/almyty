/**
 * Sentry error tracking wrapper.
 *
 * Mirrors the turnkey / no-op contract of the PostHog wrapper in
 * ./analytics.ts:
 *
 *   - Reads VITE_SENTRY_DSN at init. If it is unset, Sentry is NEVER
 *     loaded — no @sentry/react import, no network, no errors. Every
 *     exported function becomes a safe no-op. The app runs identically
 *     with or without the DSN, so this ships dark and is lit up by
 *     setting a single env var.
 *   - environment is resolved by the SAME host-based logic PostHog uses
 *     (readEnvironment() from ./analytics): development stays completely
 *     untracked; staging and production are tagged so they are cleanly
 *     separable in one shared Sentry project.
 *
 * What it captures once enabled: unhandled errors and promise
 * rejections (Sentry's default global handlers), plus errors caught by
 * the app's React ErrorBoundary, which forwards them here via
 * captureError().
 */
import { readEnvironment } from './analytics'

// Live Sentry client namespace, or null while uninitialized / disabled.
// Typed loosely to avoid a hard type dependency on @sentry/react (which
// may not be installed in every consumer of this module at type-check
// time — the runtime import is dynamic and DSN-gated).
type SentryModule = {
  init: (options: Record<string, unknown>) => void
  captureException: (error: unknown) => void
}

let client: SentryModule | null = null
// Guards against double-init (e.g. React StrictMode double-invoke).
let initStarted = false

function readDsn(): string | undefined {
  const dsn = import.meta.env.VITE_SENTRY_DSN
  return typeof dsn === 'string' && dsn.trim() !== '' ? dsn.trim() : undefined
}

/**
 * Initialize Sentry once at app bootstrap. No-op (and never touches the
 * network) when VITE_SENTRY_DSN is unset. Development is never tracked —
 * only staging and production initialize, matching the analytics gate.
 * Safe to call more than once — subsequent calls are ignored.
 */
export async function initSentry(): Promise<void> {
  if (initStarted) return
  const dsn = readDsn()
  // No DSN → error tracking stays completely dark. Do not import @sentry/react.
  if (!dsn) return
  // Development (localhost / preview / unknown hosts) is never tracked.
  const environment = readEnvironment()
  if (environment === 'development') return
  initStarted = true

  try {
    const Sentry = (await import('@sentry/react')) as unknown as SentryModule
    Sentry.init({
      dsn,
      environment,
      // Conservative defaults: capture errors, no performance tracing or
      // session replay unless explicitly turned on later. Keeps the bundle
      // and network footprint minimal for a pure error-tracking rollout.
      tracesSampleRate: 0,
    })
    client = Sentry
  } catch {
    // @sentry/react not installed or failed to load — stay dark.
    initStarted = false
  }
}

/**
 * Report an error to Sentry. Called by the ErrorBoundary for errors it
 * catches, and available for manual capture. No-op when Sentry is
 * disabled (DSN unset, development, or not yet initialized).
 */
export function captureError(error: unknown): void {
  if (!client || !error) return
  client.captureException(error)
}

/**
 * Whether Sentry is initialized and actively reporting. Lets callers
 * (e.g. the ErrorBoundary) avoid work when tracking is dark.
 */
export function isSentryEnabled(): boolean {
  return client !== null
}
