import React, { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Zap } from 'lucide-react'

import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { ProtocolBadge } from '@/components/ui/protocol-badge'
import { QueryError } from '@/components/ui/query-error'
import { analyticsApi } from '@/lib/api'
import { gatewaysQuery } from '@/lib/list-queries'
import { cn } from '@/lib/utils'
import { useOrganizationStore } from '@/store/organization'
import type { Gateway, GatewayUsageEntry } from '@/types'

import { TABLE_HEAD_CLASS as TH } from './constants'
import { TimeframeSelector } from './timeframe-selector'

export function GatewaysTab() {
  const { currentOrganization } = useOrganizationStore()
  const [timeframe, setTimeframe] = useState('7d')

  const { data: gatewayUsage, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['analytics-gateway-usage', currentOrganization?.id, timeframe],
    queryFn: () => analyticsApi.getGatewayUsage(timeframe),
    enabled: !!currentOrganization,
  })

  const { data: gatewaysPage } = useQuery({
    ...gatewaysQuery(currentOrganization?.id),
    enabled: !!currentOrganization,
  })
  const gateways: Gateway[] = gatewaysPage?.items ?? []
  const gatewayMap = Object.fromEntries(gateways.map((g: Gateway) => [g.id, g]))

  return (
    <div>
      <TimeframeSelector value={timeframe} onChange={setTimeframe} />
      {isLoading ? (
        <div className="flex items-center justify-center h-48">
          <LoadingSpinner size="lg" />
        </div>
      ) : isError ? (
        // A failed fetch used to fall through to the empty branch, so a
        // broken request read as "no gateway usage data" and there was
        // nothing to retry with.
        <QueryError error={error} onRetry={() => refetch()} title="Couldn't load gateway usage" />
      ) : Array.isArray(gatewayUsage) && gatewayUsage.length > 0 ? (
        <div className="rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left bg-muted">
                <th className={TH}>Gateway</th>
                <th className={TH}>Protocol</th>
                <th className={`${TH} text-right`}>Requests</th>
                <th className={`${TH} text-right`}>Success</th>
                <th className={`${TH} text-right`}>Errors</th>
                <th className={`${TH} text-right`}>Success rate</th>
              </tr>
            </thead>
            <tbody>
              {gatewayUsage.map((g: GatewayUsageEntry) => {
                const gateway = gatewayMap[g.gatewayId]
                return (
                  <tr key={g.gatewayId} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <Link to={`/gateways/${g.gatewayId}`} className="font-medium hover:underline text-sm">
                        {gateway?.name || g.gatewayId.slice(0, 8)}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      {gateway?.type ? <ProtocolBadge protocol={gateway.type} /> : '--'}
                    </td>
                    <td className="px-4 py-3 text-right font-medium">
                      {g.totalRequests.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right text-green-600 dark:text-green-400">
                      {g.successCount.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right text-red-600 dark:text-red-400">
                      {g.errorCount.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span
                        className={cn(
                          'font-medium',
                          g.successRate >= 90
                            ? 'text-green-600 dark:text-green-400'
                            : g.successRate >= 70
                              ? 'text-yellow-600 dark:text-yellow-400'
                              : 'text-red-600 dark:text-red-400',
                        )}
                      >
                        {g.successRate}%
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="text-center py-12">
          <Zap className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm font-medium text-muted-foreground">No gateway usage data</p>
          <p className="text-xs text-muted-foreground mt-1">
            Gateway traffic stats will appear here once gateways receive requests.
          </p>
        </div>
      )}
    </div>
  )
}
