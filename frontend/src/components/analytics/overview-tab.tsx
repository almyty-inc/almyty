import React, { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  AlertTriangle,
  Clock,
  DollarSign,
  Globe,
  MessageSquare,
  Wrench,
} from 'lucide-react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { analyticsApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'
import type { TimelineEntry } from '@/types'

import { formatMs, formatNumber } from './format'
import { StatCard } from './stat-card'

export function OverviewTab() {
  const { currentOrganization } = useOrganizationStore()

  const { data: overview, isLoading: loadingOverview } = useQuery({
    queryKey: ['analytics-overview', currentOrganization?.id],
    queryFn: () => analyticsApi.getOverview(),
    enabled: !!currentOrganization,
    refetchInterval: 30000,
  })

  const { data: timeline } = useQuery({
    queryKey: ['analytics-timeline', currentOrganization?.id],
    queryFn: () => analyticsApi.getTimeline('7d', 'day'),
    enabled: !!currentOrganization,
  })

  const timelineData = useMemo(() => {
    if (Array.isArray(timeline) && timeline.length > 0) {
      return timeline.map((entry: TimelineEntry) => ({
        date: new Date(entry.timestamp || entry.date || '').toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
        }),
        requests: entry.requests || entry.count || 0,
      }))
    }
    const days = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      days.push({
        date: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        requests: 0,
      })
    }
    return days
  }, [timeline])

  return (
    <div>
      {loadingOverview ? (
        <div className="flex items-center justify-center h-48">
          <LoadingSpinner size="lg" />
        </div>
      ) : overview ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard icon={Globe} label="Requests (24h)" value={formatNumber(overview.last24h?.requests || 0)} />
          <StatCard
            icon={Wrench}
            label="Tool Executions (24h)"
            value={formatNumber(overview.last24h?.toolExecutions || 0)}
          />
          <StatCard
            icon={Clock}
            label="Avg Response (24h)"
            value={formatMs(overview.last24h?.avgResponseTime || 0)}
          />
          <StatCard
            icon={AlertTriangle}
            label="Errors (24h)"
            value={formatNumber(overview.last24h?.errors || 0)}
            className={overview.last24h?.errors > 0 ? 'border-red-200 bg-red-50/50' : ''}
          />
          <StatCard
            icon={MessageSquare}
            label="LLM Sessions (24h)"
            value={formatNumber(overview.last24h?.llmSessions || 0)}
          />
          <StatCard icon={Globe} label="Requests (7d)" value={formatNumber(overview.last7d?.requests || 0)} />
          <StatCard
            icon={Wrench}
            label="Tool Executions (7d)"
            value={formatNumber(overview.last7d?.toolExecutions || 0)}
          />
          <StatCard
            icon={DollarSign}
            label="LLM Cost (7d)"
            value={`$${((overview.last7d?.llmCostCents || 0) / 100).toFixed(4)}`}
          />
        </div>
      ) : (
        <div className="text-center py-12">
          <Activity className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm font-medium text-muted-foreground">No analytics data yet</p>
          <p className="text-xs text-muted-foreground mt-1">
            Usage data will appear here as you use the system.
          </p>
        </div>
      )}

      {/* Requests chart */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-lg">Requests (7 days)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-[250px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={timelineData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="date" className="text-xs" />
                <YAxis className="text-xs" />
                <Tooltip />
                <Line
                  type="monotone"
                  dataKey="requests"
                  stroke="hsl(222.2, 47.4%, 11.2%)"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
