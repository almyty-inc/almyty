import { useQuery } from '@tanstack/react-query'

import { connectionsApi } from '@/lib/connections-api'
import type { Connection, ConnectorKind } from '@/types/connections'

export const CONNECTIONS_QUERY_KEY = ['connections'] as const

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
