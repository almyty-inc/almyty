import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { Plug, Search } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { DataTable } from '@/components/ui/data-table'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { QueryError } from '@/components/ui/query-error'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PageHeader } from '@/components/layout/page-header'
import { PageIntro } from '@/components/onboarding/page-intro'
import { AvailabilityBadge, availability, effectivePrice, formatContext, formatPrice, isFree } from '@/components/models/model-row'
import { useHostedModels } from '@/components/models/use-model-data'
import { isHostedModelPlumbing } from '@/components/llm-providers/provider-catalog'
import { providerLogos } from '@/components/llm-providers/provider-type-config'
import { connectProviderPath, providerPath } from '@/components/llm-providers/paths'
import { llmProvidersQuery } from '@/lib/llm-providers-query'
import { deploymentForCard, readableModelName, unlistedDeployments } from '@/lib/model-hosting'
import { HostedStatusBadge } from '@/components/models/hosting/hosted-status-badge'
import { modelsApi } from '@/lib/models-api'
import { modelSearchScorer, rankBy } from '@/lib/model-search'
import type { ModelCard } from '@/types/models'
import { pluralized } from '@/lib/utils'

/** Shared with every other reader of the full model list (the model chooser too). */
export const MODELS_QUERY_KEY = ['models', 'catalog'] as const

/** Filter value for models almyty runs on your own cloud, which have no connection. */
const HOSTED = '__hosted__'

/** The status filter: what a person asks of a catalog. */
type StatusFilter = 'all' | 'available' | 'unavailable' | 'off' | 'new'
const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'Any status' },
  { value: 'available', label: 'Available' },
  { value: 'unavailable', label: 'Not available' },
  { value: 'off', label: 'Not allowed' },
  { value: 'new', label: 'New this week' },
]

interface Row {
  card: ModelCard
  provider: any | null
  connection: string
}

/**
 * Models: the catalog. Every model every provider connection reaches, with
 * its price and whether it can be used now, filterable by connection and
 * status. Connections themselves are managed on their own pages (each row
 * links to its connection); here there is nothing to set up.
 */
