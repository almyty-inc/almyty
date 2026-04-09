import React, { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Globe } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { analyticsApi } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useOrganizationStore } from '@/store/organization'
import type { RequestLog } from '@/types'

import { protocolColors, statusColors } from './constants'
import { formatMs } from './format'

export function RequestLogTab() {
  const { currentOrganization } = useOrganizationStore()
  const [logPage, setLogPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState('')

  const { data: requestLogs, isLoading: loadingLogs } = useQuery({
    queryKey: ['analytics-requests', currentOrganization?.id, logPage, statusFilter],
    queryFn: async () => {
      const params: Record<string, string> = { page: String(logPage), limit: '25' }
      if (statusFilter) params.status = statusFilter
      return analyticsApi.getRequestLogs(params)
    },
    enabled: !!currentOrganization,
  })

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xs text-muted-foreground">Filter:</span>
        <div className="flex gap-1">
          {[
            { value: '', label: 'All' },
            { value: 'success', label: 'Success' },
            { value: 'error', label: 'Error' },
          ].map((f) => (
            <Button
              key={f.value || 'all'}
              variant={statusFilter === f.value ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                setStatusFilter(f.value)
                setLogPage(1)
              }}
            >
              {f.label}
            </Button>
          ))}
        </div>
      </div>

      {loadingLogs ? (
        <div className="flex items-center justify-center h-48">
          <LoadingSpinner size="lg" />
        </div>
      ) : requestLogs?.data?.length > 0 ? (
        <>
          <div className="rounded-lg border bg-card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground bg-muted">
                  <th className="px-3 py-2 font-medium">Time</th>
                  <th className="px-3 py-2 font-medium">Method</th>
                  <th className="px-3 py-2 font-medium">Path</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium text-right">Duration</th>
                  <th className="px-3 py-2 font-medium">Protocol</th>
                  <th className="px-3 py-2 font-medium">IP</th>
                </tr>
              </thead>
              <tbody>
                {requestLogs.data.map((log: RequestLog) => (
                  <tr key={log.id} className="border-b last:border-0 hover:bg-muted/30 text-xs">
                    <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                      {new Date(log.timestamp).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 font-mono font-medium">{log.method}</td>
                    <td className="px-3 py-2 font-mono text-muted-foreground max-w-[300px] truncate">
                      {log.path}
                    </td>
                    <td className="px-3 py-2">
                      <span className={cn('font-medium', statusColors[String(log.statusCode)[0]] || '')}>
                        {log.statusCode}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right text-muted-foreground">{formatMs(log.responseTime)}</td>
                    <td className="px-3 py-2">
                      {log.protocol ? (
                        <Badge
                          variant="outline"
                          className={cn('text-[10px] uppercase px-1.5 py-0', protocolColors[log.protocol])}
                        >
                          {log.protocol}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">--</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground font-mono">{log.ipAddress || '--'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between mt-3">
            <span className="text-xs text-muted-foreground">
              Page {requestLogs.page} of {requestLogs.pages} ({requestLogs.total} total)
            </span>
            <div className="flex gap-1">
              <Button variant="outline" size="sm" disabled={logPage <= 1} onClick={() => setLogPage((p) => p - 1)}>
                Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={logPage >= requestLogs.pages}
                onClick={() => setLogPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      ) : (
        <div className="text-center py-12">
          <Globe className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm font-medium text-muted-foreground">No request logs yet</p>
          <p className="text-xs text-muted-foreground mt-1">
            Logs are recorded automatically as API requests come in.
          </p>
        </div>
      )}
    </div>
  )
}
