/**
 * How a model reads wherever it is listed (the Models catalog, a
 * connection's models, every model chooser): its price per million tokens
 * (or "Price unknown"), its context length when known, and whether it can
 * be used now, with a short plain reason when not.
 */
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
export function availability(card: Pick<ModelCard, 'selectable' | 'status' | 'validationStatus' | 'lastValidationError' | 'metadata'> & { allowed?: boolean }, provider?: ProviderHealth | null): Availability {
  if (card.allowed === false) return { usable: false, label: 'Turned off', detail: 'Unticked on its connection, so nothing uses it.' }
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
  return { usable: false, label: 'Not available', detail: 'Check its connection again to make it available.' }
}

function trimPrice(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (n >= 100) return n.toFixed(0)
  if (n >= 1) return n.toFixed(2)
  // Cents always show two places ("0.50", not "0.5"); smaller prices keep what they need.
  const fine = n.toFixed(4)
  return fine.endsWith('00') ? fine.slice(0, -2) : fine.endsWith('0') ? fine.slice(0, -1) : fine
}

/** The price that applies: your own when set, else the provider's list price. */
export function effectivePrice(card: Pick<ModelCard, 'pricing' | 'pricingOverride'>): ModelPricing | null {
  return card.pricingOverride ?? card.pricing ?? null
}

/** A price of zero both ways: a model on a server you run, which costs nothing per token. */
export function isFree(pricing: ModelPricing | null | undefined): boolean {
  return !!pricing && pricing.inPerMTok === 0 && pricing.outPerMTok === 0
}

/**
 * "$2.50 in / $10.00 out" per million tokens, "Free" for a model that truly
 * costs nothing, and "Price unknown" when nobody knows: never a made-up $0.
 */
export function formatPrice(pricing: ModelPricing | null | undefined): string {
  if (!pricing) return 'Price unknown'
  if (isFree(pricing)) return 'Free'
  const unit = pricing.currency && pricing.currency !== 'USD' ? ` ${pricing.currency}` : ''
  return `$${trimPrice(pricing.inPerMTok)} in / $${trimPrice(pricing.outPerMTok)} out${unit}`
}

/** "128k", "1M", or empty when unknown (the cell stays blank). */
export function formatContext(n: number | null | undefined): string {
  if (!n) return ''
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
