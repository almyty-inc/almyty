import { useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Brain, CheckCircle2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { PickedService, ServiceTileGrid, type ServiceTileGroup } from '@/components/connect/service-tiles'
import { StatusLabel } from '@/components/connect/status-label'
import { isProviderType } from '@/components/llm-providers/provider-catalog'
import { ConnectServiceForm, OTHER_SERVICE_KEY, connectorIcon, connectorTileGroups, useConnectors } from '@/components/connections/connect-flow'
import { connectionCheck } from '@/components/connections/connection-status'
import { CONNECTIONS_PATH, CONNECTIONS_QUERY_KEY, connectionPath } from '@/components/connections/paths'
import { matchesConnectorSearch } from '@/lib/connections-api'
import { safeReturnTo } from '@/lib/return-to'
import type { Connection, Connector, ConnectorKind } from '@/types/connections'

/** AI providers and model hosting have one home: Models. */
const MODELS_KINDS: ConnectorKind[] = ['inference', 'deployment']
const MODELS_CONNECT_PATH = '/models/connect'
/** The one tile that stands in for every AI provider. */
const AI_MODELS_TILE = 'ai-models'

/**
 * Every service but AI models, which are connected on Models where their
 * models come with them: here they are one tile that leads there. It stays
 * visible while a search matches an AI provider, so "openai" still finds it.
 */
function serviceTileGroups(connectors: Connector[], search: string): ServiceTileGroup[] {
  const services = connectorTileGroups(connectors.filter((c) => !MODELS_KINDS.includes(c.kind)), search)
  const query = search.trim().toLowerCase()
  const showModels = !query || 'ai models'.includes(query) || connectors.some((c) => MODELS_KINDS.includes(c.kind) && matchesConnectorSearch(c, search))
  if (!showModels) return services
  const models: ServiceTileGroup = {
    id: AI_MODELS_TILE,
    title: 'AI models',
    tiles: [{ key: AI_MODELS_TILE, label: 'Connect on Models', hint: 'OpenAI, Anthropic and more', icon: <Brain className="h-4 w-4 text-primary" /> }],
  }
  return [models, ...services]
}

/**
 * Connect a service: pick its tile, give it its key or sign in, done. The
 * picked tile lives in the URL (?service=github) so a link can open
 * straight onto it. An AI model provider is connected on Models, where its
 * models come with it.
 */
export function ConnectServicePage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [connected, setConnected] = useState<Connection | null>(null)
  const connectorsQuery = useConnectors()
  const connectors = useMemo(() => connectorsQuery.data ?? [], [connectorsQuery.data])

  const picked = searchParams.get('service')
  const connector = picked ? connectors.find((c) => c.key === picked) ?? null : null
  const returnTo = safeReturnTo(searchParams.get('returnTo'))

  useEffect(() => {
    document.title = 'Connect a service | almyty'
    return () => {
      document.title = 'almyty'
    }
  }, [])

  const pick = (next: string | null) => {
    if (next === AI_MODELS_TILE) {
      navigate(MODELS_CONNECT_PATH)
      return
    }
    setConnected(null)
    const params = new URLSearchParams(searchParams)
    if (next) params.set('service', next)
    else params.delete('service')
    setSearchParams(params)
  }

  const groups = serviceTileGroups(connectors, search)
  const modelsRoute = connector ? providerRoute(connector) : null
  if (modelsRoute) return <Navigate to={modelsRoute} replace />

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Link to={CONNECTIONS_PATH} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Connections
      </Link>
      <PageHeader title="Connect a service" description="Connect a service once and use it anywhere in almyty." />

      {connectorsQuery.isError && <p role="alert" className="text-sm text-destructive">The list of services could not be loaded. Reload the page to try again.</p>}

      {connector ? (
        <PickedService icon={connectorIcon(connector)} title={connector.displayName} onChooseAnother={connected ? undefined : () => pick(null)} chooseAnotherLabel="Choose another service">
          {connected ? (
            <Connected
              connection={connected}
              connector={connector}
              onDone={() => navigate(returnTo ?? CONNECTIONS_PATH)}
              onOpen={() => navigate(connectionPath(connected.id))}
            />
          ) : (
            <ConnectServiceForm
              key={connector.key}
              connector={connector}
              onConnected={(connection) => {
                queryClient.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY })
                setConnected(connection)
              }}
            />
          )}
        </PickedService>
      ) : (
        !connectorsQuery.isLoading && (
          <ServiceTileGrid
            groups={groups}
            search={search}
            onSearch={setSearch}
            onPick={pick}
            searchLabel="Search services"
            testIdPrefix="service-tile"
            notice={
              search.trim() && groups.every((g) => g.id === OTHER_SERVICE_KEY) ? (
                <p className="text-sm text-muted-foreground">
                  No service matches &ldquo;{search}&rdquo;.{' '}
                  <button type="button" className="text-primary hover:underline" onClick={() => pick(OTHER_SERVICE_KEY)}>
                    Save its key as another service
                  </button>
                  .
                </p>
              ) : null
            }
          />
        )
      )}
      {picked && !connector && !connectorsQuery.isLoading && !connectorsQuery.isError && (
        <p role="alert" className="text-sm text-destructive">
          This service is not available.
        </p>
      )}
    </div>
  )
}

/** AI providers and model hosting are connected on Models, where their models come with them. */
function providerRoute(connector: Connector): string | null {
  if (connector.kind === 'deployment') return '/models'
  if (connector.kind !== 'inference') return null
  const type = connector.providerType ?? connector.key
  return isProviderType(type) ? `${MODELS_CONNECT_PATH}?type=${encodeURIComponent(type)}` : MODELS_CONNECT_PATH
}

function Connected({ connection, connector, onDone, onOpen }: { connection: Connection; connector: Connector; onDone: () => void; onOpen: () => void }) {
  const check = connectionCheck(connection, connector)
  return (
    <div className="space-y-4" data-testid="connect-success">
      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
        <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />
        {connection.name} is connected.
        <StatusLabel check={check} testId="connection-status" />
      </p>
      {connection.accountLabel && <p className="text-sm text-muted-foreground">Account: {connection.accountLabel}</p>}
      <p className="text-sm text-muted-foreground">Pick it in any API, tool, agent or chat that asks for a key.</p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={onDone}>Done</Button>
        <Button variant="outline" onClick={onOpen}>
          Open connection
        </Button>
      </div>
    </div>
  )
}
