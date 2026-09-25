/**
 * One model, as a row: the same row on /models (All models) and on a
 * provider's page. Name, the id the provider knows it by, price per million
 * tokens, context length, and whether an agent can use it, with a short
 * plain reason when not.
 */
import type { ReactNode } from 'react'
import { CheckCircle2, CircleSlash } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { ModelCard, ModelPricing } from '@/types/models'
import { providerCheck } from '@/components/llm-providers/provider-status'
import type { ProviderHealthFields } from '@/lib/provider-health'

/** The bits of a provider the row reads to explain a model it cannot use. */
export interface ProviderHealth extends ProviderHealthFields {
  id: string
  name?: string
}

export interface Availability {
  usable: boolean
  /** Short, shown on the row. */
  label: string
  /** The longer why, on hover and in the detail. */
  detail?: string
}

/** A provider whose last key check failed. */
export function providerCheckFailed(provider?: ProviderHealth | null): boolean {
  if (!provider) return false
  const state = providerCheck(provider).state
  return state === 'rejected' || state === 'failed'
}

/**
 * Whether an agent can use this model, and if not, why in a few words:
 * the provider stopped offering it, the provider's key check failed, or the
 * model itself did not answer.
 */
export function availability(card: Pick<ModelCard, 'selectable' | 'status' | 'validationStatus' | 'lastValidationError' | 'metadata'>, provider?: ProviderHealth | null): Availability {
  if (card.selectable) return { usable: true, label: 'Available' }
  if (card.status === 'inactive' || card.metadata?.retiredReason) {
    const reason = typeof card.metadata?.retiredReason === 'string' ? card.metadata.retiredReason : undefined
    return { usable: false, label: 'No longer offered', detail: reason || 'The provider no longer lists this model.' }
  }
  if (providerCheckFailed(provider)) {
    return { usable: false, label: 'Provider check failed', detail: provider?.lastError || 'The provider did not accept its key on the last check.' }
  }
  if (card.validationStatus === 'failed' || card.status === 'error') {
    return { usable: false, label: 'Not available', detail: card.lastValidationError || 'The provider did not answer for this model.' }
  }
  return { usable: false, label: 'Not available', detail: 'Check the provider again to make it available.' }
}

function trimPrice(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (n >= 100) return n.toFixed(0)
  if (n >= 1) return n.toFixed(2)
  return String(Number(n.toFixed(4)))
}

/** The price that applies: your own when set, else the provider's list price. */
export function effectivePrice(card: Pick<ModelCard, 'pricing' | 'pricingOverride'>): ModelPricing | null {
  return card.pricingOverride ?? card.pricing ?? null
}

/** "$2.50 in / $10.00 out" per million tokens, or "No price". */
export function formatPrice(pricing: ModelPricing | null | undefined): string {
  if (!pricing) return 'No price'
  const unit = pricing.currency && pricing.currency !== 'USD' ? ` ${pricing.currency}` : ''
  return `$${trimPrice(pricing.inPerMTok)} in / $${trimPrice(pricing.outPerMTok)} out${unit}`
}

/** "128k", "1M", or a dash when unknown. */
export function formatContext(n: number | null | undefined): string {
  if (!n) return '--'
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

export function AvailabilityBadge({ value }: { value: Availability }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap text-xs',
        value.usable ? 'text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground',
      )}
      title={value.detail}
      data-testid="model-availability"
    >
      {value.usable ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> : <CircleSlash className="h-3.5 w-3.5" aria-hidden />}
      {value.label}
    </span>
  )
}

export interface ModelRowProps {
  card: ModelCard
  /** Shown under the model name on the All models list; left out on a provider's own page. */
  providerName?: string
  provider?: ProviderHealth | null
  /** Rendered at the end of the row (a settings toggle on a provider page). */
  action?: ReactNode
  /** Rendered under the row (the settings themselves). */
  children?: ReactNode
  onOpen?: () => void
}

export function ModelRow({ card, providerName, provider, action, children, onOpen }: ModelRowProps) {
  const state = availability(card, provider)
  const main = (
    <>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{card.name}</div>
        <div className="truncate font-mono text-xs text-muted-foreground">
          {card.vendorModelId}
          {providerName ? <span className="font-sans"> · {providerName}</span> : null}
        </div>
        {!state.usable && state.detail && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground" data-testid="model-unavailable-detail">{state.detail}</p>
        )}
      </div>
      <div className="w-40 shrink-0 text-xs tabular-nums sm:text-right" data-testid="model-price">
        {formatPrice(effectivePrice(card))}
        <div className="text-[11px] text-muted-foreground">per 1M tokens</div>
      </div>
      <div className="w-16 shrink-0 text-xs tabular-nums sm:text-right" data-testid="model-context" title="Context length">
        {formatContext(card.contextLength)}
      </div>
      <div className="w-36 shrink-0 sm:text-right">
        <AvailabilityBadge value={state} />
      </div>
    </>
  )
  return (
    <li id={`model-${card.id}`} className="scroll-mt-24 border-b last:border-b-0" data-testid={`model-row-${card.id}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5">
        {onOpen ? (
          <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1 text-left hover:opacity-80">
            {main}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1">{main}</div>
        )}
        {action}
      </div>
      {children}
    </li>
  )
}
