/**
 * ModelPicker: the one way a model is chosen, everywhere.
 *
 * One searchable list of every model your connected providers offer,
 * grouped by provider. There is no "pick a provider first" step: picking a
 * model picks its provider. On top, when the screen allows it, "Automatic"
 * (the cheapest model that fits, chosen per call) and "Provider default";
 * at the bottom a link to connect another provider, in a new tab so the
 * work here survives, with the list refetched on return.
 *
 * Free text stays possible where it has to: a model id a provider serves
 * but does not list (your own server) is offered as "Use model id ..."
 * when the search matches nothing, and a saved id that is no longer listed
 * is still shown, marked.
 *
 * `__tests__/model-picker-guard.test.ts` fails when a bare model text
 * input appears anywhere else in the app.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, ChevronDown, ChevronRight, ExternalLink, Loader2, Search, Sparkles } from 'lucide-react'

import { Label } from '@/components/ui/label'
import { RoutingPolicyField } from '@/components/models/routing-policy-editor'
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
  /** Adds "Provider default" to each provider: the saved model is then empty. */
  modelOptional?: boolean
  /**
   * An extra first choice with this label (for example "Organization
   * default routing policy") that clears the value.
   */
  providerOptionalLabel?: string
  /** Adds "Automatic": the router picks the cheapest model that fits, per call. */
  allowRouting?: boolean
  /** Only providers whose status is active. */
  activeOnly?: boolean
  /** Leaves out providers this returns true for (the raw provider row is passed). */
  excludeProvider?: (provider: ProviderOption & Record<string, any>) => boolean
  /** Accepted for older callers; the picker is one field now. */
  layout?: 'grid' | 'stack'
  /** Smaller type, for rows inside a list (checkers, participants). */
  compact?: boolean
  /** Only the models of `value.providerId` (a provider's own page). */
  providerLocked?: boolean
  /** Accepted for older callers; there is no separate provider field. */
  providerLabel?: string
  modelLabel?: string
  className?: string
}

/** The model list every picker and the Models page share. */
export const PICKER_MODELS_KEY = ['models', 'catalog'] as const

/** Provider types that serve whatever they were started with, and may list nothing. */
const FREE_TEXT_PROVIDER_TYPES = new Set(['custom', 'ollama'])

/** The providers endpoint has answered in three shapes over time. */
export function asProviderList(raw: unknown): ProviderOption[] {
  const list = Array.isArray(raw) ? raw : (raw as any)?.providers || (raw as any)?.data || []
  return Array.isArray(list) ? list : []
}

/**
 * Whether a provider call failed because the vendor refused the key. The
 * backend passes the vendor's message through (axios's "Request failed with
 * status code 401", an SDK's "401 Incorrect API key provided", Anthropic's
 * authentication_error), so this reads the text. A 401 or 403 from almyty
 * itself is a session or permission problem, not the provider's key.
 */
export function keyRejected(error: unknown): boolean {
  const ownStatus = (error as { response?: { status?: number } } | undefined)?.response?.status
  if (ownStatus === 401 || ownStatus === 403) return false
  const raw = getApiErrorMessage(error, '')
  return /\b40[13]\b|unauthori[sz]ed|forbidden|authentication[_ ]error|invalid[_ ]?(api[_ ]?)?key|incorrect api key|api key not valid/i.test(raw)
}

function isActive(p: ProviderOption): boolean {
  if (p.status) return p.status === 'active'
  return p.isActive !== false
}

/** The org's providers, shared with every other reader of `['llm-providers']`. */
export function useProviderList() {
  return useQuery({
    ...llmProvidersQuery,
    // "Connect a provider" opens a new tab; coming back should show the result.
    refetchOnWindowFocus: true,
  })
}

type Item =
  | { key: string; kind: 'auto'; label: string }
  | { key: string; kind: 'clear'; label: string }
  | { key: string; kind: 'default'; label: string; provider: ProviderOption }
  | { key: string; kind: 'model'; label: string; sub: string; provider: ProviderOption; model: string; unavailable?: boolean; saved?: boolean }
  | { key: string; kind: 'free'; label: string; provider: ProviderOption; model: string }

