import type { ServiceCheck } from '@/components/connect/status-label'
import type { Visibility } from '@/components/ui/visibility-field'
import type { Connection, Connector } from '@/types/connections'

/**
 * A connection's health in the words the Connections page uses: it works,
 * it needs attention, or nobody checked yet. A service nobody can ask (the
 * check is shape only, like "Other service") is "Saved", never "Works".
 */
export function connectionCheck(connection: Pick<Connection, 'health'> | null | undefined, connector?: Pick<Connector, 'validation'> | null): ServiceCheck {
  const health = connection?.health
  const status = health?.status ?? 'unknown'
  if (status === 'valid') return { state: 'ok', label: connector?.validation?.kind === 'format' ? 'Saved' : 'Works' }
  if (status === 'unknown') return { state: 'unchecked', label: 'Not checked yet' }
  const error =
    health?.error ||
    (status === 'quota' ? 'The account is out of credit or over its limit.' : status === 'expired' ? 'The key has expired.' : status === 'revoked' ? 'The key was revoked.' : undefined)
  return { state: 'failed', label: 'Needs attention', error }
}

/** Who can use it, as the shared "Who can use it" line reads it. */
export function connectionWho(connection: Pick<Connection, 'owner'>): Visibility {
  return connection.owner === 'org' ? 'org' : 'private'
}

/** The same, short, for a card. */
export function connectionWhoShort(connection: Pick<Connection, 'owner'>): string {
  return connection.owner === 'org' ? 'Everyone' : 'Only you'
}
