/**
 * Settings > Connections: the gallery of connectors grouped by kind, each
 * with its best connect method and the connections that already exist
 * underneath; the custom-connector dialog; the org toggle for user-scoped
 * connections; the connect sheet and the connection detail sheet.
 */
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Plug, Plus, Search, User, Users } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { QueryError } from '@/components/ui/query-error'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { organizationsApi } from '@/lib/api'
import {
  allowUserScopedConnections,
  bestConnectMethod,
  connectionSettingsApi,
  connectionsApi,
  connectorsApi,
  errorMessage,
  groupConnectorsByKind,
  isCustomConnector,
  matchesConnectorSearch,
} from '@/lib/connections-api'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import {
  CONNECTOR_KINDS,
  CONNECTOR_KIND_LABELS,
  CONNECT_METHOD_LABELS,
  type Connection,
  type Connector,
} from '@/types/connections'
import { ConnectSheet, CONNECTORS_QUERY_KEY } from './connect-sheet'
import { ConnectionDetailSheet, CONNECTIONS_QUERY_KEY } from './connection-detail-sheet'
import { CustomConnectorDialog } from './custom-connector-dialog'
import { ConnectionHealthBadge } from './health-badge'
import { ConnectionsGovernanceSection } from '@/components/connections-governance/governance-section'

interface SheetState {
  open: boolean
  connectorKey?: string
  rotate?: Connection | null
}

export function ConnectionsTab() {
  const queryClient = useQueryClient()
  const notifications = useNotifications()
  const { currentOrganization } = useOrganizationStore()
  const orgId = currentOrganization?.id

  const [search, setSearch] = useState('')
  const [sheet, setSheet] = useState<SheetState>({ open: false })
  const [customOpen, setCustomOpen] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)

  const connectorsQuery = useQuery({
    queryKey: CONNECTORS_QUERY_KEY,
    queryFn: async () => {
      const rows = await connectorsApi.list()
      return Array.isArray(rows) ? rows : []
    },
  })
  const connectionsQuery = useQuery({
    queryKey: CONNECTIONS_QUERY_KEY,
    queryFn: async () => {
      const rows = await connectionsApi.list()
      return Array.isArray(rows) ? rows : []
    },
  })
  const orgQuery = useQuery({
    queryKey: ['organization-details', orgId],
    queryFn: () => organizationsApi.getById(orgId!),
    enabled: !!orgId,
  })

  const allowUserScoped = allowUserScopedConnections(orgQuery.data)

  const toggleUserScoped = useMutation({
    mutationFn: (allow: boolean) => connectionSettingsApi.setAllowUserScopedConnections(orgId!, allow),
    onSuccess: (_result, allow) => {
      queryClient.invalidateQueries({ queryKey: ['organization-details', orgId] })
      notifications.success(allow ? 'Personal connections allowed' : 'Personal connections off', allow ? 'Members can connect their own accounts.' : 'Only organization connections can be used.')
    },
    onError: (error: unknown) => notifications.error('Could not save', errorMessage(error, 'The setting was not changed')),
  })

  const connectors = connectorsQuery.data ?? []
  const connections = connectionsQuery.data ?? []

  const connectionsByConnector = useMemo(() => {
    const out = new Map<string, Connection[]>()
    for (const c of connections) {
      const list = out.get(c.connectorKey) ?? []
      list.push(c)
      out.set(c.connectorKey, list)
    }
    return out
  }, [connections])

  // Connections whose connector is no longer listed still need a home.
  const allConnectors = useMemo(() => {
    const known = new Set(connectors.map((c) => c.key))
    const orphans: Connector[] = []
    for (const [key, list] of connectionsByConnector) {
      if (!known.has(key)) orphans.push({ key, kind: list[0].kind ?? 'tool_source', displayName: list[0].connectorDisplayName ?? key, connect: [] })
    }
    return [...connectors, ...orphans]
  }, [connectors, connectionsByConnector])

  const visible = useMemo(
    () =>
      allConnectors.filter((c) => {
        if (matchesConnectorSearch(c, search)) return true
        const q = search.trim().toLowerCase()
        return (connectionsByConnector.get(c.key) ?? []).some((conn) => conn.name.toLowerCase().includes(q) || (conn.accountLabel ?? '').toLowerCase().includes(q))
      }),
    [allConnectors, connectionsByConnector, search],
  )
  const groups = useMemo(() => groupConnectorsByKind(visible, CONNECTOR_KINDS), [visible])

  const detail = detailId ? connections.find((c) => c.id === detailId) ?? null : null
  const detailConnector = detail ? allConnectors.find((c) => c.key === detail.connectorKey) ?? null : null

  const onConnected = (connection: Connection) => {
    queryClient.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY })
    notifications.success(sheet.rotate ? 'Secret rotated' : 'Connected', `${connection.name} is ${connection.health?.status === 'valid' ? 'valid and ' : ''}ready to use.`)
  }

  const loading = connectorsQuery.isLoading || connectionsQuery.isLoading

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search connectors and connections" className="pl-9" aria-label="Search connections" />
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => setCustomOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />
            Add custom connector
          </Button>
          <Button type="button" onClick={() => setSheet({ open: true })}>
            <Plug className="mr-1.5 h-4 w-4" aria-hidden="true" />
            Connect
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Personal connections</CardTitle>
          <CardDescription>
            Let members connect accounts only they can use, next to the organization's shared ones. Default on for personal orgs, off for production orgs where every credential should be shared and governed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <Switch id="allow-user-scoped" checked={allowUserScoped} onCheckedChange={(v) => toggleUserScoped.mutate(v)} disabled={!orgId || toggleUserScoped.isPending || orgQuery.isLoading} aria-label="Allow user-scoped connections" />
            <Label htmlFor="allow-user-scoped" className="font-normal">{allowUserScoped ? 'Members may connect their own accounts' : 'Only organization connections'}</Label>
          </div>
        </CardContent>
      </Card>

      {connectorsQuery.isError && <QueryError error={connectorsQuery.error} onRetry={() => connectorsQuery.refetch()} title="Connectors could not be loaded" />}
      {connectionsQuery.isError && !connectorsQuery.isError && <QueryError error={connectionsQuery.error} onRetry={() => connectionsQuery.refetch()} title="Connections could not be loaded" />}

      {loading && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" aria-busy="true">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-36 rounded-xl" />
          ))}
        </div>
      )}

      {!loading && !connectorsQuery.isError && groups.length === 0 && (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={Plug}
              title={search ? 'No connector matches' : 'No connectors yet'}
              description={search ? 'Try another name or kind.' : 'The catalog is empty. Add a custom connector to get started.'}
              action={!search ? <Button type="button" variant="outline" onClick={() => setCustomOpen(true)}>Add custom connector</Button> : undefined}
            />
          </CardContent>
        </Card>
      )}

      {groups.map((group) => (
        <section key={group.kind} className="space-y-3" aria-label={CONNECTOR_KIND_LABELS[group.kind]}>
          <div className="flex items-baseline gap-2">
            <h2 className="font-heading text-lg font-semibold">{CONNECTOR_KIND_LABELS[group.kind]}</h2>
            <span className="text-xs text-muted-foreground">
              {group.connectors.reduce((n, c) => n + (connectionsByConnector.get(c.key)?.length ?? 0), 0)} connected
            </span>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {group.connectors.map((connector) => (
              <ConnectorCard
                key={connector.key}
                connector={connector}
                connections={connectionsByConnector.get(connector.key) ?? []}
                onConnect={() => setSheet({ open: true, connectorKey: connector.key })}
                onOpenConnection={(c) => setDetailId(c.id)}
              />
            ))}
          </div>
        </section>
      ))}

      <ConnectionsGovernanceSection />

      <ConnectSheet
        open={sheet.open}
        onOpenChange={(open) => setSheet((prev) => ({ ...prev, open }))}
        connectorKey={sheet.connectorKey}
        rotateConnection={sheet.rotate ?? null}
        onConnected={onConnected}
      />

      <ConnectionDetailSheet
        connection={detail}
        connector={detailConnector}
        open={!!detail}
        onOpenChange={(open) => !open && setDetailId(null)}
        onRotate={(connection) => {
          setDetailId(null)
          setSheet({ open: true, connectorKey: connection.connectorKey, rotate: connection })
        }}
      />

      <CustomConnectorDialog open={customOpen} onOpenChange={setCustomOpen} onCreated={(key) => setSheet({ open: true, connectorKey: key })} />
    </div>
  )
}

