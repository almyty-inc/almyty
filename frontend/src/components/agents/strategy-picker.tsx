import { Check, Workflow } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { cn } from '@/lib/utils'

/**
 * Choosing an execution shape.
 *
 * A strategy never names a model, so this surface never shows one. What it
 * shows is the shape, the role slots it needs, and coarse cost and latency
 * bands. The bands are coarse because a precise number would be a lie:
 * cost depends on which models fill the slots, and this layer does not
 * know that. See docs/design/layers.md, L5.
 */
export interface StrategyView {
  key: string
  displayName: string
  description: string
  roleSlots: string[]
  steps: number
  costBand: 'low' | 'medium' | 'high'
  latencyBand: 'low' | 'medium' | 'high'
  builtIn: boolean
  /**
   * Offered without a claim that it pays off. See docs/strategies.md: the
   * saving is workload-dependent, so the picker says so rather than
   * letting the cost band imply a promise.
   */
  experimental?: boolean
}

export interface StrategyPickerProps {
  strategies: StrategyView[]
  selectedKey?: string
  /** Role keys defined on this agent, to show which slots can be filled. */
  availableRoles?: string[]
  onSelect?: (key: string) => void
  onEject?: (key: string) => void
  loading?: boolean
  error?: string
}

const BAND_CLASS: Record<StrategyView['costBand'], string> = {
  low: 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
  medium: 'border-amber-500/40 text-amber-600 dark:text-amber-400',
  high: 'border-rose-500/40 text-rose-600 dark:text-rose-400',
}

export function StrategyPicker({
  strategies,
  selectedKey,
  availableRoles = [],
  onSelect,
  onEject,
  loading,
  error,
}: StrategyPickerProps) {
  if (loading) {
    return (
      <div data-testid="strategies-loading" className="space-y-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-20 animate-pulse rounded-lg border border-border bg-card" />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div data-testid="strategies-error" className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-600 dark:text-red-400">
        {error}
      </div>
    )
  }

  if (strategies.length === 0) {
    return (
      <EmptyState
        icon={Workflow}
        title="No strategies available"
        description="A strategy is the shape of the work: one call, a cascade, several candidates and a judge. The built-in shapes should always be here, so an empty list means the catalog could not be read."
      />
    )
  }

  return (
    <div data-testid="strategy-picker" className="space-y-2">
      {strategies.map((s) => {
        const selected = s.key === selectedKey
        const unfillable = s.roleSlots.filter((slot) => !availableRoles.includes(slot))
        return (
          <button
            key={s.key}
            type="button"
            role="radio"
            aria-checked={selected}
            data-testid={`strategy-${s.key}`}
            onClick={() => onSelect?.(s.key)}
            className={cn(
              'w-full rounded-lg border p-3 text-left transition-colors hover:bg-accent',
              selected ? 'border-primary bg-primary/5 ring-1 ring-primary/40' : 'border-border',
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-foreground">{s.displayName}</span>
              <span className="flex shrink-0 items-center gap-1">
                {s.experimental && (
                  <Badge
                    variant="outline"
                    data-testid={`strategy-experimental-${s.key}`}
                    className="border-violet-500/40 text-violet-600 dark:text-violet-400"
                  >
                    experimental
                  </Badge>
                )}
                <Badge variant="outline" className={BAND_CLASS[s.costBand]}>
                  cost {s.costBand}
                </Badge>
                <Badge variant="outline" className={BAND_CLASS[s.latencyBand]}>
                  latency {s.latencyBand}
                </Badge>
                {selected && <Check className="h-4 w-4 text-primary" aria-hidden="true" />}
              </span>
            </div>

            <p className="mt-1 text-xs text-muted-foreground">{s.description}</p>

            {s.experimental && (
              // The cost band alone would read as a promise. It is not one:
              // whether this shape saves anything depends on the price gap
              // between the slots and on your own traffic.
              <p data-testid={`strategy-caveat-${s.key}`} className="mt-1 text-[11px] text-violet-600 dark:text-violet-400">
                Not claimed to be cheaper. Run it against your own traffic and check the all-model failure rate first: the higher that is, the less any extra model can win.
              </p>
            )}

            <div className="mt-2 flex flex-wrap gap-1">
              {s.roleSlots.map((slot) => (
                <span
                  key={slot}
                  className={cn(
                    'rounded px-1.5 py-0.5 text-[10px]',
                    availableRoles.includes(slot)
                      ? 'bg-muted text-muted-foreground'
                      : 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
                  )}
                >
                  {slot}
                </span>
              ))}
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{s.steps} steps</span>
            </div>

            {unfillable.length > 0 && (
              // Said before the run rather than after it fails: the picker
              // knows which slots this agent cannot fill.
              <p data-testid={`strategy-unfillable-${s.key}`} className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
                This agent has no role for {unfillable.join(', ')}. Add {unfillable.length > 1 ? 'those roles' : 'that role'} before using it.
              </p>
            )}
          </button>
        )
      })}

      {selectedKey && onEject && (
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          onClick={() => onEject(selectedKey)}
          data-testid="eject-strategy"
        >
          Eject to an editable graph
        </Button>
      )}
    </div>
  )
}
