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

/**
 * The one install path the docs, the README and this page all show:
 * install both CLIs globally once, then call the installed binaries.
 * A runner is a long-lived daemon you restart, stop and query
 * (`almyty-runner status` / `stop`), so it should be a pinned install
 * on the machine rather than whatever `npx` resolves on each start.
 */
export const RUNNER_INSTALL_COMMAND = 'npm i -g @almyty/runner @almyty/auth'
export const RUNNER_LOGIN_COMMAND = 'almyty-auth login'

/**
 * Quote a value for safe shell paste. Conservative: any character
 * outside the allowlist triggers single-quoting.
 */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./=:-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * The start command. Labels and visibility live on the server record the
 * setup page created, so the command carries only the name and the
 * organization (the logged-in user may belong to several).
 */
export function runnerStartCommand(name: string, organizationId?: string | null): string {
  const parts = ['almyty-runner', 'start', '--name', shellQuote(name || '<name>')]
  if (organizationId) parts.push('--org', shellQuote(organizationId))
  return parts.join(' ')
}
