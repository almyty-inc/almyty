import React, { useCallback, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Boxes, ChevronDown, LayoutGrid, Plus, RefreshCw, Rows3, Server } from 'lucide-react'

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
import { llmProvidersApi } from '@/lib/api'
import { modelsApi } from '@/lib/models-api'
import { useNotifications } from '@/store/app'
import {
  MODEL_PRIVACY_TIERS,
  MODEL_PRIVACY_TIER_LABELS,
  type ModelCard,
  type ModelPrivacyTier,
  type RegisterEndpointBody,
  type RegisterModelBody,
  type RoutingObjective,
  type UpdateModelBody,
} from '@/types/models'
import { buildCatalogColumns } from './catalog-columns'
import { CatalogCards } from './catalog-cards'
import { MODEL_ORIGIN_LABELS, modelOrigin, type ModelOrigin } from './model-origin'
import { CatalogSummary, RoutingSetBar } from './routing-set'
import { RegisterEndpointDialog } from './register-endpoint-dialog'
import { RegisterModelDialog, type ProviderOption } from './register-model-dialog'
import { EditModelSheet } from './edit-model-sheet'

export const MODELS_QUERY_KEY = ['models', 'catalog'] as const

const ORIGIN_FILTERS: Array<'all' | ModelOrigin> = ['all', 'vendor', 'deployment', 'endpoint']

function errorMessage(error: any, fallback: string): string {
  return error?.response?.data?.message || error?.message || fallback
}

/**
 * The catalog: which models this organization can run right now, where
 * each one runs, whether the router may pick it, and what it costs. A card
 * from a vendor key, one from an endpoint you deployed and one from an
 * endpoint you registered are the same kind of thing here.
 */
