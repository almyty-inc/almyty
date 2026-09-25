import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Receipt } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { QueryError } from '@/components/ui/query-error'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { EntitlementGate } from '@/components/entitlement-gate'
import { UpgradePrompt } from '@/components/plan-indicator'
import { useTeamLookup } from '@/components/ui/team-filter'
import { useOrganizationStore } from '@/store/organization'
import { agentsQuery } from '@/lib/list-queries'

/**
 * Who spent what: cost per team and per agent, plus a projection.
 *
 * The backend for this has been complete and unreachable — a report
 * nobody could open is not a feature. The forecast is the part to be
 * careful with: it is a straight-line fit over the buckets so far, and
 * says so, because a projection presented as a fact is how someone
 * budgets off a number that was never a promise.
 */
interface SpendRow {
  spentCents: number
  runCount: number
}

interface ChargebackReport {
  window: { period: 'day' | 'month'; from: string; to: string | null }
  totalCents: number
  byTeam: Array<SpendRow & { teamId: string | null }>
  byAgent: Array<SpendRow & { agentId: string }>
  timeseries: Array<{ periodStart: string; spentCents: number; runCount: number }>
  forecast: { projectedCents: number; perPeriodCents: number; periodsAhead: number; basis: 'linear' | 'insufficient-data' }
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`

const CHARGEBACK_FEATURE = 'chargeback'

/**
 * Gated the same way every other EE surface is: an organization without
 * the entitlement sees the upgrade prompt and no /chargeback request is
 * ever fired, so the 402 the guard would return never reaches a person as
 * a broken screen.
 */
export function ChargebackTab(props: { teamNames?: Record<string, string>; agentNames?: Record<string, string> }) {
  return (
    <EntitlementGate
      feature={CHARGEBACK_FEATURE}
      mode="lock"
      fallback={
        <UpgradePrompt
          feature={CHARGEBACK_FEATURE}
          title="Cost attribution and chargeback"
          description="See what each team and each agent spent, and a projection for the rest of the period, so cost can be charged back rather than estimated."
        />
      }
    >
      <ChargebackReportView {...props} />
    </EntitlementGate>
  )
}

function ChargebackReportView({
  teamNames: teamNamesProp,
  agentNames: agentNamesProp,
}: {
  teamNames?: Record<string, string>
  agentNames?: Record<string, string>
}) {
  // Resolved here rather than waited for from a parent.
  //
  // analytics.tsx renders <ChargebackTab /> with no props, and both
  // labels fall back to the raw id -- so "who spent what" came out as a
  // column of uuids against dollar amounts, which is the one thing this
  // report exists not to be. A caller may still pass names in; nothing
  // does today.
  const { currentOrganization } = useOrganizationStore()
  const { byId: teamsById } = useTeamLookup(currentOrganization?.id)
  const { data: agentList } = useQuery({
    ...agentsQuery(currentOrganization?.id),
    enabled: !!currentOrganization,
  })

  const teamNames = useMemo(
    () => teamNamesProp ?? Object.fromEntries(Object.entries(teamsById).map(([id, t]) => [id, t.name])),
    [teamNamesProp, teamsById],
  )
  const agentNames = useMemo(() => {
    if (agentNamesProp) return agentNamesProp
    return Object.fromEntries((agentList ?? []).map((a: any) => [a.id, a.name]))
  }, [agentNamesProp, agentList])

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['analytics', 'chargeback'],
    queryFn: async () => (await api.get('/chargeback/report')).data.data as ChargebackReport,
  })

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[0, 1].map((i) => (
          <Skeleton key={i} className="h-28 w-full" />
        ))}
      </div>
    )
  }

  if (isError) return <QueryError error={error} onRetry={() => refetch()} title="Couldn't load the chargeback report" />

  if (!data || data.totalCents === 0) {
    return (
      <EmptyState
        icon={Receipt}
        title="Nothing has been spent this period"
        description="Cost is attributed as agents run. Once there is spend, this shows it per team and per agent, with a projection for the rest of the period."
      />
    )
  }

  const rows = (
    entries: Array<SpendRow & { label: string }>,
  ) =>
    [...entries]
      .sort((a, b) => b.spentCents - a.spentCents)
      .map((row) => {
        // Share of the total, so a reader can see where the money went
        // without doing arithmetic against the header.
        const share = data.totalCents > 0 ? (row.spentCents / data.totalCents) * 100 : 0
        return (
          <div key={row.label} className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card p-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-foreground">{row.label}</div>
              <div className="text-xs text-muted-foreground">{row.runCount} run{row.runCount === 1 ? '' : 's'}</div>
            </div>
            <div className="shrink-0 text-right">
              <div className="text-sm font-semibold text-foreground">{money(row.spentCents)}</div>
              <div className="text-[11px] text-muted-foreground">{share.toFixed(1)}%</div>
            </div>
          </div>
        )
      })

  return (
    <div className="space-y-4" data-testid="chargeback">
      <Card>
        <CardHeader>
          <CardTitle data-testid="chargeback-total">{money(data.totalCents)} this {data.window.period}</CardTitle>
          <CardDescription>
            {data.forecast.basis === 'insufficient-data' ? (
              // Named rather than shown as zero: "no projection yet" and
              // "we project nothing" are different statements.
              <span data-testid="forecast-none">
                Not enough history to project the rest of the period yet.
              </span>
            ) : (
              <span data-testid="forecast">
                Projected {money(data.forecast.projectedCents)} over the next {data.forecast.periodsAhead}{' '}
                {data.forecast.periodsAhead === 1 ? 'period' : 'periods'}, from a straight-line fit over the buckets so far —
                a trend, not a commitment.
              </span>
            )}
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">By team</CardTitle>
          <CardDescription>Agents that belong to no team are shown as organization-wide.</CardDescription>
        </CardHeader>
        <CardContent>
          {data.byTeam.length === 0 ? (
            <p className="text-sm text-muted-foreground">No team has spent anything this period.</p>
          ) : (
            <div className="space-y-2" data-testid="chargeback-teams">
              {rows(
                data.byTeam.map((t) => ({
                  ...t,
                  label: t.teamId ? (teamNames[t.teamId] ?? t.teamId) : 'Organization-wide',
                })),
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">By agent</CardTitle>
        </CardHeader>
        <CardContent>
          {data.byAgent.length === 0 ? (
            <p className="text-sm text-muted-foreground">No agent has spent anything this period.</p>
          ) : (
            <div className="space-y-2" data-testid="chargeback-agents">
              {rows(data.byAgent.map((a) => ({ ...a, label: agentNames[a.agentId] ?? a.agentId })))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
