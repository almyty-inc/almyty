import React, { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Zap } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { analyticsApi, gatewaysApi } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useOrganizationStore } from '@/store/organization'
import type { Gateway, GatewayUsageEntry } from '@/types'

import { protocolColors } from './constants'
import { TimeframeSelector } from './timeframe-selector'

export function GatewaysTab() {
  const { currentOrganization } = useOrganizationStore()
  const [timeframe, setTimeframe] = useState('7d')

  const { data: gatewayUsage, isLoading } = useQuery({
    queryKey: ['analytics-gateway-usage', currentOrganization?.id, timeframe],
    queryFn: () => analyticsApi.getGatewayUsage(timeframe),
    enabled: !!currentOrganization,
  })

  const { data: gatewaysRaw } = useQuery({
    queryKey: ['gateways', currentOrganization?.id],
    queryFn: async () => {
      const d = await gatewaysApi.getAll()
      const result = d?.gateways || (Array.isArray(d) ? d : [])
      return Array.isArray(result) ? result : []
    },
    enabled: !!currentOrganization,
  })
  const gateways: Gateway[] = Array.isArray(gatewaysRaw) ? gatewaysRaw : []
  const gatewayMap = Object.fromEntries(gateways.map((g: Gateway) => [g.id, g]))

  return (
    <div>
      <TimeframeSelector value={timeframe} onChange={setTimeframe} />
      {isLoading ? (
        <div className="flex items-center justify-center h-48">
          <LoadingSpinner size="lg" />
        </div>
      ) : Array.isArray(gatewayUsage) && gatewayUsage.length > 0 ? (
        <div className="rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground bg-muted">
                <th className="px-4 py-3 font-medium">Gateway</th>
                <th className="px-4 py-3 font-medium">Protocol</th>
                <th className="px-4 py-3 font-medium text-right">Requests</th>
                <th className="px-4 py-3 font-medium text-right">Success</th>
                <th className="px-4 py-3 font-medium text-right">Errors</th>
                <th className="px-4 py-3 font-medium text-right">Success Rate</th>
              </tr>
            </thead>
            <tbody>
              {gatewayUsage.map((g: GatewayUsageEntry) => {
                const gateway = gatewayMap[g.gatewayId]
                return (
                  <tr key={g.gatewayId} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-2.5">
                      <Link to={`/gateways/${g.gatewayId}`} className="font-medium hover:underline text-sm">
                        {gateway?.name || g.gatewayId.slice(0, 8)}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5">
                      {gateway?.type ? (
                        <Badge
                          variant="outline"
                          className={cn('text-xs uppercase', protocolColors[gateway.type])}
                        >
                          {gateway.type}
                        </Badge>
                      ) : (
                        '--'
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right font-medium">
                      {g.totalRequests.toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 text-right text-green-600">
                      {g.successCount.toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 text-right text-red-600">
                      {g.errorCount.toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <span
                        className={cn(
                          'font-medium',
                          g.successRate >= 90
                            ? 'text-green-600'
                            : g.successRate >= 70
                              ? 'text-yellow-600'
                              : 'text-red-600',
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