export function CatalogTab() {
  const queryClient = useQueryClient()
  const notifications = useNotifications()

  const [selectableOnly, setSelectableOnly] = useState(false)
  const [tierFilter, setTierFilter] = useState<'all' | ModelPrivacyTier>('all')
  const [providerFilter, setProviderFilter] = useState<'all' | string>('all')
  const [originFilter, setOriginFilter] = useState<'all' | ModelOrigin>('all')
  const [view, setView] = useState<'cards' | 'table'>('cards')

  // The routing set: cards picked to run together, in the order picked.
  const [pickedIds, setPickedIds] = useState<string[]>([])
  const [objective, setObjective] = useState<RoutingObjective>('cheapest')

  const [endpointDialogOpen, setEndpointDialogOpen] = useState(false)
  const [modelDialogOpen, setModelDialogOpen] = useState(false)
  const [cardToEdit, setCardToEdit] = useState<ModelCard | null>(null)
  const [cardToDelete, setCardToDelete] = useState<ModelCard | null>(null)
  const [validatingIds, setValidatingIds] = useState<Set<string>>(new Set())

  const cardsQuery = useQuery({
    queryKey: MODELS_QUERY_KEY,
    queryFn: async () => {
      const rows = await modelsApi.list()
      return Array.isArray(rows) ? rows : []
    },
  })

  const providersQuery = useQuery({
    queryKey: ['llm-providers'],
    queryFn: async () => {
      const d: any = await llmProvidersApi.getAll()
      const list = d?.providers || (Array.isArray(d) ? d : [])
      return Array.isArray(list) ? list : []
    },
  })

  const providers: ProviderOption[] = useMemo(
    () => (providersQuery.data || []).map((p: any) => ({ id: p.id, name: p.name, type: p.type })),
    [providersQuery.data],
  )
  const providerNames = useMemo(() => {
    const out: Record<string, string> = {}
    for (const p of providers) out[p.id] = p.name
    return out
  }, [providers])

  const invalidate = () => queryClient.invalidateQueries({ queryKey: MODELS_QUERY_KEY })

  const registerEndpoint = useMutation({
    mutationFn: (body: RegisterEndpointBody) => modelsApi.registerEndpoint(body),
    onSuccess: (card) => {
      invalidate()
      queryClient.invalidateQueries({ queryKey: ['llm-providers'] })
      setEndpointDialogOpen(false)
      notifications.success('Endpoint registered', `${card?.name || 'The card'} is in the catalog. Validate it to make it usable.`)
    },
    onError: (error: any) => notifications.error('Could not register endpoint', errorMessage(error, 'The endpoint was not saved')),
  })

  const registerModel = useMutation({
    mutationFn: (body: RegisterModelBody) => modelsApi.register(body),
    onSuccess: (card) => {
      invalidate()
      setModelDialogOpen(false)
      notifications.success('Model registered', `${card?.name || 'The card'} is in the catalog. Validate it to make it usable.`)
    },
    onError: (error: any) => notifications.error('Could not register model', errorMessage(error, 'The card was not saved')),
  })

  const updateCard = useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateModelBody }) => modelsApi.update(id, body),
    onSuccess: () => {
      invalidate()
      setCardToEdit(null)
      notifications.success('Card updated', 'Changes saved')
    },
    onError: (error: any) => notifications.error('Could not update card', errorMessage(error, 'Changes were not saved')),
  })

  const deleteCard = useMutation({
    mutationFn: (id: string) => modelsApi.remove(id),
    onSuccess: () => {
      invalidate()
      notifications.success('Card removed', 'The model is no longer in the catalog')
    },
    onError: (error: any) => notifications.error('Could not remove card', errorMessage(error, 'The card was not removed')),
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
        notifications.success('Validation passed', `${card.name} answered in ${result.latencyMs} ms and is now selectable.`)
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
      const scope = providerId ? providerNames[providerId] || 'the provider' : 'all providers'
      notifications.success('Sync complete', `${created} new card${created === 1 ? '' : 's'} from ${scope}${skippedCount ? `, ${skippedCount} already present` : ''}.`)
    },
    onError: (error: any) => notifications.error('Sync failed', errorMessage(error, 'The provider did not list its models')),
  })

  const cards = cardsQuery.data || []
  const filtered = useMemo(
    () =>
      cards.filter((card) => {
        if (selectableOnly && !card.selectable) return false
        if (tierFilter !== 'all' && card.privacyTier !== tierFilter) return false
        if (providerFilter !== 'all' && card.providerId !== providerFilter) return false
        if (originFilter !== 'all' && modelOrigin(card) !== originFilter) return false
        return true
      }),
    [cards, selectableOnly, tierFilter, providerFilter, originFilter],
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

  const columns = useMemo(
    () =>
      buildCatalogColumns({
        providerNames,
        validatingIds,
        onValidate: (card) => validateCard.mutate(card),
        onEdit: (card) => setCardToEdit(card),
        onDelete: (card) => setCardToDelete(card),
      }),
    [providerNames, validatingIds, validateCard],
  )

  const isEmpty = !cardsQuery.isLoading && !cardsQuery.isError && cards.length === 0

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-2" disabled={sync.isPending}>
            <RefreshCw className={`h-4 w-4 ${sync.isPending ? 'animate-spin' : ''}`} />
            Sync from providers
            <ChevronDown className="h-3 w-3 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => sync.mutate(undefined)}>All providers</DropdownMenuItem>
          {providers.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-muted-foreground">One provider</DropdownMenuLabel>
              {providers.map((p) => (
                <DropdownMenuItem key={p.id} onClick={() => sync.mutate(p.id)}>
                  {p.name} <span className="text-muted-foreground ml-1">({p.type})</span>
                </DropdownMenuItem>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="outline" size="sm" className="gap-2" onClick={() => setEndpointDialogOpen(true)}>
        <Server className="h-4 w-4" />
        Register endpoint
      </Button>
      <Button size="sm" className="gap-2" onClick={() => setModelDialogOpen(true)}>
        <Plus className="h-4 w-4" />
        Register model
      </Button>
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {cardsQuery.isLoading ? (
            <Skeleton className="h-4 w-56" />
          ) : (
            <>Every model an agent may call, wherever it runs. A card is usable once its status is active, it has a provider or endpoint, and a validation run has passed.</>
          )}
        </p>
        {toolbar}
      </div>

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
        <QueryError error={cardsQuery.error} onRetry={() => cardsQuery.refetch()} title="Couldn't load the catalog" />
      ) : isEmpty ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={Boxes}
              title="No models yet"
              description="Models appear automatically when you sync a configured vendor, and become usable after a validation run passes. You can also register a single vendor model, an OpenAI-compatible endpoint you run yourself, or run one on a provider from the Deployments tab."
              action={
                <Button className="gap-2" onClick={() => sync.mutate(undefined)} disabled={sync.isPending || providers.length === 0}>
                  <RefreshCw className={`h-4 w-4 ${sync.isPending ? 'animate-spin' : ''}`} />
                  Sync from providers
                </Button>
              }
              secondaryAction={
                <Button variant="outline" className="gap-2" onClick={() => setEndpointDialogOpen(true)}>
                  <Server className="h-4 w-4" />
                  Register endpoint
                </Button>
              }
              className="py-16"
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="pt-6 space-y-4">
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <Checkbox checked={selectableOnly} onCheckedChange={(v) => setSelectableOnly(v === true)} aria-label="Selectable only" />
                Selectable only
              </label>
              <Select value={tierFilter} onValueChange={(v) => setTierFilter(v as 'all' | ModelPrivacyTier)}>
                <SelectTrigger className="w-44" aria-label="Filter by privacy tier">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All tiers</SelectItem>
                  {MODEL_PRIVACY_TIERS.map((tier) => (
                    <SelectItem key={tier} value={tier}>{MODEL_PRIVACY_TIER_LABELS[tier]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={providerFilter} onValueChange={setProviderFilter}>
                <SelectTrigger className="w-52" aria-label="Filter by provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All providers</SelectItem>
                  {providers.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={originFilter} onValueChange={(v) => setOriginFilter(v as 'all' | ModelOrigin)}>
                <SelectTrigger className="w-48" aria-label="Filter by where it came from">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ORIGIN_FILTERS.map((origin) => (
                    <SelectItem key={origin} value={origin}>
                      {origin === 'all' ? 'Any origin' : MODEL_ORIGIN_LABELS[origin]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {(selectableOnly || tierFilter !== 'all' || providerFilter !== 'all' || originFilter !== 'all') && (
                <span className="text-xs text-muted-foreground">{filtered.length} of {cards.length} shown</span>
              )}
              <div className="ml-auto flex items-center gap-1">
                <Button variant={view === 'cards' ? 'secondary' : 'ghost'} size="sm" className="gap-1.5" onClick={() => setView('cards')} aria-pressed={view === 'cards'}>
                  <LayoutGrid className="h-4 w-4" />
                  Cards
                </Button>
                <Button variant={view === 'table' ? 'secondary' : 'ghost'} size="sm" className="gap-1.5" onClick={() => setView('table')} aria-pressed={view === 'table'}>
                  <Rows3 className="h-4 w-4" />
                  Table
                </Button>
              </div>
            </div>
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
                  providerNames={providerNames}
                  validatingIds={validatingIds}
                  onValidate={(card) => validateCard.mutate(card)}
                  onEdit={(card) => setCardToEdit(card)}
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
                emptyState={<p className="text-sm text-muted-foreground py-6 text-center">No models match these filters.</p>}
              />
            )}
          </CardContent>
        </Card>
      )}

      <RegisterEndpointDialog
        open={endpointDialogOpen}
        onOpenChange={setEndpointDialogOpen}
        onSubmit={(body) => registerEndpoint.mutateAsync(body).catch(() => undefined)}
        submitting={registerEndpoint.isPending}
      />
      <RegisterModelDialog
        open={modelDialogOpen}
        onOpenChange={setModelDialogOpen}
        providers={providers}
        onSubmit={(body) => registerModel.mutateAsync(body).catch(() => undefined)}
        submitting={registerModel.isPending}
      />
      <EditModelSheet
        card={cardToEdit}
        onOpenChange={(open) => { if (!open) setCardToEdit(null) }}
        onSubmit={(id, body) => updateCard.mutateAsync({ id, body }).catch(() => undefined)}
        submitting={updateCard.isPending}
      />

      <AlertDialog open={!!cardToDelete} onOpenChange={(open) => { if (!open) setCardToDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove card</AlertDialogTitle>
            <AlertDialogDescription>
              Remove &quot;{cardToDelete?.name}&quot; from the catalog? Agents routed to it will pick another card; agents pinned to it will fail until repointed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => {
                if (cardToDelete) deleteCard.mutate(cardToDelete.id)
                setCardToDelete(null)
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
