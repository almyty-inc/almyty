import { useQuery } from '@tanstack/react-query'
import { Route } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { QueryError } from '@/components/ui/query-error'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'

/**
 * All-model failure rate: the share of requests where EVERY model tried
 * failed.
 *
 * High is bad, which the label has to carry on its own — "accuracy rate"
 * read as a number you want high, and this one you want low. It also sits
 * next to a different number on purpose: the recoverable share is what a
 * better routing policy could have won, and the two must never appear
 * under one heading.
 *
 * The number binds to coFailureRate. Bound to recoverableRate instead it
 * would read perfectly plausibly and be wrong, which is why the API names
 * the two apart rather than returning one "rate".
 */
interface AgentFailureRate {
  agentId: string
  comparableRequests: number
  allModelFailureRate: number
  recoverableRate: number
  reportable: boolean
}

interface FailureRateResponse {
  windowDays: number
  minimumRequests: number
  perAgent: AgentFailureRate[]
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`

/** Low is good here, so the colours run the other way to a success metric. */
function rateTone(rate: number): string {
  if (rate >= 0.3) return 'text-red-600 dark:text-red-400'
  if (rate >= 0.1) return 'text-amber-600 dark:text-amber-400'
  return 'text-emerald-600 dark:text-emerald-400'
}

export function RoutingTab({ agentNames = {} }: { agentNames?: Record<string, string> }) {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['analytics', 'routing-failure-rate'],
    queryFn: async () => (await api.get('/analytics/routing/failure-rate')).data.data as FailureRateResponse,
  })

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[0, 1].map((i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    )
  }

  if (isError) return <QueryError error={error} onRetry={() => refetch()} title="Couldn't load routing analytics" />

  const rows = data?.perAgent ?? []
  const reportable = rows.filter((r) => r.reportable)
  const thin = rows.filter((r) => !r.reportable)

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Route}
        title="No routed runs yet"
        description="This fills in once agents have run with more than one model available — a policy with fallbacks, or a cascade. Until then there is nothing to compare."
      />
    )
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>All-model failure rate</CardTitle>
          <CardDescription>
            The share of requests where every model tried failed. High is bad, and no routing policy recovers these — it is
            the ceiling on what better routing could ever win. Last {data?.windowDays} days.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {reportable.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="routing-no-reportable">
              Not enough comparable requests yet. An agent needs {data?.minimumRequests} requests where more than one model
              was tried before a rate means anything.
            </p>
          ) : (
            <div className="space-y-3" data-testid="routing-rates">
              {reportable.map((row) => (
                <div key={row.agentId} className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card p-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-foreground">{agentNames[row.agentId] ?? row.agentId}</div>
                    <div className="text-xs text-muted-foreground">{row.comparableRequests} comparable requests</div>
                  </div>
                  <div className="flex shrink-0 gap-6 text-right">
                    <div>
                      <div data-testid={`failure-rate-${row.agentId}`} className={`text-lg font-semibold ${rateTone(row.allModelFailureRate)}`}>
                        {pct(row.allModelFailureRate)}
                      </div>
                      <div className="text-[11px] text-muted-foreground">all models failed</div>
                    </div>
                    <div>
                      <div className="text-lg font-semibold text-foreground">{pct(row.recoverableRate)}</div>
                      {/* Labelled apart from the rate above, deliberately:
                          one is a ceiling and the other is an opportunity. */}
                      <div className="text-[11px] text-muted-foreground">a better policy could win</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {thin.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Not enough history yet</CardTitle>
            <CardDescription>
              These agents have routed, but not often enough with more than one model for a rate to mean anything. Named
              rather than hidden, so you can tell the difference between "fine" and "not measured".
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2" data-testid="routing-thin">
              {thin.map((row) => (
                <span key={row.agentId} className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {agentNames[row.agentId] ?? row.agentId} ({row.comparableRequests}/{data?.minimumRequests})
                </span>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
