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