interface Group {
  key: string
  heading?: string
  items: Item[]
  /** A line in place of items, for a provider that lists nothing. */
  note?: string
}

const AUTO_LABEL = 'Automatic: the cheapest model that fits'

function autoLabel(routing: RoutingPolicy): string {
  if (routing.objective === 'fastest') return 'Automatic: the fastest model that fits'
  if (routing.objective === 'pinned') return 'Automatic, with a fixed first choice'
  return AUTO_LABEL
}

function cardLabel(c: ModelCard): string {
  return c.name && c.name !== c.vendorModelId ? c.name : c.vendorModelId
}

export function ModelPicker({
  value,
  onChange,
  idPrefix,
  modelOptional = false,
  providerOptionalLabel,
  allowRouting = false,
  activeOnly = false,
  excludeProvider,
  compact = false,
  providerLocked = false,
  modelLabel = 'Model',
  className,
}: ModelPickerProps) {
  const routed = allowRouting && !!value.routing
  const providersQuery = useProviderList()
  const allProviders = asProviderList(providersQuery.data)
  const providers = useMemo(() => {
    if (providerLocked) return allProviders.filter((p) => p.id === value.providerId)
    const listed = excludeProvider ? allProviders.filter((p) => !excludeProvider(p)) : allProviders
    return activeOnly ? listed.filter(isActive) : listed
  }, [allProviders, providerLocked, value.providerId, excludeProvider, activeOnly])

  const cardsQuery = useQuery({
    queryKey: PICKER_MODELS_KEY,
    queryFn: async () => {
      const rows = await modelsApi.list()
      return Array.isArray(rows) ? rows : []
    },
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  })
  const cards: ModelCard[] = useMemo(() => cardsQuery.data ?? [], [cardsQuery.data])

  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [active, setActive] = useState(0)
  const [autoSettings, setAutoSettings] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listId = useId()

  const provider = allProviders.find((p) => p.id === value.providerId)
  const savedModel = !routed ? value.model || '' : ''
  const savedCard = savedModel ? cards.find((c) => c.providerId === value.providerId && c.vendorModelId === savedModel) : undefined

  const groups: Group[] = useMemo(() => {
    const q = search.trim().toLowerCase()
    const matches = (...texts: Array<string | null | undefined>) => !q || texts.some((t) => (t || '').toLowerCase().includes(q))
    const out: Group[] = []

    const top: Item[] = []
    if (allowRouting && matches(AUTO_LABEL, 'automatic', 'cheapest')) top.push({ key: 'auto', kind: 'auto', label: AUTO_LABEL })
    if (providerOptionalLabel && matches(providerOptionalLabel)) top.push({ key: 'clear', kind: 'clear', label: providerOptionalLabel })
    if (top.length > 0) out.push({ key: 'top', items: top })

    let modelHits = 0
    for (const p of providers) {
      const items: Item[] = []
      if (modelOptional && matches('Provider default', p.name)) items.push({ key: `${p.id}::default`, kind: 'default', label: 'Provider default', provider: p })
      const own = cards
        .filter((c) => c.providerId === p.id)
        .filter((c) => (c.selectable && c.status !== 'inactive') || (c.providerId === value.providerId && c.vendorModelId === savedModel))
        .sort((a, b) => cardLabel(a).localeCompare(cardLabel(b)))
      for (const c of own) {
        if (!matches(c.name, c.vendorModelId, p.name)) continue
        const unavailable = !c.selectable || c.status === 'inactive'
        items.push({ key: `${p.id}::${c.vendorModelId}`, kind: 'model', label: cardLabel(c), sub: c.vendorModelId, provider: p, model: c.vendorModelId, unavailable })
        modelHits += 1
      }
      // A saved id this provider no longer lists still reads as chosen.
      if (p.id === value.providerId && savedModel && !savedCard && matches(savedModel, p.name)) {
        items.push({ key: `${p.id}::${savedModel}`, kind: 'model', label: savedModel, sub: 'Saved, not in the list', provider: p, model: savedModel, saved: true, unavailable: true })
        modelHits += 1
      }
      const note = own.length === 0 && !q ? (FREE_TEXT_PROVIDER_TYPES.has(p.type) ? 'Type the model id your server runs.' : 'No models yet. Check the provider again on its page.') : undefined
      if (items.length > 0 || note) out.push({ key: p.id, heading: p.name, items, note })
    }

    if (q && modelHits === 0 && providers.length > 0) {
      const raw = search.trim()
      const targets = value.providerId && providers.some((p) => p.id === value.providerId) ? providers.filter((p) => p.id === value.providerId) : providers
      out.push({
        key: 'free',
        heading: 'Not in the list',
        items: targets.map((p) => ({ key: `free::${p.id}`, kind: 'free' as const, label: `Use model id "${raw}"`, provider: p, model: raw })),
      })
    }
    return out
  }, [search, allowRouting, providerOptionalLabel, providers, modelOptional, cards, value.providerId, savedModel, savedCard])

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups])

  useEffect(() => {
    setActive(0)
  }, [search, open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const choose = (item: Item) => {
    setOpen(false)
    setSearch('')
    switch (item.kind) {
      case 'auto':
        onChange({ routing: value.routing ?? { objective: 'cheapest' } })
        return
      case 'clear':
        onChange({})
        return
      case 'default':
        onChange({ providerId: item.provider.id, model: '' }, item.provider)
        return
      default:
        onChange({ providerId: item.provider.id, model: item.model }, item.provider)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, flat.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = flat[active]
      if (item) choose(item)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  }

  const isSelected = (item: Item): boolean => {
    switch (item.kind) {
      case 'auto':
        return routed
      case 'clear':
        return !routed && !value.providerId
      case 'default':
        return !routed && value.providerId === item.provider.id && !savedModel
      case 'model':
        return !routed && value.providerId === item.provider.id && savedModel === item.model
      default:
        return false
    }
  }

  let current: string
  let currentSub: string | undefined
  if (routed) {
    current = autoLabel(value.routing!)
  } else if (value.providerId && savedModel) {
    current = savedCard ? cardLabel(savedCard) : savedModel
    currentSub = provider?.name
  } else if (value.providerId) {
    current = modelOptional ? 'Provider default' : 'Choose a model'
    currentSub = provider?.name
  } else if (providerOptionalLabel) {
    current = providerOptionalLabel
  } else {
    current = 'Choose a model'
  }
  const empty = !routed && !value.providerId && !providerOptionalLabel
  const savedUnavailable = !routed && !!savedCard && (!savedCard.selectable || savedCard.status === 'inactive')

  const text = compact ? 'text-xs' : 'text-sm'
  const hint = compact ? 'text-[11px]' : 'text-xs'
  const triggerId = `${idPrefix}-model`
  const loading = providersQuery.isLoading || cardsQuery.isLoading
  const noProviders = !providersQuery.isLoading && providers.length === 0 && !providerLocked

  const connectLink = (
    <a
      href="/models/connect"
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-0.5 text-primary underline-offset-2 hover:underline"
    >
      Connect a provider
      <ExternalLink className="h-3 w-3" aria-hidden />
    </a>
  )

  return (
    <div className={cn('space-y-1.5', className)} ref={rootRef}>
      <Label htmlFor={triggerId} className={text}>
        {modelLabel}
      </Label>
      {noProviders ? (
        // A required field with nothing in it is a dead end. Say what is
        // missing and where to fix it; a new tab keeps this screen's work,
        // and the list refetches when the tab regains focus.
        <div data-testid="no-providers" className={cn('rounded-md border border-dashed border-border px-3 py-2 text-muted-foreground', hint)}>
          No providers connected yet. {connectLink}
          <span className="mt-0.5 block">It opens in a new tab and its models appear here when you come back.</span>
        </div>
      ) : (
        <>
          <button
            type="button"
            id={triggerId}
            role="combobox"
            aria-label={modelLabel}
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-controls={open ? listId : undefined}
            data-testid={`${idPrefix}-model-trigger`}
            disabled={loading}
            onClick={() => {
              setOpen((v) => !v)
              window.setTimeout(() => searchRef.current?.focus(), 0)
            }}
            className={cn(
              'flex w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-left shadow-sm',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-60',
              compact ? 'h-8 text-xs' : 'h-9 text-sm',
            )}
          >
            {loading ? (
              <span className="flex items-center gap-2 text-muted-foreground" data-testid={`${idPrefix}-model-loading`}>
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Loading models
              </span>
            ) : (
              <span className={cn('flex min-w-0 items-center gap-1.5', empty && 'text-muted-foreground')}>
                {routed && <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />}
                <span className="truncate" data-testid={`${idPrefix}-model-value`}>
                  {current}
                </span>
                {currentSub && <span className="shrink-0 truncate text-muted-foreground">· {currentSub}</span>}
              </span>
            )}
            <ChevronDown className="h-4 w-4 shrink-0 opacity-50" aria-hidden />
          </button>

          {open && (
            <div className="rounded-md border bg-popover text-popover-foreground shadow-md" data-testid={`${idPrefix}-model-panel`}>
              <div className="flex items-center border-b px-2.5">
                <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" aria-hidden />
                <input
                  ref={searchRef}
                  type="search"
                  aria-label="Search models"
                  aria-controls={listId}
                  aria-activedescendant={flat[active] ? `${listId}-${flat[active].key}` : undefined}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder="Search models"
                  className={cn('h-9 w-full bg-transparent outline-none placeholder:text-muted-foreground', text)}
                />
              </div>
              <div id={listId} role="listbox" aria-label={modelLabel} className="max-h-72 overflow-y-auto p-1">
                {groups.length === 0 && <p className={cn('px-2 py-3 text-center text-muted-foreground', hint)}>No models match.</p>}
                {groups.map((g) => (
                  <div key={g.key} role="group" aria-label={g.heading ?? 'Choices'} className="py-0.5">
                    {g.heading && <div className={cn('px-2 pb-0.5 pt-1.5 font-medium text-muted-foreground', hint)}>{g.heading}</div>}
                    {g.items.map((item) => {
                      const idx = flat.indexOf(item)
                      const selected = isSelected(item)
                      return (
                        <div
                          key={item.key}
                          id={`${listId}-${item.key}`}
                          role="option"
                          aria-selected={selected}
                          data-active={idx === active || undefined}
                          onMouseEnter={() => setActive(idx)}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => choose(item)}
                          className={cn('flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5', text, idx === active && 'bg-accent text-accent-foreground')}
                        >
                          <Check className={cn('h-3.5 w-3.5 shrink-0', selected ? 'opacity-100' : 'opacity-0')} aria-hidden />
                          <span className="min-w-0 flex-1 truncate">
                            {item.label}
                            {item.kind === 'model' && item.sub !== item.label && <span className="ml-1.5 font-mono text-muted-foreground">{item.sub}</span>}
                            {item.kind === 'free' && <span className="ml-1.5 text-muted-foreground">with {item.provider.name}</span>}
                          </span>
                          {item.kind === 'model' && item.unavailable && !item.saved && <span className={cn('shrink-0 text-amber-700 dark:text-amber-400', hint)}>Not available</span>}
                        </div>
                      )
                    })}
                    {g.note && <p className={cn('px-2 py-1 text-muted-foreground', hint)}>{g.note}</p>}
                  </div>
                ))}
              </div>
              {!providerLocked && <div className={cn('border-t px-3 py-2', hint)}>{connectLink}</div>}
            </div>
          )}
        </>
      )}

      {savedUnavailable && (
        <p className={cn('text-amber-700 dark:text-amber-400', hint)} data-testid={`${idPrefix}-model-unavailable`}>
          This model is not available right now. Pick another, or check its provider again.
        </p>
      )}

      {routed && (
        <div>
          <button type="button" className={cn('inline-flex items-center gap-1 text-muted-foreground hover:text-foreground', hint)} aria-expanded={autoSettings} onClick={() => setAutoSettings((v) => !v)}>
            {autoSettings ? <ChevronDown className="h-3 w-3" aria-hidden /> : <ChevronRight className="h-3 w-3" aria-hidden />}
            Automatic settings
          </button>
          {autoSettings && (
            <div className="mt-2">
              <RoutingPolicyField value={value.routing || {}} onChange={(routing) => onChange({ routing })} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
