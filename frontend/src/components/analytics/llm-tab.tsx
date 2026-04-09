import React, { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { MessageSquare } from 'lucide-react'

import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { analyticsApi, llmProvidersApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'
import type { LlmUsageEntry } from '@/types'

import { formatNumber } from './format'
import { TimeframeSelector } from './timeframe-selector'

export function LlmTab() {
  const { currentOrganization } = useOrganizationStore()
  const [timeframe, setTimeframe] = useState('7d')

  const { data: llmUsage, isLoading } = useQuery({
    queryKey: ['analytics-llm-usage', currentOrganization?.id, timeframe],
    queryFn: () => analyticsApi.getLlmUsage(timeframe),
    enabled: !!currentOrganization,
  })

  const { data: llmProvidersData } = useQuery({
    queryKey: ['llm-providers'],
    queryFn: () => llmProvidersApi.getAll(),
    enabled: !!currentOrganization,
  })

  const providerNameMap = useMemo(() => {
    const providers = llmProvidersData?.providers || llmProvidersData || []
    const arr = Array.isArray(providers) ? providers : []
    const map: Record<string, string> = {}
    arr.forEach((p: any) => {
      map[p.id] = p.name
    })
    return map
  }, [llmProvidersData])

  return (
    <div>
      <TimeframeSelector value={timeframe} onChange={setTimeframe} />
      {isLoading ? (
        <div className="flex items-center justify-center h-48">
          <LoadingSpinner size="lg" />
        </div>
      ) : Array.isArray(llmUsage) && llmUsage.length > 0 ? (
        <div className="rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground bg-muted">
                <th className="px-4 py-3 font-medium">Provider</th>
                <th className="px-4 py-3 font-medium text-right">Sessions</th>
                <th className="px-4 py-3 font-medium text-right">Messages</th>
                <th className="px-4 py-3 font-medium text-right">Input Tokens</th>
                <th className="px-4 py-3 font-medium text-right">Output Tokens</th>
                <th className="px-4 py-3 font-medium text-right">Tool Calls</th>
                <th className="px-4 py-3 font-medium text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {llmUsage.map((l: LlmUsageEntry) => (
                <tr key={l.providerId} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-2.5 font-medium text-sm">
                    {providerNameMap[l.providerId] || l.providerId.slice(0, 8)}
                  </td>
                  <td className="px-4 py-2.5 text-right">{l.sessionCount.toLocaleString()}</td>
                  <td className="px-4 py-2.5 text-right">{l.totalMessages.toLocaleString()}</td>
                  <td className="px-4 py-2.5 text-right text-muted-foreground">
                    {formatNumber(l.totalInputTokens)}
                  </td>
                  <td className="px-4 py-2.5 text-right text-muted-foreground">
                    {formatNumber(l.totalOutputTokens)}
                  </td>
                  <td className="px-4 py-2.5 text-right">{l.totalToolCalls.toLocaleString()}</td>
                  <td className="px-4 py-2.5 text-right font-medium">
                    ${(l.totalCostCents / 100).toFixed(4)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="text-center py-12">
          <MessageSquare className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm font-medium text-muted-foreground">No LLM usage data</p>
          <p className="text-xs text-muted-foreground mt-1">
            LLM session and cost data will appear here once AI models are used.
          </p>
        </div>
      )}
    </div>
  )
}
