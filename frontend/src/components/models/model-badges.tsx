import React from 'react'
import { CheckCircle2, XCircle, CircleDashed } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import {
  MODEL_CAPABILITY_KEYS,
  MODEL_CAPABILITY_LABELS,
  MODEL_PRIVACY_TIER_LABELS,
  type ModelCapabilities,
  type ModelCard,
  type ModelPrivacyTier,
} from '@/types/models'

/** One small outline badge per enabled capability. */
export function CapabilityBadges({ capabilities }: { capabilities: ModelCapabilities | null | undefined }) {
  const enabled = MODEL_CAPABILITY_KEYS.filter((key) => capabilities?.[key])
  if (enabled.length === 0) {
    return <span className="text-xs text-muted-foreground">None</span>
  }
  return (
    <div className="flex flex-wrap gap-1">
      {enabled.map((key) => (
        <Badge key={key} variant="outline" className="text-[10px] px-1.5 py-0 font-normal">
          {MODEL_CAPABILITY_LABELS[key]}
        </Badge>
      ))}
    </div>
  )
}

const TIER_CLASS: Record<ModelPrivacyTier, string> = {
  local: 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
  private_cloud: 'border-violet-500/40 text-violet-600 dark:text-violet-400',
  public: 'border-zinc-500/40 text-zinc-600 dark:text-zinc-400',
}

export function PrivacyTierBadge({ tier }: { tier: ModelPrivacyTier }) {
  return (
    <Badge variant="outline" className={`text-[10px] px-1.5 py-0 font-normal ${TIER_CLASS[tier] || ''}`}>
      {MODEL_PRIVACY_TIER_LABELS[tier] || tier}
    </Badge>
  )
}

/**
 * Validation verdict. A failed run keeps its error on the card; the badge
 * carries it as a native title so a hover explains the failure.
 */
export function ValidationBadge({ card }: { card: Pick<ModelCard, 'validationStatus' | 'lastValidationError' | 'lastValidatedAt'> }) {
  if (card.validationStatus === 'passed') {
    return (
      <Badge variant="success" className="gap-1" title={card.lastValidatedAt ? `Validated ${new Date(card.lastValidatedAt).toLocaleString()}` : undefined}>
        <CheckCircle2 className="h-3 w-3" />
        Passed
      </Badge>
    )
  }
  if (card.validationStatus === 'failed') {
    return (
      <Badge
        variant="destructive"
        className="gap-1 cursor-help"
        title={card.lastValidationError || 'Validation failed'}
        aria-label={card.lastValidationError ? `Validation failed: ${card.lastValidationError}` : 'Validation failed'}
      >
        <XCircle className="h-3 w-3" />
        Failed
      </Badge>
    )
  }
  return (
    <Badge variant="secondary" className="gap-1" title="No validation run yet">
      <CircleDashed className="h-3 w-3" />
      Not validated
    </Badge>
  )
}

/** The support rule in one glyph: selectable cards are the ones the router may pick. */
export function SelectableIndicator({ selectable }: { selectable: boolean }) {
  return selectable ? (
    <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400" title="Usable by agents and the router">
      <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden />
      Selectable
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title="Needs status active, a provider or endpoint, and a passing validation run">
      <span className="h-2 w-2 rounded-full bg-zinc-400" aria-hidden />
      Not selectable
    </span>
  )
}
