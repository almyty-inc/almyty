import React, { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { DollarSign, RefreshCw, Scale } from 'lucide-react'

import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { Button } from '@/components/ui/button'
import { budgetsApi, agentsApi, providerUsageApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'

interface SpendBucket {
  periodStart: string
  spentCents: number
  runCount: number
}
interface SpendByAgent {
  agentId: string
  spentCents: number
  runCount: number
}
interface SpendSummary {
  period: 'day' | 'month'
  from: string
  totalCents: number
  timeseries: SpendBucket[]
  byAgent: SpendByAgent[]
}

interface ReconciliationRow {
  llmProviderId: string
  providerName: string
  providerType: string
  capabilitySupported: boolean
  estimateCents: number
  estimateTokens: number
  actualCents: number | null
  actualTokens: number | null
  deltaCents: number | null
  deltaPct: number | null
  note?: string
}

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`

export function CostTab() {
  const { currentOrganization } = useOrganizationStore()
  const [period, setPeriod] = useState<'day' | 'month'>('month')

  const { data, isLoading } = useQuery({
    queryKey: ['spend-summary', currentOrganization?.id, period],
    queryFn: () => budgetsApi.getSpend(period, 'day'),
    enabled: !!currentOrganization,
  })

  const { data: agentsData } = useQuery({
    queryKey: ['agents'],
    queryFn: () => agentsApi.getAll(),
    enabled: !!currentOrganization,
  })

  const summary: SpendSummary | undefined = (data as any)?.data ?? (data as any)

  const agentNameMap = useMemo(() => {
    const list = (agentsData as any)?.data ?? agentsData ?? []
    const arr = Array.isArray(list) ? list : []
    const map: Record<string, string> = {}
    arr.forEach((a: any) => {
      map[a.id] = a.name
    })
    return map
  }, [agentsData])

  const maxBucket = useMemo(
    () => Math.max(1, ...(summary?.timeseries?.map((b) => b.spentCents) ?? [0])),
    [summary],
  )

  const hasData =
    !!summary && (summary.totalCents > 0 || (summary.timeseries?.length ?? 0) > 0)

  return (
    <div>
      <div className="flex items-center gap-1 mb-4">
        <span className="text-xs text-muted-foreground mr-1">Period:</span>
        {(['day', 'month'] as const).map((p) => (
          <Button
            key={p}
            variant={period === p ? 'default' : 'ghost'}
            size="sm"
            className="h-6 text-xs px-2"
            onClick={() => setPeriod(p)}
          >
            {p === 'day' ? 'Today' : 'This month'}
          </Button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-48">
          <LoadingSpinner size="lg" />
        </div>
      ) : hasData ? (
        <div className="space-y-6">
          <div className="rounded-lg border bg-card p-5">
            <p className="text-sm text-muted-foreground">
              Total spend ({period === 'day' ? 'today' : 'this month'})
            </p>
            <p className="text-3xl font-heading font-extrabold mt-1">
              {usd(summary!.totalCents)}
            </p>
          </div>

          {/* Spend over time */}
          <div className="rounded-lg border bg-card p-5">
            <h3 className="text-sm font-medium mb-4">Spend over time</h3>
            {summary!.timeseries.length > 0 ? (
              <div className="space-y-2">
                {summary!.timeseries.map((b) => (
                  <div key={b.periodStart} className="flex items-center gap-3 text-xs">
                    <span className="w-24 shrink-0 text-muted-foreground">
                      {new Date(b.periodStart).toLocaleDateString()}
                    </span>
                    <div className="flex-1 h-4 rounded bg-muted overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-violet-500 to-cyan-400"
                        style={{ width: `${(b.spentCents / maxBucket) * 100}%` }}
                      />
                    </div>
                    <span className="w-16 shrink-0 text-right font-medium">
                      {usd(b.spentCents)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No runs in this period.</p>
            )}
          </div>

          {/* Breakdown by agent */}
          <div className="rounded-lg border bg-card">
            <div className="px-4 py-3 border-b">
              <h3 className="text-sm font-medium">Spend by agent</h3>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground bg-muted">
                  <th className="px-4 py-3 font-medium">Agent</th>
                  <th className="px-4 py-3 font-medium text-right">Runs</th>
                  <th className="px-4 py-3 font-medium text-right">Spend</th>
                </tr>
              </thead>
              <tbody>
                {summary!.byAgent.map((a) => (
                  <tr key={a.agentId} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-2.5 font-medium">
                      {agentNameMap[a.agentId] || a.agentId.slice(0, 8)}
                    </td>
                    <td className="px-4 py-2.5 text-right">{a.runCount.toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right font-medium">{usd(a.spentCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="text-center py-12">
          <DollarSign className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm font-medium text-muted-foreground">No spend data</p>
          <p className="text-xs text-muted-foreground mt-1">
            Agent run costs will appear here once your agents start running.
          </p>
        </div>
      )}

      {/* Provider actual vs our estimate (P7) */}
      <ReconciliationSection period={period} enabled={!!currentOrganization} />
    </div>
  )
}

/**
 * Reconciles almyty's own estimate (from agent/conversation spend)
 * against each provider's authoritative usage/cost API. Providers without
 * an ingestible usage API are shown greyed with a "no usage API" note.
 */
function ReconciliationSection({
  period,
  enabled,
}: {
  period: 'day' | 'month'
  enabled: boolean
}) {
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['provider-reconciliation', period],
    queryFn: () => providerUsageApi.getReconciliation(period),
    enabled,
  })

  const sync = useMutation({
    mutationFn: () => providerUsageApi.sync({}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['provider-reconciliation'] })
    },
  })

  const rows: ReconciliationRow[] =
    (data as any)?.data?.providers ?? (data as any)?.providers ?? []
  const supported = rows.filter((r) => r.capabilitySupported)
  const unsupported = rows.filter((r) => !r.capabilitySupported)

  return (
    <div className="mt-6 rounded-lg border bg-card">
      <div className="px-4 py-3 border-b flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Scale className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">Provider actual vs our estimate</h3>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          disabled={sync.isPending}
          onClick={() => sync.mutate()}
        >
          <RefreshCw
            className={`h-3 w-3 mr-1 ${sync.isPending ? 'animate-spin' : ''}`}
          />
          {sync.isPending ? 'Syncing…' : 'Sync now'}
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-24">
          <LoadingSpinner size="md" />
        </div>
      ) : rows.length === 0 ? (
        <p className="px-4 py-6 text-xs text-muted-foreground">
          No LLM providers configured. Add a provider to reconcile spend.
        </p>
      ) : (
        <>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground bg-muted">
                <th className="px-4 py-3 font-medium">Provider</th>
                <th className="px-4 py-3 font-medium text-right">Our estimate</th>
                <th className="px-4 py-3 font-medium text-right">Provider actual</th>
                <th className="px-4 py-3 font-medium text-right">Delta</th>
              </tr>
            </thead>
            <tbody>
              {supported.map((r) => {
                const hasActual = r.actualCents !== null
                const over = (r.deltaCents ?? 0) > 0
                return (
                  <tr
                    key={r.llmProviderId}
                    className="border-b last:border-0 hover:bg-muted/30"
                  >
                    <td className="px-4 py-2.5 font-medium">
                      {r.providerName}
                      <span className="ml-2 text-xs text-muted-foreground">
                        {r.providerType}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {usd(r.estimateCents)}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {hasActual ? (
                        usd(r.actualCents as number)
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {r.note ?? 'No data yet'}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right font-medium">
                      {hasActual && r.deltaCents !== null ? (
                        <span className={over ? 'text-rose-500' : 'text-emerald-500'}>
                          {over ? '+' : ''}
                          {usd(r.deltaCents)}
                          {r.deltaPct !== null ? ` (${over ? '+' : ''}${r.deltaPct}%)` : ''}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {unsupported.length > 0 && (
            <div className="px-4 py-3 border-t">
              <p className="text-xs text-muted-foreground">
                No usage API — reconciliation unavailable:{' '}
                {unsupported.map((r) => r.providerName).join(', ')}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  )
}
