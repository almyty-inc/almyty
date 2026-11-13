/**
 * Shared mappings + poll constants for the runner / workspace pages.
 *
 * Badge variants reuse the existing semantic vocabulary (success /
 * warning / destructive / outline / secondary). Don't add new variant
 * names here; if a state needs different colour, repaint the badge
 * variant globally in `components/ui/badge.tsx`.
 */
import type { BadgeProps } from '@/components/ui/badge'

type BadgeVariant = NonNullable<BadgeProps['variant']>

export const runnerStateVariant: Record<string, BadgeVariant> = {
  registered: 'secondary',
  online: 'success',
  busy: 'secondary',
  stale: 'warning',
  draining: 'warning',
  offline: 'destructive',
}

export const workspaceStatusVariant: Record<string, BadgeVariant> = {
  active: 'success',
  released: 'secondary',
  expired: 'outline',
  stranded: 'destructive',
}

/**
 * Polling cadence: ~half the runner heartbeat interval (30s server
 * side) so transitions show up within roughly one heartbeat without
 * hammering the API. Other list pages in this app use 30-60s; the
 * runner state machine is twitchier so we lean shorter.
 */
export const RUNNER_HEARTBEAT_POLL_MS = 15_000

/**
 * A runner record the setup page created whose daemon has never
 * connected. It can still be renamed, and deleting it is how an
 * abandoned setup is cleaned up.
 */
export function isPendingRunner(r: { runtimeInfo?: unknown; lastHeartbeatAt?: string | null }): boolean {
  return !r.runtimeInfo && !r.lastHeartbeatAt
}

/** What the state badge says; a pending runner reads "never connected", not "registered". */
export function runnerStateLabel(r: { state: string; runtimeInfo?: unknown; lastHeartbeatAt?: string | null }): string {
  return isPendingRunner(r) ? 'never connected' : r.state
}

/** Install the unified CLI once; login is shared by all its commands. */
export const RUNNER_INSTALL_COMMAND = 'npm i -g @almyty/cli'

/** Where the CLI talks to when given no flags. */
export const CLI_DEFAULT_API = 'https://api.almyty.com'
export const CLI_DEFAULT_APP = 'https://app.almyty.com'

export interface CliTarget {
  /** The API this web app talks to. */
  api: string
  /** The origin this web app is served from (hosts /cli-login). */
  app: string
}

const trimSlash = (url: string) => url.replace(/\/+$/, '')

/**
 * The almyty install this page is served from. The CLI defaults to
 * production, so commands copied from staging, a dev stack or a
 * self-hosted install have to name it, or `almyty login` signs in to
 * production instead.
 */
export function currentCliTarget(): CliTarget {
  const app = trimSlash(typeof window !== 'undefined' ? window.location.origin : CLI_DEFAULT_APP)
  const base = trimSlash(import.meta.env.ALMYTY_API_BASE_URL || '')
  return { api: /^https?:\/\//.test(base) ? base : `${app}${base ? `/${base.replace(/^\/+/, '')}` : ''}`, app }
}

/** Login chooses the organization and saves the API every later command uses. */
export function runnerLoginCommand(target: CliTarget = currentCliTarget()): string {
  const flags: string[] = []
  if (target.api !== CLI_DEFAULT_API) flags.push(`--api ${target.api}`)
  if (target.app !== CLI_DEFAULT_APP) flags.push(`--frontend ${target.app}`)
  return ['almyty login', ...flags].join(' ')
}

/**
 * The daemon names itself after the machine. It reads the API from the
 * login; `--url` repeats it off production so a runner cannot register
 * against production on the strength of an older production login.
 */
export function runnerStartCommand(target: CliTarget = currentCliTarget()): string {
  return target.api === CLI_DEFAULT_API ? 'almyty runner start' : `almyty runner start --url ${target.api}`
}