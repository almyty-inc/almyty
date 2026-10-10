import type { ServiceCheck } from '@/components/connect/status-label'
import { WHO_CAN_USE_LABELS } from '@/components/connect/who-can-use'
import type { Visibility } from '@/components/ui/visibility-field'
import type { Connection, Connector } from '@/types/connections'

/**
 * Whether the server can ask the service if a credential works. A
 * `format` check only looks at the key's shape ("Other service", a
 * webhook URL), so it proves nothing: such a credential is never called
 * "Works" and offers no "Check again". Every other validation kind asks
 * the service, whatever it is, so a new kind needs nothing here.
 */
export function connectorCanCheck(connector: Pick<Connector, 'validation'> | null | undefined): boolean {
  return !!connector?.validation && connector.validation.kind !== 'format'
}

/** A credential nobody can check from here: a key that is only stored. */
export const NOT_CHECKED: ServiceCheck = { state: 'unchecked', label: 'Not checked' }

/**
 * A credential's health in the words the Credentials page uses: it works,
 * it needs attention, or nobody checked yet. A service nobody can ask (the
 * check is shape only) is "Not checked", never "Works".
 */
export function connectionCheck(connection: Pick<Connection, 'health'> | null | undefined, connector?: Pick<Connector, 'validation'> | null): ServiceCheck {
  const health = connection?.health
  const status = health?.status ?? 'unknown'
  const shapeOnly = connector?.validation?.kind === 'format'
  if (status === 'valid') return shapeOnly ? NOT_CHECKED : { state: 'ok', label: 'Works' }
  if (status === 'unknown') return shapeOnly ? NOT_CHECKED : { state: 'unchecked', label: 'Not checked yet' }
  const error =
    health?.error ||
    (status === 'quota' ? 'The account is out of credit or over its limit.' : status === 'expired' ? 'The key has expired.' : status === 'revoked' ? 'The key was revoked.' : undefined)
  return { state: 'failed', label: 'Needs attention', error }
}

/** Who can use it, as the shared "Who can use it" line reads it. */
export function connectionWho(connection: Pick<Connection, 'owner'>): Visibility {
  if (connection.owner === 'org') return 'org'
  if (connection.owner === 'team') return 'team'
  return 'private'
}

/** The same, short, for a card. */
export function connectionWhoShort(connection: Pick<Connection, 'owner'>): string {
  return WHO_CAN_USE_LABELS[connectionWho(connection)]
}