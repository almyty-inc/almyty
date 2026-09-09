import { useQuery } from '@tanstack/react-query'

import { Label } from '@/components/ui/label'
import { connectionsApi } from '@/lib/connections-api'
import { cn } from '@/lib/utils'
import type { Connection, ConnectorKind } from '@/types/connections'

export const CONNECTIONS_QUERY_KEY = ['connections'] as const

const SELECT_CLASS =
  'flex h-9 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-50'

/**
 * The connections a consumer form may pick from: those of `kind`, and when
 * any of them belong to `preferConnectorKey` only those. A form for an
 * OpenAI provider then lists OpenAI keys, not every inference key.
 */
export function filterConnections(connections: Connection[], kind?: ConnectorKind, preferConnectorKey?: string): Connection[] {
  const ofKind = kind ? connections.filter((c) => c.kind === kind || (!c.kind && c.connectorKey === preferConnectorKey)) : connections
  if (!preferConnectorKey) return ofKind
  const preferred = ofKind.filter((c) => c.connectorKey === preferConnectorKey)
  return preferred.length > 0 ? preferred : ofKind
}

export function connectionOptionLabel(connection: Connection): string {
  const connector = connection.connectorDisplayName ?? connection.connectorKey
  const account = connection.accountLabel ? `, ${connection.accountLabel}` : ''
  return `${connection.name} (${connector}${account})`
}

/** Fetches GET /connections once per page and filters for one consumer. */
export function useConnectionOptions(opts: { kind?: ConnectorKind; preferConnectorKey?: string; enabled?: boolean; connections?: Connection[] }) {
  const query = useQuery<Connection[]>({
    queryKey: CONNECTIONS_QUERY_KEY,
    queryFn: async () => {
      const list = await connectionsApi.list()
      return Array.isArray(list) ? list : []
    },
    enabled: opts.enabled !== false && !opts.connections,
  })
  const all = opts.connections ?? query.data ?? []
  return { connections: filterConnections(all, opts.kind, opts.preferConnectorKey), all, isLoading: query.isLoading && !opts.connections }
}

export interface ConnectionSelectProps {
  id: string
  label?: string
  kind?: ConnectorKind
  /** Connections of this connector come first; the rest of the kind when none match. */
  preferConnectorKey?: string
  /** The selected connection id; '' for none. */
  value: string
  onChange: (connection: Connection | null) => void
  /** Skip the fetch and list these instead (tests, callers that already hold the list). */
  connections?: Connection[]
  disabled?: boolean
  placeholder?: string
  helper?: string
  className?: string
}

/**
 * "Use an existing connection": a select over the org's connections of one
 * kind. Every consumer form embeds it next to its ConnectAccountButton and
 * its paste-a-key field, so a secret is pasted once and referenced after.
 */
export function ConnectionSelect({ id, label = 'Use an existing connection', kind, preferConnectorKey, value, onChange, connections, disabled, placeholder, helper, className }: ConnectionSelectProps) {
  const options = useConnectionOptions({ kind, preferConnectorKey, connections })
  const empty = !options.isLoading && options.connections.length === 0
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        className={SELECT_CLASS}
        value={value}
        disabled={disabled || empty}
        onChange={(e) => {
          const next = options.connections.find((c) => c.id === e.target.value) ?? null
          onChange(next)
        }}
      >
        <option value="">{empty ? 'No connections yet' : placeholder ?? 'Pick a connection'}</option>
        {options.connections.map((c) => (
          <option key={c.id} value={c.id}>
            {connectionOptionLabel(c)}
          </option>
        ))}
      </select>
      {helper && <p className="text-xs text-muted-foreground">{helper}</p>}
    </div>
  )
}
