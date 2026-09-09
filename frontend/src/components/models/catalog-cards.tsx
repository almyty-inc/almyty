import { MoreHorizontal } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { formatModelPrice, PRICING_SOURCE_LABELS } from '@/lib/models-api'
import { cn } from '@/lib/utils'
import type { ModelCard } from '@/types/models'
import { formatContextLength } from './catalog-columns'
import { CapabilityBadges, PrivacyTierBadge, SelectableIndicator, ValidationBadge } from './model-badges'
import { ModelOriginBadge, modelOrigin, whereItRuns } from './model-origin'

export interface CatalogCardsProps {
  cards: ModelCard[]
  providerNames: Record<string, string>
  validatingIds: Set<string>
  onValidate: (card: ModelCard) => void
  onEdit: (card: ModelCard) => void
  onDelete: (card: ModelCard) => void
  /** Ids currently in the routing set. */
  picked: Set<string>
  onTogglePick: (card: ModelCard) => void
}

/**
 * The catalog as cards, because that is what the router picks from. A card
 * from a vendor key, one from an endpoint you deployed and one from an
 * endpoint you registered are laid out identically: same fields, same
 * actions, an origin badge as the only difference.
 */
export function CatalogCards({ cards, providerNames, validatingIds, onValidate, onEdit, onDelete, picked, onTogglePick }: CatalogCardsProps) {
  if (cards.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">No models match these filters.</p>
  }
  return (
    <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="catalog-cards">
      {cards.map((card) => (
        <ModelCatalogCard
          key={card.id}
          card={card}
          providerNames={providerNames}
          validating={validatingIds.has(card.id)}
          onValidate={onValidate}
          onEdit={onEdit}
          onDelete={onDelete}
          picked={picked.has(card.id)}
          onTogglePick={onTogglePick}
        />
      ))}
    </ul>
  )
}

export function ModelCatalogCard({
  card,
  providerNames,
  validating,
  onValidate,
  onEdit,
  onDelete,
  picked,
  onTogglePick,
}: {
  card: ModelCard
  providerNames: Record<string, string>
  validating: boolean
  onValidate: (card: ModelCard) => void
  onEdit: (card: ModelCard) => void
  onDelete: (card: ModelCard) => void
  picked: boolean
  onTogglePick: (card: ModelCard) => void
}) {
  const source = card.pricingOverride ? 'manual' : card.pricingSource
  return (
    <li
      className={cn(
        'flex flex-col gap-3 rounded-xl border bg-card p-4 transition-colors',
        picked ? 'border-violet-500/60 ring-1 ring-violet-500/30' : 'border-border',
      )}
      data-testid={`catalog-card-${card.id}`}
    >
      <div className="flex items-start gap-2">
        <Checkbox
          checked={picked}
          onCheckedChange={() => onTogglePick(card)}
          aria-label={`Add ${card.name} to the routing set`}
          className="mt-1"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium" title={card.name}>
            {card.name}
          </div>
          <div className="truncate font-mono text-xs text-muted-foreground" title={card.vendorModelId}>
            {card.vendorModelId}
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-8 w-8 shrink-0 p-0" aria-label={`Actions for ${card.name}`}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Actions</DropdownMenuLabel>
            <DropdownMenuItem disabled={validating} onClick={() => onValidate(card)}>
              {validating ? 'Validating...' : 'Validate'}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onEdit(card)}>Edit</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => onDelete(card)}>
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <ModelOriginBadge origin={modelOrigin(card)} />
        <PrivacyTierBadge tier={card.privacyTier} />
        <ValidationBadge card={card} />
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
        <div className="col-span-2">
          <dt className="text-muted-foreground">Runs on</dt>
          <dd className="truncate" title={whereItRuns(card, providerNames)}>
            {whereItRuns(card, providerNames)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Price / MTok</dt>
          <dd className="whitespace-nowrap">{formatModelPrice(card.effectivePricing)}</dd>
          <dd className="text-[11px] text-muted-foreground">{PRICING_SOURCE_LABELS[source] || source}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Context</dt>
          <dd>{formatContextLength(card.contextLength)}</dd>
        </div>
      </dl>

      <CapabilityBadges capabilities={card.capabilities} />

      <div className="mt-auto border-t pt-2">
        <SelectableIndicator selectable={card.selectable} />
      </div>
    </li>
  )
}
