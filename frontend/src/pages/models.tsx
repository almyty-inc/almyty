import { useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Plug, Search } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { QueryError } from '@/components/ui/query-error'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PageHeader } from '@/components/layout/page-header'
import { PageIntro } from '@/components/onboarding/page-intro'
import { ModelRow } from '@/components/models/model-row'
import { ConnectedCard, ConnectedCardGrid } from '@/components/connect/connected-card'
import { useHostedModels } from '@/components/models/use-model-data'
import { ProviderStatus, providerCheck } from '@/components/llm-providers/provider-status'
import { isHostedModelPlumbing, providerTileLabel } from '@/components/llm-providers/provider-catalog'
import { providerLogos } from '@/components/llm-providers/provider-type-config'
import { llmProvidersQuery } from '@/lib/llm-providers-query'
import { deploymentForCard, readableModelName, unlistedDeployments } from '@/lib/model-hosting'
import { HostedStatusBadge } from '@/components/models/hosting/hosted-status-badge'
import { modelsApi } from '@/lib/models-api'
import type { ModelCard } from '@/types/models'

/** Shared with every other reader of the full model list (the model chooser too). */
export const MODELS_QUERY_KEY = ['models', 'catalog'] as const

/** Group key for models almyty runs on your own cloud, which have no provider. */
const HOSTED = '__hosted__'

/** Tiles shown on an empty page, so the first click is already a provider. */
const QUICK_START = ['openai', 'anthropic', 'google', 'ollama'] as const

