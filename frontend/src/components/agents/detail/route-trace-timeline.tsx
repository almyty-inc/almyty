import { useQuery } from '@tanstack/react-query'

import { Badge } from '@/components/ui/badge'
import { api } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'

/**
 * Where a run's requests actually went.
 *
 * Two things here are deliberately not smoothed over, because smoothing
 * them is how a trace stops being worth reading:
 *
 *  - A provider-side hop has no cost. What happens inside a provider is
 *    not ours to price, so it says "opaque" rather than "$0.00" — an
 *    invented number is worse than an admitted gap.
 *  - A provider that served something other than what was asked for is
 *    flagged. Silent substitution is the thing this exists to catch.
 */
interface RouteHop {
  layer: string
  decidedBy: string
  chosen: string
  alternatives?: string[]
  reason: string
  latencyMs?: number
  costEstimateCents?: number | null
  opaqueCost?: boolean
  requestedModel?: string
  servedModel?: string
  divergent?: boolean
  capabilitiesDropped?: string[]
}

interface RunTrace {
  executionId: string
  strategyKey?: string
  strategyChosenBy?: string
  strategyFallbackReason?: string
  steps: Array<{ nodeId: string; type?: string; durationMs?: number; error?: string; hops: RouteHop[] }>
  summary: { knownCostCents: number; opaqueHops: number; divergences: RouteHop[]; capabilitiesDropped: string[] }
}

const LAYER_TONE: Record<string, string> = {
  routing: 'border-violet-500/40 text-violet-600 dark:text-violet-400',
  provider: 'border-cyan-500/40 text-cyan-600 dark:text-cyan-400',
  strategy: 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
  orchestrator: 'border-amber-500/40 text-amber-600 dark:text-amber-400',
}

const cents = (c: number) => `$${(c / 100).toFixed(4)}`

export function RouteTraceTimeline({ agentId, executionId }: { agentId: string; executionId: string }) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['run-trace', agentId, executionId],
    queryFn: async () => (await api.get(`/agents/${agentId}/executions/${executionId}/trace`)).data.data as RunTrace,
  })

  if (isLoading) return <div data-testid="trace-loading" className="h-16 animate-pulse rounded-lg bg-muted" />

  if (isError) {
    return (
      <p data-testid="trace-error" className="text-xs text-red-600 dark:text-red-400">
        {getApiErrorMessage(error, 'Could not read this run\'s trace')}
      </p>
    )
  }

  const steps = data?.steps ?? []
  const routed = steps.filter((s) => s.hops.length > 0)

  if (routed.length === 0) {
    return (
      <p data-testid="trace-empty" className="text-xs text-muted-foreground">
        Nothing was routed in this run — every step named its model directly, so there is no routing to show.
      </p>
    )
  }

  return (
    <div data-testid="route-trace" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {data?.strategyKey && (
          <Badge variant="outline" data-testid="trace-strategy">
            strategy: {data.strategyKey}
            {data.strategyChosenBy === 'fallback' && ' (fallback)'}
          </Badge>
        )}
        <span className="text-muted-foreground">
          {cents(data?.summary.knownCostCents ?? 0)} known
          {(data?.summary.opaqueHops ?? 0) > 0 && (
            // Named rather than folded into the total: the number above is
            // what we can see, not what the run cost.
            <span data-testid="trace-opaque"> · {data?.summary.opaqueHops} hop(s) we cannot price</span>
          )}
        </span>
      </div>

      {data?.strategyFallbackReason && (
        <p data-testid="trace-fallback-reason" className="text-xs text-amber-600 dark:text-amber-400">
          The orchestrator did not choose: {data.strategyFallbackReason}
        </p>
      )}

      {(data?.summary.divergences.length ?? 0) > 0 && (
        <p data-testid="trace-divergence" className="text-xs text-amber-600 dark:text-amber-400">
          A provider served a different model than was asked for. Check the hops marked substituted.
        </p>
      )}

      <ol className="space-y-2">
        {routed.map((step) => (
          <li key={step.nodeId} className="rounded-lg border border-border bg-card p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs text-foreground">{step.nodeId}</span>
              <span className="text-[11px] text-muted-foreground">
                {step.durationMs != null ? `${step.durationMs} ms` : ''}
              </span>
            </div>

            {step.error && (
              <p data-testid={`trace-step-error-${step.nodeId}`} className="mt-1 text-[11px] text-red-600 dark:text-red-400">
                {step.error}
              </p>
            )}

            <div className="mt-2 space-y-1.5">
              {step.hops.map((hop, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2 text-[11px]">
                  <Badge variant="outline" className={LAYER_TONE[hop.layer] ?? ''}>
                    {hop.layer}
                  </Badge>
                  <span className="font-medium text-foreground">{hop.chosen}</span>
                  <span className="text-muted-foreground">{hop.reason}</span>
                  {hop.opaqueCost ? (
                    <span className="text-muted-foreground/70">cost opaque</span>
                  ) : hop.costEstimateCents != null ? (
                    <span className="text-muted-foreground/70">{cents(hop.costEstimateCents)}</span>
                  ) : null}
                  {hop.divergent && (
                    <span data-testid="hop-divergent" className="text-amber-600 dark:text-amber-400">
                      substituted {hop.requestedModel} → {hop.servedModel}
                    </span>
                  )}
                  {(hop.alternatives?.length ?? 0) > 0 && (
                    <span className="text-muted-foreground/70">over {hop.alternatives!.join(', ')}</span>
                  )}
                </div>
              ))}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}
