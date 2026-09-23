import React, { useCallback, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Boxes, ChevronDown, LayoutGrid, Plus, RefreshCw, Rows3 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { DataTable } from '@/components/ui/data-table'
import { EmptyState } from '@/components/ui/empty-state'
import { QueryError } from '@/components/ui/query-error'
import { Skeleton } from '@/components/ui/skeleton'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatCents, isTerminalState } from '@/lib/deployments-api'
import { cloudAccountLabel, deploymentForCard, hourlyCents, readableModelName, unlistedDeployments } from '@/lib/model-hosting'
import { modelsApi } from '@/lib/models-api'
import { useNotifications } from '@/store/app'
import {
  MODEL_PRIVACY_TIERS,
  MODEL_PRIVACY_TIER_LABELS,
  type ModelCard,
  type ModelPrivacyTier,
  type RoutingObjective,
} from '@/types/models'
import type { ModelAdapter, ModelDeployment } from '@/types/deployments'
import { getApiErrorMessage as errorMessage } from '@/lib/api-error'
import { buildCatalogColumns } from './catalog-columns'
import { CatalogCards } from './catalog-cards'
import { MODEL_SOURCE_LABELS, modelSource, type ModelSource } from './model-origin'
import { CatalogSummary, RoutingSetBar } from './routing-set'
import { HostedStatusBadge } from './hosting/hosted-status-badge'
import { useHostedModels, useProviderMap } from './use-model-data'

export const MODELS_QUERY_KEY = ['models', 'catalog'] as const

const SOURCE_FILTERS: Array<'all' | ModelSource> = ['all', 'provider', 'server', 'cloud']

/**
 * The Models page body: every model this organization can call, wherever
 * it runs, whether agents may use it and what it costs. A model reached
 * through a provider's API, one on a server you run and one hosted on your
 * own cloud are the same kind of row; a hosted one also carries its
 * running state and hourly cost. Each opens on its own page.
 */