/**
 * Models: the providers you connected, and every model they offer.
 *
 * There is one concept here: a connected provider. Connect one and its
 * models appear below and in every model chooser; there is nothing to add
 * model by model. Each provider opens on its own page.
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
  const [providerFilter, setProviderFilter] = useState('all')

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
  // reconcile loop: its model is listed under "Hosted on your cloud", and
  // the row is not a provider anyone connected.
  const providers = useMemo(() => allProviders.filter((p: any) => !isHostedModelPlumbing(p)), [allProviders])
  const plumbing = useMemo(() => new Set(allProviders.filter(isHostedModelPlumbing).map((p: any) => p.id as string)), [allProviders])
  const cards = useMemo(() => cardsQuery.data ?? [], [cardsQuery.data])
  const byId = useMemo(() => Object.fromEntries(providers.map((p: any) => [p.id, p])), [providers])

  const cardsByProvider = useMemo(() => {
    const out: Record<string, ModelCard[]> = {}
    for (const c of cards) {
      const key = c.providerId && byId[c.providerId] ? c.providerId : !c.providerId || plumbing.has(c.providerId) ? HOSTED : null
      if (!key) continue
      ;(out[key] ||= []).push(c)
    }
    return out
  }, [cards, byId, plumbing])

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase()
    const keys = [...providers.map((p: any) => p.id as string), HOSTED]
    return keys
      .filter((key) => providerFilter === 'all' || providerFilter === key)
      .map((key) => {
        const name = key === HOSTED ? 'Hosted on your cloud' : byId[key]?.name ?? ''
        const rows = (cardsByProvider[key] ?? [])
          .filter((c) => !q || c.name.toLowerCase().includes(q) || c.vendorModelId.toLowerCase().includes(q) || name.toLowerCase().includes(q))
          .sort((a, b) => Number(b.selectable) - Number(a.selectable) || a.name.localeCompare(b.name))
        return { key, name, rows }
      })
      .filter((g) => g.rows.length > 0)
  }, [providers, byId, cardsByProvider, search, providerFilter])

  // Links from before this page was redesigned.
  const legacyTab = searchParams.get('tab')
  if (legacyTab === 'providers' || searchParams.get('new') === '1') return <Navigate to="/models/connect" replace />
  if (legacyTab) return <Navigate to="/models" replace />

  const loading = providersQuery.isLoading || cardsQuery.isLoading
  const noProviders = !providersQuery.isLoading && !providersQuery.isError && providers.length === 0

  const openCard = (card: ModelCard) => {
    if (card.providerId && !plumbing.has(card.providerId)) {
      navigate(`/models/providers/${card.providerId}#model-${card.id}`)
      return
    }
    const hosted = deploymentForCard(card, deployments)
    if (hosted) navigate(`/models/hosting/${hosted.id}`)
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Models"
        description="Connect a provider once and every model it offers shows up here and in every model chooser."
        actions={
          <Button asChild className="gap-2">
            <Link to="/models/connect">
              <Plug className="h-4 w-4" aria-hidden />
              Connect a provider
            </Link>
          </Button>
        }
      />
      <PageIntro topic="models" />

      {providersQuery.isError ? (
        <QueryError error={providersQuery.error} onRetry={() => providersQuery.refetch()} title="Couldn't load your providers" />
      ) : noProviders ? (
        <Card data-testid="models-empty">
          <CardContent className="space-y-4 py-10 text-center">
            <h2 className="text-lg font-semibold">Connect your first provider</h2>
            <p className="mx-auto max-w-md text-sm text-muted-foreground">
              Paste a key from OpenAI, Anthropic or any other provider, or point almyty at a server you run. Its models appear here right away.
            </p>
            <div className="mx-auto grid max-w-lg grid-cols-2 gap-2 sm:grid-cols-4">
              {QUICK_START.map((type) => (
                <Link
                  key={type}
                  to={`/models/connect?type=${type}`}
                  className="flex flex-col items-center gap-1 rounded-lg border bg-card px-2 py-3 text-xs font-medium hover:border-primary/50 hover:bg-muted/50"
                >
                  <span className="text-lg" aria-hidden>
                    {providerLogos[type]}
                  </span>
                  {providerTileLabel(type)}
                </Link>
              ))}
            </div>
            <Button asChild size="lg">
              <Link to="/models/connect">Connect a provider</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <section aria-labelledby="connected-heading" className="space-y-3">
            <h2 id="connected-heading" className="text-lg font-semibold">
              Connected
            </h2>
            <ConnectedCardGrid loading={providersQuery.isLoading}>
              {providers.map((p: any) => {
                const own = cardsByProvider[p.id] ?? []
                const check = providerCheck(p)
                return (
                  <ConnectedCard key={p.id} to={`/models/providers/${p.id}`} testId={`provider-card-${p.id}`} icon={providerLogos[p.type] || '⚙️'} name={p.name}>
                    <ProviderStatus check={check} />
                    <span data-testid="provider-model-count">
                      {cardsQuery.isLoading ? 'Models loading' : `${own.length} model${own.length === 1 ? '' : 's'}`}
                    </span>
                  </ConnectedCard>
                )
              })}
            </ConnectedCardGrid>
          </section>

          <section aria-labelledby="all-models-heading" className="space-y-3">
            <h2 id="all-models-heading" className="text-lg font-semibold">
              All models
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-full max-w-xs">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search models" aria-label="Search models" />
              </div>
              <Select value={providerFilter} onValueChange={setProviderFilter}>
                <SelectTrigger className="w-52" aria-label="Filter by provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All providers</SelectItem>
                  {providers.map((p: any) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                  {(cardsByProvider[HOSTED]?.length ?? 0) > 0 && <SelectItem value={HOSTED}>Hosted on your cloud</SelectItem>}
                </SelectContent>
              </Select>
            </div>

            {orphans.length > 0 && !search && providerFilter === 'all' && (
              <Card data-testid="hosted-starting">
                <CardContent className="p-0">
                  <h3 className="border-b px-3 py-2 text-sm font-medium">Starting on your cloud</h3>
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
            {cardsQuery.isError ? (
              <QueryError error={cardsQuery.error} onRetry={() => cardsQuery.refetch()} title="Couldn't load your models" />
            ) : loading ? (
              <Skeleton className="h-48 w-full" />
            ) : groups.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground" data-testid="models-none">
                {search || providerFilter !== 'all'
                  ? 'No models match.'
                  : 'Your providers list no models yet. Open a provider and check it again.'}
              </p>
            ) : (
              <div className="space-y-4">
                {groups.map((g) => (
                  <Card key={g.key} data-testid={`model-group-${g.key}`}>
                    <CardContent className="p-0">
                      <h3 className="border-b px-3 py-2 text-sm font-medium">
                        {g.name} <span className="font-normal text-muted-foreground">({g.rows.length})</span>
                      </h3>
                      <ul>
                        {g.rows.map((card) => (
                          <ModelRow key={card.id} card={card} provider={card.providerId ? byId[card.providerId] : null} onOpen={() => openCard(card)} />
                        ))}
                      </ul>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}
