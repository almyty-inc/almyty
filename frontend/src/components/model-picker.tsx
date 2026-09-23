/**
 * ModelPicker: the one way a provider and a model are chosen.
 *
 * Screens that asked for a model used to put a free-text box next to a
 * provider select, so picking a provider still left you typing a model id
 * from memory and finding out at run time that it was wrong. Here the
 * model depends on the provider:
 *
 *   - No provider yet: the model field is disabled and says why.
 *   - Provider chosen: a select of that provider's models, taken from the
 *     org's catalog cards for it when there are any (each marked validated
 *     or not, per `selectable`), otherwise from the provider's live list.
 *   - Free text only where it makes sense: a `custom` (self-hosted)
 *     provider, a provider whose list could not be read or lists nothing,
 *     or when the user explicitly asks for a model id not in the list.
 *   - No providers at all: a link to connect one, opened in a new tab so
 *     the work on this screen survives; the list refetches on return.
 *
 * With `allowRouting`, a second mode lets the catalog's router choose the
 * model per call from a policy instead of pinning one.
 *
 * `__tests__/model-picker-guard.test.ts` fails when a bare model text
 * input appears anywhere else in the app.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink, Loader2, RefreshCw } from 'lucide-react'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { RoutingPolicyField } from '@/components/models/routing-policy-editor'
import { llmProvidersApi } from '@/lib/api'
import { llmProvidersQuery } from '@/lib/llm-providers-query'
import { modelsApi } from '@/lib/models-api'
import { getApiErrorMessage } from '@/lib/api-error'
import { cn } from '@/lib/utils'
import type { ModelCard, RoutingPolicy } from '@/types/models'

export interface ModelSelection {
  providerId?: string
  model?: string
  routing?: RoutingPolicy
}

export interface ProviderOption {
  id: string
  name: string
  type: string
  status?: string
  isActive?: boolean
}

export interface ModelPickerProps {
  value: ModelSelection
  /** The provider rides along so callers that store its name or type can. */
  onChange: (next: ModelSelection, provider?: ProviderOption) => void
  /** Prefix for element ids, so two pickers on one screen stay distinct. */
  idPrefix: string
  /** Adds a "Provider default" choice; the saved model is then empty. */
  modelOptional?: boolean
  /**
   * Makes the provider optional: an extra first choice with this label
   * (for example "Organization default routing policy") clears it.
   */
  providerOptionalLabel?: string
  /** Offers "Routed by policy" next to a pinned provider and model. */
  allowRouting?: boolean
  /** Only providers whose status is active. */
  activeOnly?: boolean
  /** Side by side on wide screens, or stacked. */
  layout?: 'grid' | 'stack'
  /** Smaller type, for rows inside a list (checkers, participants). */
  compact?: boolean
  providerLabel?: string
  modelLabel?: string
  className?: string
}

/** Radix Select cannot carry an empty value, so "no model" needs a name. */
const PROVIDER_DEFAULT = '__provider_default__'
/** Likewise for "no provider", on pickers where the provider is optional. */
const NO_PROVIDER = '__no_provider__'

/** Provider types that serve whatever they were started with. */
const FREE_TEXT_PROVIDER_TYPES = new Set(['custom'])

interface ModelOption {
  id: string
  label: string
  /** Undefined for a live-list entry, which carries no validation state. */
  validated?: boolean
}

/** The providers endpoint has answered in three shapes over time. */
export function asProviderList(raw: unknown): ProviderOption[] {
  const list = Array.isArray(raw) ? raw : (raw as any)?.providers || (raw as any)?.data || []
  return Array.isArray(list) ? list : []
}

function isActive(p: ProviderOption): boolean {
  if (p.status) return p.status === 'active'
  return p.isActive !== false
}

/** The org's providers, shared with every other reader of `['llm-providers']`. */
export function useProviderList() {
  return useQuery({
    // The shared definition, so this cache entry has one shape everywhere.
    ...llmProvidersQuery,
    // "Connect one" opens a new tab; coming back should show the result.
    refetchOnWindowFocus: true,
  })
}