export function ModelsPage() {
  useEffect(() => {
    document.title = 'Models | almyty'
    return () => {
      document.title = 'almyty'
    }
  }, [])

  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  // Links from notices open the catalog filtered: ?connection=<id>&status=unavailable, ?show=new.
  const [connectionFilter, setConnectionFilter] = useState(searchParams.get('connection') ?? 'all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(() => {
    if (searchParams.get('show') === 'new') return 'new'
    const s = searchParams.get('status')
    return STATUS_FILTERS.some((f) => f.value === s) ? (s as StatusFilter) : 'all'
  })

  const providersQuery = useQuery(llmProvidersQuery)
  const cardsQuery = useQuery({
    queryKey: MODELS_QUERY_KEY,
    queryFn: async () => {
      const rows = await modelsApi.list()
      return Array.isArray(rows) ? rows : []
    },
  })
  const { deployments } = useHostedModels()
  const orphans = useMemo(() => unlistedDeployments(cardsQuery.data ?? [], deployments), [cardsQuery.data, deployments])

  const allProviders = useMemo(() => (Array.isArray(providersQuery.data) ? providersQuery.data : []), [providersQuery.data])
  // A hosted model's provider row is that model's plumbing, written by the
  // reconcile loop: the model shows as hosted on your cloud, and the row is
  // not a connection anyone made.
  const connections = useMemo(() => allProviders.filter((p: any) => !isHostedModelPlumbing(p)), [allProviders])
  const plumbing = useMemo(() => new Set(allProviders.filter(isHostedModelPlumbing).map((p: any) => p.id as string)), [allProviders])
  const byId = useMemo(() => Object.fromEntries(connections.map((p: any) => [p.id, p])), [connections])

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const card of cardsQuery.data ?? []) {
      if (card.providerId && byId[card.providerId]) out.push({ card, provider: byId[card.providerId], connection: byId[card.providerId].name })
      else if (!card.providerId || plumbing.has(card.providerId)) out.push({ card, provider: null, connection: 'Your cloud' })
    }
    return out
  }, [cardsQuery.data, byId, plumbing])

  const shown = useMemo(() => {
    const filtered = rows.filter(({ card }) => {
      if (connectionFilter === HOSTED ? card.providerId && !plumbing.has(card.providerId) : connectionFilter !== 'all' && card.providerId !== connectionFilter) return false
      const state = availability(card)
      if (statusFilter === 'available') return state.usable
      if (statusFilter === 'unavailable') return !state.usable && card.allowed !== false
      if (statusFilter === 'off') return card.allowed === false
      if (statusFilter === 'new') return !!card.isNew
      return true
    })
    // Usable first, then by name; a search ranks by how well each matches.
    const ordered = filtered.sort((a, b) => Number(b.card.selectable) - Number(a.card.selectable) || a.card.name.localeCompare(b.card.name))
    const score = modelSearchScorer(ordered, search, (r) => ({ id: r.card.vendorModelId, name: r.card.name, providerName: r.connection, providerType: r.provider?.type }))
    return rankBy(ordered, score)
  }, [rows, connectionFilter, statusFilter, search, plumbing])

  const columns: ColumnDef<Row>[] = useMemo(
    () => [
      {
        id: 'model',
        header: 'Model',
        cell: ({ row }) => {
          const { card } = row.original
          return (
            <div className="min-w-0" data-testid={`catalog-row-${card.id}`}>
              <div className="flex items-center gap-2">
                <span className="truncate font-medium">{card.name}</span>
                {card.isNew && (
                  <Badge variant="secondary" data-testid="model-new">
                    New
                  </Badge>
                )}
              </div>
              {card.vendorModelId !== card.name && <div className="truncate font-mono text-xs text-muted-foreground">{card.vendorModelId}</div>}
            </div>
          )
        },
      },
      {
        id: 'connection',
        header: 'Connection',
        cell: ({ row }) => {
          const { card, provider, connection } = row.original
          if (!provider) {
            const hosted = deploymentForCard(card, deployments)
            return hosted ? (
              <Link to={`/models/hosting/${hosted.id}`} className="text-sm hover:underline">
                {connection}
              </Link>
            ) : (
              <span className="text-sm text-muted-foreground">{connection}</span>
            )
          }
          return (
            <Link to={providerPath(provider.id)} className="inline-flex items-center gap-1.5 text-sm hover:underline" data-testid="catalog-connection">
              <span aria-hidden>{providerLogos[provider.type] || '⚙️'}</span>
              {connection}
            </Link>
          )
        },
      },
      {
        id: 'price',
        header: 'Price per 1M tokens',
        cell: ({ row }) => {
          const price = effectivePrice(row.original.card)
          return (
            <span className={price && !isFree(price) ? 'whitespace-nowrap text-xs tabular-nums' : 'whitespace-nowrap text-xs text-muted-foreground'} data-testid="model-price">
              {formatPrice(price)}
            </span>
          )
        },
      },
      {
        id: 'context',
        header: 'Context',
        cell: ({ row }) => <span className="text-xs tabular-nums" data-testid="model-context">{formatContext(row.original.card.contextLength)}</span>,
      },
      {
        id: 'status',
        header: 'Status',
        cell: ({ row }) => <AvailabilityBadge value={availability(row.original.card, row.original.provider)} />,
      },
    ],
    [deployments],
  )

  // Links from before this page was redesigned.

  const loading = providersQuery.isLoading || cardsQuery.isLoading
  const noConnections = !providersQuery.isLoading && !providersQuery.isError && connections.length === 0 && rows.length === 0

  const openRow = (row: Row) => {
    const { card } = row
    if (card.providerId && !plumbing.has(card.providerId)) {
      navigate(providerPath(card.providerId, card.id))
      return
    }
    const hosted = deploymentForCard(card, deployments)
    if (hosted) navigate(`/models/hosting/${hosted.id}`)
  }

  const usable = rows.filter((r) => r.card.selectable).length
  const connectButton = (
    <Button asChild className="gap-2">
      <Link to={connectProviderPath()}>
        <Plug className="h-4 w-4" aria-hidden />
        Connect a provider
      </Link>
    </Button>
  )

  return (
    <div className="space-y-6">
      <PageHeader
        title="Models"
        description={
          loading
            ? 'Every model your provider connections reach.'
            : `${pluralized(rows.length, 'model')} from ${pluralized(connections.length, 'connection')} · ${usable} available`
        }
        actions={connectButton}
      />
      <PageIntro topic="models" />

      {providersQuery.isError ? (
        <QueryError error={providersQuery.error} onRetry={() => providersQuery.refetch()} title="Couldn't load your connections" />
      ) : cardsQuery.isError ? (
        <QueryError error={cardsQuery.error} onRetry={() => cardsQuery.refetch()} title="Couldn't load your models" />
      ) : noConnections ? (
        <EmptyState
          variant="panel"
          icon={Plug}
          title="No models yet"
          description="Connect a provider with its key, or point almyty at a server you run. Every model it reaches shows up here, with its price."
          action={connectButton}
        />
      ) : (
        <>
          {orphans.length > 0 && (
            <Card data-testid="hosted-starting">
              <CardContent className="p-0">
                <h2 className="border-b px-3 py-2 text-sm font-medium">Starting on your cloud</h2>
                <ul>
                  {orphans.map((d) => (
                    <li key={d.id} className="border-b last:border-b-0">
                      <Link to={`/models/hosting/${d.id}`} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm hover:bg-muted/40">
                        <span className="truncate font-medium">{readableModelName(d.modelRef)}</span>
                        <HostedStatusBadge deployment={d} />
                      </Link>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
          <DataTable
            columns={columns}
            data={shown}
            loading={loading}
            onRowClick={openRow}
            hideColumnsButton
            hideSelectionCount
            initialPageSize={25}
            headerExtra={
              <div className="flex flex-1 flex-wrap items-center gap-2">
                <div className="relative w-full max-w-xs">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                  <Input className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search models" aria-label="Search models" />
                </div>
                <Select value={connectionFilter} onValueChange={setConnectionFilter}>
                  <SelectTrigger className="w-56" aria-label="Filter by connection">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All connections</SelectItem>
                    {connections.map((p: any) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                    {rows.some((r) => !r.provider) && <SelectItem value={HOSTED}>Your cloud</SelectItem>}
                  </SelectContent>
                </Select>
                <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
                  <SelectTrigger className="w-44" aria-label="Filter by status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUS_FILTERS.map((f) => (
                      <SelectItem key={f.value} value={f.value}>
                        {f.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            }
            emptyState={<EmptyState variant="inline" title="No models yet" description="Your connections list no models yet. Open a connection and check it again." />}
          />
        </>
      )}
    </div>
  )
}
