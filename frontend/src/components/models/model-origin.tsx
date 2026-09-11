import { Cloud, KeyRound, Rocket } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import type { ModelCard } from '@/types/models'

/**
 * A card reaches the catalog three ways, and the router does not care
 * which: a vendor key you configured, an endpoint you deployed through a
 * provider, or an OpenAI-compatible endpoint you registered yourself.
 * The catalog says which, and otherwise treats all three the same.
 */
export type ModelOrigin = 'vendor' | 'deployment' | 'endpoint'

export const MODEL_ORIGIN_LABELS: Record<ModelOrigin, string> = {
  vendor: 'Vendor key',
  deployment: 'Deployed by you',
  endpoint: 'Your endpoint',
}

const ORIGIN_CLASS: Record<ModelOrigin, string> = {
  vendor: 'border-violet-500/40 text-violet-600 dark:text-violet-400',
  deployment: 'border-cyan-500/40 text-cyan-600 dark:text-cyan-400',
  endpoint: 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
}

const ORIGIN_ICON = { vendor: KeyRound, deployment: Rocket, endpoint: Cloud }

export function modelOrigin(card: Pick<ModelCard, 'endpointRef' | 'providerId'>): ModelOrigin {
  if (card.endpointRef?.deploymentId) return 'deployment'
  if (card.endpointRef?.url) return 'endpoint'
  return 'vendor'
}

/** The vendor a card belongs to, for the "several at once" count. */
export function modelVendor(card: Pick<ModelCard, 'endpointRef' | 'providerId' | 'providerType'>, providerNames: Record<string, string> = {}): string {
  if (card.providerId && providerNames[card.providerId]) return providerNames[card.providerId]
  if (card.providerType) return card.providerType
  const url = card.endpointRef?.url
  if (typeof url === 'string') {
    try {
      return new URL(url).host
    } catch {
      return url
    }
  }
  return 'Unassigned'
}

/** Where the call actually goes, in one short phrase. */
export function whereItRuns(card: Pick<ModelCard, 'endpointRef' | 'providerId' | 'providerType' | 'region'>, providerNames: Record<string, string> = {}): string {
  const vendor = modelVendor(card, providerNames)
  return card.region ? `${vendor}, ${card.region}` : vendor
}

export function ModelOriginBadge({ origin }: { origin: ModelOrigin }) {
  const Icon = ORIGIN_ICON[origin]
  return (
    <Badge variant="outline" className={`gap-1 px-1.5 py-0 text-[10px] font-normal ${ORIGIN_CLASS[origin]}`}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {MODEL_ORIGIN_LABELS[origin]}
    </Badge>
  )
}
