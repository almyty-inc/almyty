import { Cloud, KeyRound, Server } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { MODEL_SOURCE_LABELS, type ModelSource } from '@/lib/model-hosting'
import type { ModelCard } from '@/types/models'

export { MODEL_SOURCE_LABELS, modelSource, runsOn, type ModelSource } from '@/lib/model-hosting'

const SOURCE_CLASS: Record<ModelSource, string> = {
  provider: 'border-violet-500/40 text-violet-600 dark:text-violet-400',
  cloud: 'border-cyan-500/40 text-cyan-600 dark:text-cyan-400',
  server: 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
}

const SOURCE_ICON = { provider: KeyRound, cloud: Cloud, server: Server }

/**
 * Where a model runs, as a small badge: a provider's API, a server you run,
 * or your own cloud account. The router does not care which; the badge is
 * the only difference between them in the list.
 */
export function ModelSourceBadge({ source }: { source: ModelSource }) {
  const Icon = SOURCE_ICON[source]
  return (
    <Badge variant="outline" className={`gap-1 px-1.5 py-0 text-[10px] font-normal ${SOURCE_CLASS[source]}`}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {MODEL_SOURCE_LABELS[source]}
    </Badge>
  )
}

/** The vendor a card belongs to, for the "several at once" count in the routing set. */
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