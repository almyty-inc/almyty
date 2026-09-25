import { useEffect, useMemo } from 'react'
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { Plug } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { QueryError } from '@/components/ui/query-error'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PageHeader } from '@/components/layout/page-header'
import { PageIntro } from '@/components/onboarding/page-intro'
import { ConnectedCard, ConnectedCardGrid } from '@/components/connect/connected-card'
import { StatusLabel } from '@/components/connect/status-label'
import { connectorIcon, useConnectors } from '@/components/connections/connect-flow'
import { useConnections } from '@/components/connections/connection-detail'
import { connectionCheck, connectionWhoShort } from '@/components/connections/connection-status'
import { ConnectionsAdvanced } from '@/components/connections/connections-advanced'
import { CONNECTIONS_ADVANCED_PATH, CONNECTIONS_PATH, connectServicePath, connectionPath } from '@/components/connections/paths'
import { useNewParamRedirect } from '@/hooks/use-new-param-redirect'
import { useOrganizationRole } from '@/hooks/use-organization-role'

/**
 * Connections: every service almyty holds a key or an account for, and
 * "Connect a service". One concept, a connected service; the fine print
 * (who exactly may use each one, rules, custom services) is the admins'
 * Advanced tab.
 */
export function ConnectionsPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { canManage } = useOrganizationRole()
  const advanced = location.pathname.startsWith(CONNECTIONS_ADVANCED_PATH)

  // Old `?new=1` links land on the connect page.
  useNewParamRedirect(connectServicePath())

  useEffect(() => {
    document.title = 'Connections | almyty'
    return () => {
      document.title = 'almyty'
    }
  }, [])

  // A sign-in at a service comes back as /connections?connection=<id>&status=...
  const returned = searchParams.get('connection')
  if (returned && !advanced) return <Navigate to={connectionPath(returned)} replace />

  return (
    <div className="space-y-6">
      <PageHeader
        title="Connections"
        description="The keys and accounts almyty uses for you. Connect a service once and use it anywhere."
        actions={
          <Button asChild className="gap-2">
            <Link to={connectServicePath()}>
              <Plug className="h-4 w-4" aria-hidden />
              Connect a service
            </Link>
          </Button>
        }
      />
      <PageIntro topic="credentials" />
      {canManage && (
        <Tabs value={advanced ? 'advanced' : 'connected'} onValueChange={(t) => navigate(t === 'advanced' ? CONNECTIONS_ADVANCED_PATH : CONNECTIONS_PATH)}>
          <TabsList>
            <TabsTrigger value="connected">Connected</TabsTrigger>
            <TabsTrigger value="advanced">Advanced</TabsTrigger>
          </TabsList>
        </Tabs>
      )}
      {advanced ? canManage ? <ConnectionsAdvanced /> : <Navigate to={CONNECTIONS_PATH} replace /> : <ConnectedList />}
    </div>
  )
}

function ConnectedList() {
  const connectionsQuery = useConnections()
  const connectorsQuery = useConnectors()
  const byKey = useMemo(() => new Map((connectorsQuery.data ?? []).map((c) => [c.key, c])), [connectorsQuery.data])
  const connections = connectionsQuery.data ?? []

  if (connectionsQuery.isError) return <QueryError error={connectionsQuery.error} onRetry={() => connectionsQuery.refetch()} title="Couldn't load your connections" />
  if (!connectionsQuery.isLoading && connections.length === 0) {
    return (
      <EmptyState
        variant="panel"
        icon={Plug}
        title="Nothing connected yet"
        description="Connect a service once, with its key or by signing in, and use it in any API, tool, agent or chat."
        action={
          <Button asChild>
            <Link to={connectServicePath()}>Connect a service</Link>
          </Button>
        }
      />
    )
  }
  return (
    <ConnectedCardGrid loading={connectionsQuery.isLoading} label="Connected services">
      {connections.map((c) => {
        const connector = byKey.get(c.connectorKey) ?? null
        return (
          <ConnectedCard key={c.id} to={connectionPath(c.id)} testId={`connection-card-${c.id}`} icon={connectorIcon(connector ?? { key: c.connectorKey, kind: c.kind ?? 'tool_source' })} name={c.name}>
            <StatusLabel check={connectionCheck(c, connector)} testId="connection-status" />
            {c.accountLabel && <span className="truncate">{c.accountLabel}</span>}
            <span data-testid="connection-who">{connectionWhoShort(c)}</span>
          </ConnectedCard>
        )
      })}
    </ConnectedCardGrid>
  )
}
