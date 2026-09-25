import React, { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Wrench } from 'lucide-react'

import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'
import { analyticsApi } from '@/lib/api'
import { toolsQuery } from '@/lib/list-queries'
import { cn } from '@/lib/utils'
import { useOrganizationStore } from '@/store/organization'
import type { Tool, ToolUsageEntry } from '@/types'

import { TABLE_HEAD_CLASS as TH } from './constants'
import { formatDate, formatMs } from './format'
import { TimeframeSelector } from './timeframe-selector'

export function ToolsTab() {
  const { currentOrganization } = useOrganizationStore()
  const [timeframe, setTimeframe] = useState('7d')

  const { data: toolUsage, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['analytics-tool-usage', currentOrganization?.id, timeframe],
    queryFn: () => analyticsApi.getToolUsage(timeframe),
    enabled: !!currentOrganization,
  })

  const { data: toolsPage } = useQuery({
    ...toolsQuery(currentOrganization?.id),
    enabled: !!currentOrganization,
  })
  const tools: Tool[] = toolsPage?.items ?? []
  const toolMap = Object.fromEntries(tools.map((t: Tool) => [t.id, t]))

  return (
    <div>
      <TimeframeSelector value={timeframe} onChange={setTimeframe} />
      {isLoading ? (
        <div className="flex items-center justify-center h-48">
          <LoadingSpinner size="lg" />
        </div>
      ) : isError ? (
        // Without this branch a failed fetch fell through to the empty
        // state and reported "no tool usage data" for a broken request.
        <QueryError error={error} onRetry={() => refetch()} title="Couldn't load tool usage" />
      ) : Array.isArray(toolUsage) && toolUsage.length > 0 ? (
        <div className="rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left bg-muted">
                <th className={TH}>Tool</th>
                <th className={`${TH} text-right`}>Executions</th>
                <th className={`${TH} text-right`}>Success rate</th>
                <th className={`${TH} text-right`}>Avg time</th>
                <th className={`${TH} text-right`}>Last used</th>
              </tr>
            </thead>
            <tbody>
              {toolUsage.map((t: ToolUsageEntry) => {
                const tool = toolMap[t.toolId]
                return (
                  <tr key={t.toolId} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <Link
                        to={`/tools/${t.toolId}`}
                        className="font-medium hover:underline text-sm"
                      >
                        {tool?.name || t.toolId.slice(0, 8)}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-right font-medium">
                      {t.totalExecutions.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span
                        className={cn(
                          'font-medium',
                          t.successRate >= 90
                            ? 'text-green-600 dark:text-green-400'
                            : t.successRate >= 70
                              ? 'text-yellow-600 dark:text-yellow-400'
                              : 'text-red-600 dark:text-red-400',
                        )}
                      >
                        {t.successRate}%
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-muted-foreground">
                      {formatMs(t.avgExecutionTime)}
                    </td>
                    <td className="px-4 py-3 text-right text-xs text-muted-foreground">
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