export function ModelsCatalog() {
  const queryClient = useQueryClient()
  const notifications = useNotifications()
  const navigate = useNavigate()

  const [selectableOnly, setSelectableOnly] = useState(false)
  const [tierFilter, setTierFilter] = useState<'all' | ModelPrivacyTier>('all')
  const [providerFilter, setProviderFilter] = useState<'all' | string>('all')
  const [sourceFilter, setSourceFilter] = useState<'all' | ModelSource>('all')
  const [view, setView] = useState<'cards' | 'table'>('cards')

  // The routing set: cards picked to run together, in the order picked.
  const [pickedIds, setPickedIds] = useState<string[]>([])
  const [objective, setObjective] = useState<RoutingObjective>('cheapest')

  const [cardToDelete, setCardToDelete] = useState<ModelCard | null>(null)
  const [validatingIds, setValidatingIds] = useState<Set<string>>(new Set())

  const cardsQuery = useQuery({
    queryKey: MODELS_QUERY_KEY,
    queryFn: async () => {
      const rows = await modelsApi.list()
      return Array.isArray(rows) ? rows : []
    },
  })
  const { providers } = useProviderMap()
  const { deployments, adapters } = useHostedModels()

  const providerList = useMemo(() => Object.values(providers), [providers])
  const providerNames = useMemo(() => {
    const out: Record<string, string> = {}
    for (const p of providerList) out[p.id] = p.name
    return out
  }, [providerList])

  const cards = useMemo(() => cardsQuery.data || [], [cardsQuery.data])
  const hosting = useMemo(() => {
    const out: Record<string, ModelDeployment> = {}
    for (const card of cards) {
      const d = deploymentForCard(card, deployments)
      if (d) out[card.id] = d
    }
    return out
  }, [cards, deployments])
  const orphans = useMemo(() => unlistedDeployments(cards, deployments), [cards, deployments])

  // Invalidate the whole ['models'] prefix, not just the catalog key.
  // ['models','selectable'] (the routing policy editor) and
  // ['models','names'] (the agent Overview) are siblings of
  // ['models','catalog'], not descendants, so a catalog-only invalidate
  // never reached them -- and validation is exactly what flips a card
  // to selectable, which the toast promises.
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['models'] })

  const deleteCard = useMutation({
    mutationFn: (id: string) => modelsApi.remove(id),
    onSuccess: () => {
      invalidate()
      notifications.success('Model removed', 'The model is no longer in the list')
    },
    onError: (error: any) => notifications.error('Could not remove model', errorMessage(error, 'The model was not removed')),
  })

  const validateCard = useMutation({
    mutationFn: (card: ModelCard) => modelsApi.validate(card.id),
    onMutate: (card) => {
      setValidatingIds((prev) => new Set(prev).add(card.id))
    },
    onSettled: (_result, _error, card) => {
      setValidatingIds((prev) => {
        const next = new Set(prev)
        next.delete(card.id)
        return next
      })
      invalidate()
    },
    onSuccess: (result, card) => {
      if (result?.passed) {
        notifications.success('Validation passed', `${card.name} answered in ${result.latencyMs} ms and is now usable.`)
      } else {
        notifications.error('Validation failed', result?.error || `${card.name} did not answer the validation call.`)
      }
    },
    onError: (error: any, card) => notifications.error('Validation failed', errorMessage(error, `${card.name} did not answer the validation call.`)),
  })

  const sync = useMutation({
    mutationFn: (providerId?: string) => modelsApi.sync(providerId),
    onSuccess: (result, providerId) => {
      invalidate()
      const created = Array.isArray(result?.created) ? result.created.length : 0
      const skippedCount = Array.isArray(result?.skipped) ? result.skipped.length : typeof result?.skipped === 'number' ? result.skipped : 0
      const scope = providerId ? providerNames[providerId] || 'the inference provider' : 'all inference providers'
      notifications.success('Sync complete', `${created} new model${created === 1 ? '' : 's'} from ${scope}${skippedCount ? `, ${skippedCount} already present` : ''}.`)
    },
    onError: (error: any) => notifications.error('Sync failed', errorMessage(error, 'The inference provider did not list its models')),
  })

  const filtered = useMemo(
    () =>
      cards.filter((card) => {
        if (selectableOnly && !card.selectable) return false
        if (tierFilter !== 'all' && card.privacyTier !== tierFilter) return false
        if (providerFilter !== 'all' && card.providerId !== providerFilter) return false
        if (sourceFilter !== 'all' && modelSource(card, hosting[card.id]) !== sourceFilter) return false
        return true
      }),
    [cards, selectableOnly, tierFilter, providerFilter, sourceFilter, hosting],
  )

  const picked = useMemo(() => new Set(pickedIds), [pickedIds])
  const pickedCards = useMemo(
    () => pickedIds.map((id) => cards.find((c) => c.id === id)).filter((c): c is ModelCard => !!c),
    [pickedIds, cards],
  )
  const togglePick = useCallback(
    (card: ModelCard) => setPickedIds((prev) => (prev.includes(card.id) ? prev.filter((id) => id !== card.id) : [...prev, card.id])),
    [],
  )

  const openCard = useCallback((card: ModelCard) => navigate(`/models/${card.id}`), [navigate])
  const columns = useMemo(
    () =>
      buildCatalogColumns({
        providers,
        adapters,
        hosting,
        validatingIds,
        onOpen: openCard,
        onValidate: (card) => validateCard.mutate(card),
        onEdit: (card) => navigate(`/models/${card.id}#settings`),
        onDelete: (card) => setCardToDelete(card),
      }),
    [providers, adapters, hosting, validatingIds, validateCard, openCard, navigate],
  )

  const isEmpty = !cardsQuery.isLoading && !cardsQuery.isError && cards.length === 0 && orphans.length === 0
  const filtersOn = selectableOnly || tierFilter !== 'all' || providerFilter !== 'all' || sourceFilter !== 'all'
  const deleteBlocked = !!cardToDelete && !!hosting[cardToDelete.id] && !isTerminalState(hosting[cardToDelete.id].state)

  const syncMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2" disabled={sync.isPending || providerList.length === 0}>
          <RefreshCw className={`h-4 w-4 ${sync.isPending ? 'animate-spin' : ''}`} />
          Sync from providers
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => sync.mutate(undefined)}>All inference providers</DropdownMenuItem>
        {providerList.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">One inference provider</DropdownMenuLabel>
            {providerList.map((p) => (
              <DropdownMenuItem key={p.id} onClick={() => sync.mutate(p.id)}>
                {p.name} <span className="text-muted-foreground ml-1">({p.type})</span>
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <div className="space-y-4">
      {!cardsQuery.isLoading && !cardsQuery.isError && <CatalogSummary cards={cards} providerNames={providerNames} />}

      <RoutingSetBar
        cards={pickedCards}
        providerNames={providerNames}
        objective={objective}
        onObjectiveChange={setObjective}
        onRemove={togglePick}
        onClear={() => setPickedIds([])}
      />

      {cardsQuery.isError ? (
        <QueryError error={cardsQuery.error} onRetry={() => cardsQuery.refetch()} title="Couldn't load your models" />
      ) : isEmpty ? (
            <EmptyState
              icon={Boxes}
              title="No models yet"
              description={
                providerList.length > 0
                  ? 'Your inference providers have not listed any models yet. Sync them, or add a model by hand. A model becomes usable after one validation run passes.'
                  : "Add a model from a provider's API, a server you run, or your own cloud account. A model becomes usable after one validation run passes."
              }
              action={
                <Button asChild className="gap-2">
                  <Link to="/models/new">
                    <Plus className="h-4 w-4" />
                    Add model
                  </Link>
                </Button>
              }
              secondaryAction={
                providerList.length > 0 ? (
                  <Button variant="outline" className="gap-2" onClick={() => sync.mutate(undefined)} disabled={sync.isPending}>
                    <RefreshCw className={`h-4 w-4 ${sync.isPending ? 'animate-spin' : ''}`} />
                    Sync from providers
                  </Button>
                ) : undefined
              }
              variant="panel"
            />
      ) : (
        <Card>
          <CardContent className="pt-6 space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <Checkbox checked={selectableOnly} onCheckedChange={(v) => setSelectableOnly(v === true)} aria-label="Usable only" />
                Usable only
              </label>
              <Select value={sourceFilter} onValueChange={(v) => setSourceFilter(v as 'all' | ModelSource)}>
                <SelectTrigger className="w-40" aria-label="Filter by where it runs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SOURCE_FILTERS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s === 'all' ? 'Runs anywhere' : MODEL_SOURCE_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={providerFilter} onValueChange={setProviderFilter}>
                <SelectTrigger className="w-48" aria-label="Filter by inference provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All inference providers</SelectItem>
                  {providerList.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={tierFilter} onValueChange={(v) => setTierFilter(v as 'all' | ModelPrivacyTier)}>
                <SelectTrigger className="w-36" aria-label="Filter by privacy">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any privacy</SelectItem>
                  {MODEL_PRIVACY_TIERS.map((tier) => (
                    <SelectItem key={tier} value={tier}>{MODEL_PRIVACY_TIER_LABELS[tier]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {filtersOn && <span className="text-xs text-muted-foreground">{filtered.length} of {cards.length} shown</span>}
              <div className="ml-auto flex flex-wrap items-center gap-1">
                {syncMenu}
                <Button variant={view === 'cards' ? 'secondary' : 'ghost'} size="sm" className="gap-1.5" onClick={() => setView('cards')} aria-pressed={view === 'cards'}>
                  <LayoutGrid className="h-4 w-4" />
                  Grid
                </Button>
                <Button variant={view === 'table' ? 'secondary' : 'ghost'} size="sm" className="gap-1.5" onClick={() => setView('table')} aria-pressed={view === 'table'}>
                  <Rows3 className="h-4 w-4" />
                  Table
                </Button>
              </div>
            </div>

            {orphans.length > 0 && !filtersOn && (
              <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="hosted-without-card">
                {orphans.map((d) => (
                  <HostedOnlyCard key={d.id} deployment={d} adapters={adapters} />
                ))}
              </ul>
            )}

            {view === 'cards' ? (
              cardsQuery.isLoading ? (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-52 w-full" />
                  ))}
                </div>
              ) : (
                <CatalogCards
                  cards={filtered}
                  providers={providers}
                  adapters={adapters}
                  hosting={hosting}
                  validatingIds={validatingIds}
                  onValidate={(card) => validateCard.mutate(card)}
                  onDelete={(card) => setCardToDelete(card)}
                  picked={picked}
                  onTogglePick={togglePick}
                />
              )
            ) : (
              <DataTable
                columns={columns}
                data={filtered}
                loading={cardsQuery.isLoading}
                searchKey="name"
                searchPlaceholder="Search models..."
                hideSelectionCount
                onRowClick={openCard}
                emptyState={<p className="text-sm text-muted-foreground py-6 text-center">No models match these filters.</p>}
              />
            )}
          </CardContent>
        </Card>
      )}

      <AlertDialog open={!!cardToDelete} onOpenChange={(open) => { if (!open) setCardToDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{deleteBlocked ? 'Still on your cloud' : 'Remove this model?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteBlocked
                ? `"${cardToDelete?.name}" is still on your cloud. Shut it down from its page first, so nothing keeps billing.`
                : 'Agents routed to it pick another model; agents pinned to it fail until repointed.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{deleteBlocked ? 'Close' : 'Cancel'}</AlertDialogCancel>
            {!deleteBlocked && (
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  if (cardToDelete) deleteCard.mutate(cardToDelete.id)
                  setCardToDelete(null)
                }}
              >
                Remove
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** A hosted model the list has no entry for yet, so it never goes missing. */
function HostedOnlyCard({ deployment: d, adapters }: { deployment: ModelDeployment; adapters: ModelAdapter[] }) {
  const rate = hourlyCents(d)
  return (
    <li className="rounded-xl border border-dashed bg-card p-4" data-testid={`hosted-only-${d.id}`}>
      <Link to={`/models/hosting/${d.id}`} className="block space-y-2" aria-label={`Open ${readableModelName(d.modelRef)}`}>
        <div className="truncate font-medium">{readableModelName(d.modelRef)}</div>
        <HostedStatusBadge deployment={d} />
        <div className="text-xs text-muted-foreground">{cloudAccountLabel(d.providerType, adapters)}</div>
        <div className="text-xs">{rate !== null ? `${formatCents(rate)}/h` : 'Cost not reported yet'}</div>
      </Link>
    </li>
  )
}
