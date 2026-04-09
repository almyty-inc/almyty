import React, { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Wrench } from 'lucide-react'

import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { analyticsApi, toolsApi } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useOrganizationStore } from '@/store/organization'
import type { Tool, ToolUsageEntry } from '@/types'

import { formatDate, formatMs } from './format'
import { TimeframeSelector } from './timeframe-selector'

export function ToolsTab() {
  const { currentOrganization } = useOrganizationStore()
  const [timeframe, setTimeframe] = useState('7d')

  const { data: toolUsage, isLoading } = useQuery({
    queryKey: ['analytics-tool-usage', currentOrganization?.id, timeframe],
    queryFn: () => analyticsApi.getToolUsage(timeframe),
    enabled: !!currentOrganization,
  })

  const { data: toolsRaw } = useQuery({
    queryKey: ['tools', currentOrganization?.id],
    queryFn: async () => {
      const d = await toolsApi.getAll(currentOrganization?.id)
      const result = d?.tools || (Array.isArray(d) ? d : [])
      return Array.isArray(result) ? result : []
    },
    enabled: !!currentOrganization,
  })
  const tools: Tool[] = Array.isArray(toolsRaw) ? toolsRaw : []
  const toolMap = Object.fromEntries(tools.map((t: Tool) => [t.id, t]))

  return (
    <div>
      <TimeframeSelector value={timeframe} onChange={setTimeframe} />
      {isLoading ? (
        <div className="flex items-center justify-center h-48">
          <LoadingSpinner size="lg" />
        </div>
      ) : Array.isArray(toolUsage) && toolUsage.length > 0 ? (
        <div className="rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground bg-muted">
                <th className="px-4 py-3 font-medium">Tool</th>
                <th className="px-4 py-3 font-medium text-right">Executions</th>
                <th className="px-4 py-3 font-medium text-right">Success Rate</th>
                <th className="px-4 py-3 font-medium text-right">Avg Time</th>
                <th className="px-4 py-3 font-medium text-right">Last Used</th>
              </tr>
            </thead>
            <tbody>
              {toolUsage.map((t: ToolUsageEntry) => {
                const tool = toolMap[t.toolId]
                return (
                  <tr key={t.toolId} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-2.5">
                      <Link
                        to={`/tools/${t.toolId}`}
                        className="font-medium hover:underline text-xs"
                      >
                        {tool?.name || t.toolId.slice(0, 8)}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 text-right font-medium">
                      {t.totalExecutions.toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <span
                        className={cn(
                          'font-medium',
                          t.successRate >= 90
                            ? 'text-green-600'
                            : t.successRate >= 70
                              ? 'text-yellow-600'
                              : 'text-red-600',
                        )}
                      >
                        {t.successRate}%
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right text-muted-foreground">
                      {formatMs(t.avgExecutionTime)}
                    </td>
                    <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">
                      {formatDate(t.lastUsed)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="text-center py-12">
          <Wrench className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm font-medium text-muted-foreground">No tool usage data</p>
          <p className="text-xs text-muted-foreground mt-1">
            Tool execution stats will appear here once tools are used.
          </p>
        </div>
      )}
    </div>
  )
}
