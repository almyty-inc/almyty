import React, { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { DollarSign } from 'lucide-react'

import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { Button } from '@/components/ui/button'
import { budgetsApi, agentsApi } from '@/lib/api'
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
    </div>
  )
}
