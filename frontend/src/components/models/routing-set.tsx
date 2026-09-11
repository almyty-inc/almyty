import { useMemo } from 'react'
import { Copy, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useCopy } from '@/lib/clipboard'
import { ROUTING_OBJECTIVES, ROUTING_OBJECTIVE_LABELS, type ModelCard, type RoutingObjective, type RoutingPolicy } from '@/types/models'
import { modelVendor } from './model-origin'

/**
 * Turn a set of cards into the routing policy an llm_call node takes. The
 * chain is the order they were picked; the objective decides how the first
 * one is chosen when the chain is not pinned.
 */
export function buildRoutingPolicy(cards: Pick<ModelCard, 'id'>[], objective: RoutingObjective): RoutingPolicy {
  const policy: RoutingPolicy = { objective }
  if (cards.length > 0) policy.fallbackChain = cards.map((c) => c.id)
  if (objective === 'pinned' && cards.length > 0) policy.pinnedModel = cards[0].id
  return policy
}

/** How many distinct vendors a set of cards spans, and which. */
export function vendorsOf(cards: ModelCard[], providerNames: Record<string, string>): Array<{ vendor: string; count: number }> {
  const counts = new Map<string, number>()
  for (const card of cards) {
    const vendor = modelVendor(card, providerNames)
    counts.set(vendor, (counts.get(vendor) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([vendor, count]) => ({ vendor, count }))
    .sort((a, b) => b.count - a.count || a.vendor.localeCompare(b.vendor))
}

/**
 * What the agents can actually use, said plainly, with the vendors it
 * spans. This is the whole point of the layer: several vendors at once,
 * from one catalog.
 */
export function CatalogSummary({ cards, providerNames }: { cards: ModelCard[]; providerNames: Record<string, string> }) {
  const usable = useMemo(() => cards.filter((c) => c.selectable), [cards])
  const vendors = useMemo(() => vendorsOf(usable, providerNames), [usable, providerNames])

  if (cards.length === 0) return null

  return (
    <div className="rounded-xl border bg-card p-4" data-testid="catalog-summary">
      <p className="text-sm">
        {usable.length === 0 ? (
          <>
            None of your {cards.length} model{cards.length === 1 ? '' : 's'} is usable yet. A card becomes usable once it is active, has a provider or endpoint, and passes a validation run.
          </>
        ) : (
          <>
            Your agents can use{' '}
            <span className="font-semibold text-violet-600 dark:text-violet-400">
              {usable.length} of {cards.length} models
            </span>{' '}
            right now, across {vendors.length} {vendors.length === 1 ? 'vendor' : 'vendors'}. One agent can call any of them, or several together.
          </>
        )}
      </p>
      {vendors.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5" data-testid="catalog-vendors">
          {vendors.map(({ vendor, count }) => (
            <span key={vendor} className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
              {vendor} <span className="text-foreground">{count}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

export interface RoutingSetBarProps {
  /** The picked cards, in the order they were picked. */
  cards: ModelCard[]
  providerNames: Record<string, string>
  objective: RoutingObjective
  onObjectiveChange: (objective: RoutingObjective) => void
  onRemove: (card: ModelCard) => void
  onClear: () => void
}

/**
 * Pick several cards, across vendors, and take away the routing policy
 * that runs them together: paste it onto an llm_call node's `routing`.
 */
export function RoutingSetBar({ cards, providerNames, objective, onObjectiveChange, onRemove, onClear }: RoutingSetBarProps) {
  const copy = useCopy()
  const vendors = useMemo(() => vendorsOf(cards, providerNames), [cards, providerNames])
  const unusable = cards.filter((c) => !c.selectable)
  if (cards.length === 0) return null
  const policy = buildRoutingPolicy(cards, objective)

  return (
    <div className="rounded-xl border border-violet-500/40 bg-violet-500/5 p-4" data-testid="routing-set-bar">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-medium">
          {cards.length} model{cards.length === 1 ? '' : 's'} across {vendors.length} {vendors.length === 1 ? 'vendor' : 'vendors'}, run together
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={objective} onValueChange={(v) => onObjectiveChange(v as RoutingObjective)}>
            <SelectTrigger className="h-8 w-44 text-xs" aria-label="Routing objective">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROUTING_OBJECTIVES.map((o) => (
                <SelectItem key={o} value={o}>
                  {ROUTING_OBJECTIVE_LABELS[o]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" className="gap-2" onClick={() => copy(JSON.stringify(policy, null, 2), 'Routing policy')}>
            <Copy className="h-4 w-4" />
            Copy routing policy
          </Button>
          <Button size="sm" variant="ghost" onClick={onClear}>
            Clear
          </Button>
        </div>
      </div>

      <ol className="mt-3 flex flex-wrap gap-1.5">
        {cards.map((card, index) => (
          <li key={card.id} className="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-[11px]">
            <span className="font-mono text-muted-foreground">{index + 1}.</span>
            <span className="max-w-[180px] truncate" title={`${card.name} on ${modelVendor(card, providerNames)}`}>
              {card.name}
            </span>
            <button type="button" aria-label={`Remove ${card.name} from the routing set`} className="text-muted-foreground hover:text-foreground" onClick={() => onRemove(card)}>
              <X className="h-3 w-3" />
            </button>
          </li>
        ))}
      </ol>

      <p className="mt-2 text-xs text-muted-foreground">
        {objective === 'pinned'
          ? `Always ${cards[0].name}; the rest take over when it fails.`
          : `Tried in this order, ${objective === 'cheapest' ? 'cheapest' : 'fastest'} first among the ones that pass the node's filters.`}{' '}
        Paste it onto an llm_call node as its routing config.
      </p>

      {unusable.length > 0 && (
        <p className="mt-1 text-xs text-amber-600 dark:text-amber-400" data-testid="routing-set-warning">
          {unusable.length} of these {unusable.length === 1 ? 'is' : 'are'} not selectable yet, and the router will skip {unusable.length === 1 ? 'it' : 'them'} until a validation run passes.
        </p>
      )}
    </div>
  )
}