export function ModelPicker({
  value,
  onChange,
  idPrefix,
  modelOptional = false,
  providerOptionalLabel,
  allowRouting = false,
  activeOnly = false,
  layout = 'grid',
  compact = false,
  providerLabel = 'Provider',
  modelLabel = 'Model',
  className,
}: ModelPickerProps) {
  const routed = allowRouting && !!value.routing
  const providersQuery = useProviderList()
  const allProviders = asProviderList(providersQuery.data)
  const providers = activeOnly ? allProviders.filter(isActive) : allProviders
  const provider = allProviders.find((p) => p.id === value.providerId)
  const providerId = routed ? undefined : value.providerId || undefined
  const freeTextProvider = !!provider && FREE_TEXT_PROVIDER_TYPES.has(provider.type)
  // Whether a provider is self-hosted is only known once the providers are
  // in, so nothing is listed before then.
  const listable = !!providerId && !providersQuery.isLoading && !freeTextProvider

  const cardsQuery = useQuery({
    queryKey: ['models', 'by-provider', providerId],
    queryFn: async () => {
      const rows = await modelsApi.list({ providerId })
      return Array.isArray(rows) ? rows : []
    },
    enabled: listable,
    staleTime: 30_000,
    retry: false,
  })
  const cards = useMemo(
    () => (cardsQuery.data ?? []).filter((c: ModelCard) => c.status !== 'inactive'),
    [cardsQuery.data],
  )
  // Cards win; the live list is only asked for when the catalog has none.
  // A catalog that cannot be read falls through to the live list too.
  const needLiveList = listable && (cardsQuery.isError || (cardsQuery.isSuccess && cards.length === 0))

  const liveQuery = useQuery({
    queryKey: ['provider-model-list', providerId],
    queryFn: async () => {
      const res = await llmProvidersApi.getModels(providerId as string)
      const rows: any[] = Array.isArray(res) ? res : []
      return rows
        .map((m) => (typeof m === 'string' ? { id: m, name: m } : { id: m?.id || m?.name, name: m?.name || m?.id }))
        .filter((m): m is { id: string; name: string } => typeof m.id === 'string' && m.id.length > 0)
    },
    enabled: needLiveList,
    staleTime: 60_000,
    retry: false,
  })

  const options: ModelOption[] = useMemo(() => {
    if (cards.length > 0) {
      return [...cards]
        .sort((a, b) => Number(b.selectable) - Number(a.selectable) || a.vendorModelId.localeCompare(b.vendorModelId))
        .map((c) => ({
          id: c.vendorModelId,
          label: c.name && c.name !== c.vendorModelId ? `${c.name} (${c.vendorModelId})` : c.vendorModelId,
          validated: !!c.selectable,
        }))
    }
    return (liveQuery.data ?? []).map((m) => ({ id: m.id, label: m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id }))
  }, [cards, liveQuery.data])

  const loading =
    (!!providerId && providersQuery.isLoading) ||
    (listable && (cardsQuery.isLoading || (needLiveList && liveQuery.isLoading)))
  const listError = !loading && needLiveList && liveQuery.isError ? liveQuery.error : null
  const listedNothing = listable && !loading && !listError && needLiveList && liveQuery.isSuccess && options.length === 0

  const savedModel = value.model || ''
  const savedIsUnlisted = !!savedModel && !options.some((o) => o.id === savedModel)

  // Typing an id is the escape hatch, never the default: it starts off and
  // resets whenever the provider changes.
  const [manual, setManual] = useState(false)
  useEffect(() => {
    setManual(false)
  }, [providerId])

  const freeText = freeTextProvider || !!listError || listedNothing || manual

  const pickProvider = (id: string) => {
    if (id === NO_PROVIDER) {
      onChange({})
      return
    }
    onChange({ providerId: id, model: '' }, allProviders.find((p) => p.id === id))
  }
  const pickModel = (model: string) => {
    onChange({ providerId: value.providerId, model: model === PROVIDER_DEFAULT ? '' : model }, provider)
  }

  const text = compact ? 'text-xs' : 'text-sm'
  const hint = compact ? 'text-[11px]' : 'text-xs'
  const trigger = compact ? 'h-8 text-xs' : undefined
  const providerFieldId = `${idPrefix}-provider`
  const modelFieldId = `${idPrefix}-model`

  const providerField = (
    <div className="space-y-1.5 min-w-0">
      <Label htmlFor={providerFieldId} className={text}>{providerLabel}</Label>
      {providersQuery.isLoading ? (
        <div className={cn('flex h-9 items-center gap-2 text-muted-foreground', hint)} data-testid={`${idPrefix}-providers-loading`}>
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Loading providers
        </div>
      ) : providers.length === 0 ? (
        // A required field with nothing in it is a dead end. Say what is
        // missing and where to fix it; a new tab keeps this screen's
        // unsaved work, and the list refetches when the tab regains focus.
        <div
          data-testid="no-providers"
          className={cn('rounded-md border border-dashed border-border px-3 py-2 text-muted-foreground', hint)}
        >
          No model providers connected yet.{' '}
          <a
            href="/models?tab=providers&new=1"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 text-primary underline-offset-2 hover:underline"
          >
            Connect one
            <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
          <span className="block mt-0.5">It opens in a new tab and appears here when you come back.</span>
        </div>
      ) : (
        <Select value={value.providerId || (providerOptionalLabel ? NO_PROVIDER : '')} onValueChange={pickProvider}>
          <SelectTrigger id={providerFieldId} className={trigger} aria-label={providerLabel}>
            <SelectValue placeholder="Select provider" />
          </SelectTrigger>
          <SelectContent>
            {providerOptionalLabel && <SelectItem value={NO_PROVIDER}>{providerOptionalLabel}</SelectItem>}
            {providers.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name} <span className="text-muted-foreground ml-1">({p.type})</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  )

  let modelControl: ReactNode
  if (!providerId) {
    modelControl = (
      <Select disabled value="">
        <SelectTrigger id={modelFieldId} className={trigger} aria-label={modelLabel} data-testid={`${idPrefix}-model-disabled`}>
          <SelectValue placeholder="Choose a provider first" />
        </SelectTrigger>
        <SelectContent />
      </Select>
    )
  } else if (loading) {
    modelControl = (
      <div
        className={cn('flex h-9 items-center gap-2 rounded-md border border-input px-3 text-muted-foreground', hint)}
        data-testid={`${idPrefix}-model-loading`}
        role="status"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Loading models
      </div>
    )
  } else if (freeText) {
    modelControl = (
      <Input
        id={modelFieldId}
        data-testid={`${idPrefix}-model-input`}
        className={trigger}
        aria-label={modelLabel}
        value={savedModel}
        onChange={(e) => onChange({ providerId: value.providerId, model: e.target.value }, provider)}
        placeholder={modelOptional ? 'Model id, blank for the provider default' : 'Model id, as the provider names it'}
      />
    )
  } else {
    modelControl = (
      <Select value={savedModel || (modelOptional ? PROVIDER_DEFAULT : '')} onValueChange={pickModel}>
        <SelectTrigger id={modelFieldId} className={trigger} aria-label={modelLabel} data-testid={`${idPrefix}-model-select`}>
          <SelectValue placeholder="Select model" />
        </SelectTrigger>
        <SelectContent>
          {modelOptional && <SelectItem value={PROVIDER_DEFAULT}>Provider default</SelectItem>}
          {savedIsUnlisted && (
            <SelectItem value={savedModel}>
              {savedModel} <span className="text-muted-foreground ml-1">(saved, not in the list)</span>
            </SelectItem>
          )}
          {options.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.label}
              {o.validated === true && <span className="ml-1.5 text-emerald-600 dark:text-emerald-400">Validated</span>}
              {o.validated === false && <span className="ml-1.5 text-muted-foreground">Not validated</span>}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }

  const canToggleManual = listable && !loading && !listError && !listedNothing

  const modelField = (
    <div className="space-y-1.5 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={modelFieldId} className={text}>{modelLabel}</Label>
        {canToggleManual && (
          <button
            type="button"
            className={cn('text-muted-foreground hover:text-foreground transition-colors', hint)}
            onClick={() => setManual(!manual)}
          >
            {manual ? 'Choose from the list' : 'Use a model id not in the list'}
          </button>
        )}
      </div>
      {modelControl}
      {!providerId && (
        <p className={cn('text-muted-foreground', hint)}>
          {providerOptionalLabel && !routed
            ? `With no provider: ${providerOptionalLabel.charAt(0).toLowerCase()}${providerOptionalLabel.slice(1)}.`
            : 'The models on offer depend on the provider.'}
        </p>
      )}
      {freeTextProvider && (
        <p className={cn('text-muted-foreground', hint)}>This provider is self-hosted, so type the model id it serves.</p>
      )}
      {listError && (
        <p className={cn('text-amber-700 dark:text-amber-400', hint)} data-testid={`${idPrefix}-model-error`}>
          Could not load this provider&apos;s models ({getApiErrorMessage(listError, 'request failed')}). Type the model id, or{' '}
          <button
            type="button"
            className="inline-flex items-center gap-0.5 underline underline-offset-2"
            onClick={() => {
              void cardsQuery.refetch()
              void liveQuery.refetch()
            }}
          >
            <RefreshCw className="h-3 w-3" aria-hidden />
            try again
          </button>
          .
        </p>
      )}
      {listedNothing && (
        <p className={cn('text-muted-foreground', hint)} data-testid={`${idPrefix}-model-empty`}>
          This provider lists no models. Type the model id it serves.
        </p>
      )}
      {!freeText && !loading && cards.length > 0 && (
        <p className={cn('text-muted-foreground', hint)}>From your model catalog. Validated models passed a real test call.</p>
      )}
    </div>
  )

  return (
    <div className={cn('space-y-3', className)}>
      {allowRouting && (
        <div>
          <Label className={text}>Model selection</Label>
          <div className="mt-1 grid grid-cols-2 gap-1 rounded-md bg-muted p-1" role="radiogroup" aria-label="Model selection">
            <button
              type="button"
              role="radio"
              aria-checked={!routed}
              className={cn('rounded px-2 py-1 text-xs transition-colors', !routed ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground')}
              onClick={() => {
                if (routed) onChange({})
              }}
            >
              Pinned provider
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={routed}
              className={cn('rounded px-2 py-1 text-xs transition-colors', routed ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground')}
              onClick={() => {
                if (!routed) onChange({ routing: { objective: 'cheapest' } })
              }}
            >
              Routed by policy
            </button>
          </div>
          <p className={cn('text-muted-foreground mt-1', hint)}>
            {routed
              ? 'The router picks a validated card from the catalog on every call and records which one answered.'
              : 'Always this provider and model.'}
          </p>
        </div>
      )}
      {routed ? (
        <RoutingPolicyField value={value.routing || {}} onChange={(routing) => onChange({ routing })} />
      ) : (
        <div className={cn(layout === 'grid' ? 'grid grid-cols-1 sm:grid-cols-2 gap-4' : 'space-y-3')}>
          {providerField}
          {modelField}
        </div>
      )}
    </div>
  )
}