interface ConnectorCardProps {
  connector: Connector
  connections: Connection[]
  onConnect: () => void
  onOpenConnection: (connection: Connection) => void
}

export function ConnectorCard({ connector, connections, onConnect, onOpenConnection }: ConnectorCardProps) {
  const best = bestConnectMethod(connector)
  return (
    <Card className="flex flex-col" data-testid={`connector-card-${connector.key}`}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <span className="truncate">{connector.displayName}</span>
              {isCustomConnector(connector) && <Badge variant="outline" className="text-[10px]">custom</Badge>}
            </CardTitle>
            {connector.description && <CardDescription className="line-clamp-2">{connector.description}</CardDescription>}
          </div>
          <Button type="button" size="sm" onClick={onConnect} disabled={connector.connect.length === 0} aria-label={`Connect ${connector.displayName}`} className="shrink-0">
            {best ? (best.label || CONNECT_METHOD_LABELS[best.type]) : 'Connect'}
          </Button>
        </div>
        {(connector.docsUrl || connector.keyPageUrl) && (
          <div className="flex gap-3 pt-1">
            {connector.keyPageUrl && (
              <a href={connector.keyPageUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                <ExternalLink className="h-3 w-3" aria-hidden="true" /> Get a key
              </a>
            )}
            {connector.docsUrl && (
              <a href={connector.docsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline">
                <ExternalLink className="h-3 w-3" aria-hidden="true" /> Docs
              </a>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent className="flex-1 pt-0">
        {connections.length === 0 ? (
          <p className="text-xs text-muted-foreground">Not connected</p>
        ) : (
          <ul className="divide-y rounded-md border" data-testid="connector-connections">
            {connections.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onOpenConnection(c)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                  aria-label={`Open ${c.name}`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{c.name}</span>
                      {c.owner === 'user' ? (
                        <Badge variant="outline" className="gap-1 text-[10px]"><User className="h-3 w-3" aria-hidden="true" /> personal</Badge>
                      ) : (
                        <Badge variant="outline" className="gap-1 text-[10px]"><Users className="h-3 w-3" aria-hidden="true" /> org</Badge>
                      )}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {c.accountLabel || 'No account label'}
                      {c.scopesGranted && c.scopesGranted.length > 0 ? ` | ${c.scopesGranted.length} scope${c.scopesGranted.length === 1 ? '' : 's'}` : ''}
                    </div>
                  </div>
                  <ConnectionHealthBadge health={c.health} className="shrink-0" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
