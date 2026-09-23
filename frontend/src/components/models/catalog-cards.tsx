import { Link } from 'react-router-dom'
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
import { formatCents } from '@/lib/deployments-api'
import { hourlyCents, runsOn, type ProviderInfo } from '@/lib/model-hosting'
import { formatModelPrice, PRICING_SOURCE_LABELS } from '@/lib/models-api'
import { cn } from '@/lib/utils'
import type { ModelAdapter, ModelDeployment } from '@/types/deployments'
import type { ModelCard } from '@/types/models'
import { formatContextLength } from './catalog-columns'
import { CapabilityBadges, PrivacyTierBadge, SelectableIndicator, ValidationBadge } from './model-badges'
import { ModelSourceBadge, modelSource } from './model-origin'
import { HostedStatusBadge } from './hosting/hosted-status-badge'

export interface CatalogCardsProps {
  cards: ModelCard[]
  providers: Record<string, ProviderInfo>
  adapters: ModelAdapter[]
  /** The hosting record behind each hosted card, by card id. */
  hosting: Record<string, ModelDeployment>
  validatingIds: Set<string>
  onValidate: (card: ModelCard) => void
  onDelete: (card: ModelCard) => void
  /** Ids currently in the routing set. */
  picked: Set<string>
  onTogglePick: (card: ModelCard) => void
}

/**
 * The model list as cards, because that is what the router picks from. A
 * model reached through a provider's API, one on a server you run and one
 * hosted on your cloud are laid out identically: same fields, same actions.
 * Where it runs is one line and a badge; a hosted model adds its running
 * state and what it costs by the hour.
 */
export function CatalogCards({ cards, providers, adapters, hosting, validatingIds, onValidate, onDelete, picked, onTogglePick }: CatalogCardsProps) {
  if (cards.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">No models match these filters.</p>
  }
  return (
    <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="catalog-cards">
      {cards.map((card) => (
        <ModelCatalogCard
          key={card.id}
          card={card}
          runsOnLabel={runsOn(card, providers, adapters, hosting[card.id])}
          hosted={hosting[card.id]}
          validating={validatingIds.has(card.id)}
          onValidate={onValidate}
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
  runsOnLabel,
  hosted,
  validating,
  onValidate,
  onDelete,
  picked,
  onTogglePick,
}: {
  card: ModelCard
  runsOnLabel: string
  hosted?: ModelDeployment
  validating: boolean
  onValidate: (card: ModelCard) => void
  onDelete: (card: ModelCard) => void
  picked: boolean
  onTogglePick: (card: ModelCard) => void
}) {
  const source = card.pricingOverride ? 'manual' : card.pricingSource
  const rate = hourlyCents(hosted)
  const where = card.region ? `${runsOnLabel}, ${card.region}` : runsOnLabel
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
        <Link to={`/models/${card.id}`} className="min-w-0 flex-1 text-left" aria-label={`Open ${card.name}`}>
          <div className="truncate font-medium hover:underline" title={card.name}>
            {card.name}
          </div>
          <div className="truncate font-mono text-xs text-muted-foreground" title={card.vendorModelId}>
            {card.vendorModelId}
          </div>
        </Link>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-8 w-8 shrink-0 p-0" aria-label={`Actions for ${card.name}`}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Actions</DropdownMenuLabel>
            <DropdownMenuItem asChild><Link to={`/models/${card.id}`}>Details</Link></DropdownMenuItem>
            <DropdownMenuItem disabled={validating} onClick={() => onValidate(card)}>
              {validating ? 'Validating...' : 'Validate'}
            </DropdownMenuItem>
            <DropdownMenuItem asChild><Link to={`/models/${card.id}#settings`}>Edit settings</Link></DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => onDelete(card)}>
              Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <ModelSourceBadge source={modelSource(card, hosted)} />
        {hosted && <HostedStatusBadge deployment={hosted} />}
        <PrivacyTierBadge tier={card.privacyTier} />
        <ValidationBadge card={card} />
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
        <div className="col-span-2">
          <dt className="text-muted-foreground">Runs on</dt>
          <dd className="truncate" title={where}>
            {where}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Price / MTok</dt>
          <dd className="whitespace-nowrap">{formatModelPrice(card.effectivePricing)}</dd>
          <dd className="text-[11px] text-muted-foreground">{PRICING_SOURCE_LABELS[source] || source}</dd>
        </div>
        {hosted ? (
          <div>
            <dt className="text-muted-foreground">Cost per hour</dt>
            <dd className="whitespace-nowrap">{rate !== null ? `${formatCents(rate)}/h` : 'Not reported yet'}</dd>
            <dd className="text-[11px] text-muted-foreground">{hosted.budgetId ? 'Capped by a budget' : 'No spending cap'}</dd>
          </div>
        ) : (
          <div>
            <dt className="text-muted-foreground">Context</dt>
            <dd>{formatContextLength(card.contextLength)}</dd>
          </div>
        )}
      </dl>

      <CapabilityBadges capabilities={card.capabilities} />

      <div className="mt-auto border-t pt-2">
        <SelectableIndicator selectable={card.selectable} />
      </div>
    </li>
  )
}
