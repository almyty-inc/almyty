import React, { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  Zap,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Wrench,
  Brain,
  Globe,
  Shield,
  Cpu,
  HardDrive,
  Timer,
  ArrowUp,
  ArrowDown,
  RefreshCw,
  Wifi,
  Server,
  BarChart3,
  TrendingUp,
  Eye,
  ShieldAlert,
  Lock,
  Ban,
  Radio,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { analyticsApi } from '@/lib/api'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { cn } from '@/lib/utils'

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h ${mins}m`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`
  return `${(bytes / 1073741824).toFixed(2)} GB`
}

function formatMs(ms: number): string {
  if (ms < 1) return '<1ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function StatusDot({ status }: { status: 'healthy' | 'degraded' | 'down' }) {
  return (
    <span className={cn(
      'inline-block w-2.5 h-2.5 rounded-full',
      status === 'healthy' && 'bg-green-500 animate-pulse',
      status === 'degraded' && 'bg-yellow-500 animate-pulse',
      status === 'down' && 'bg-red-500',
    )} />
  )
}

function MetricCard({ label, value, sub, icon: Icon, color = 'blue' }: {
  label: string
  value: string | number
  sub?: string
  icon: any
  color?: 'blue' | 'green' | 'purple' | 'orange' | 'red' | 'gray'
}) {
  const colorMap = {
    blue: 'bg-blue-50 text-blue-600',
    green: 'bg-green-50 text-green-600',
    purple: 'bg-purple-50 text-purple-600',
    orange: 'bg-orange-50 text-orange-600',
    red: 'bg-red-50 text-red-600',
    gray: 'bg-gray-50 text-gray-600',
  }
  return (
    <div className="flex items-center gap-3 p-3 rounded-lg border bg-white">
      <div className={cn('p-2 rounded-lg', colorMap[color])}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground truncate">{label}</div>
        <div className="text-lg font-semibold leading-tight">{value}</div>
        {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
      </div>
    </div>
  )
}

function ProgressBar({ value, max, color = 'blue', label }: {
  value: number; max: number; color?: string; label?: string
}) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0
  const colorClass = {
    blue: 'bg-blue-500',
    green: 'bg-green-500',
    purple: 'bg-purple-500',
    orange: 'bg-orange-500',
    red: 'bg-red-500',
    emerald: 'bg-emerald-500',
  }[color] || 'bg-blue-500'

  return (
    <div className="space-y-1">
      {label && (
        <div className="flex justify-between text-xs">
          <span className="text-muted-foreground">{label}</span>
          <span className="font-medium">{pct.toFixed(1)}%</span>
        </div>
      )}
      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className={cn('h-full rounded-full transition-all', colorClass)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export function AnalyticsPage() {
  const [refreshInterval, setRefreshInterval] = useState(5000)

  // Live stats - auto-refreshes
  const { data: liveStats, isLoading: loadingLive, dataUpdatedAt: liveUpdatedAt } = useQuery({
    queryKey: ['monitoring-live'],
    queryFn: async () => {
      const response = await analyticsApi.getLiveStats()
      return response.data
    },
    refetchInterval: refreshInterval,
    retry: 1,
  })

  // System metrics
  const { data: metrics, isLoading: loadingMetrics } = useQuery({
    queryKey: ['monitoring-metrics'],
    queryFn: async () => {
      const response = await analyticsApi.getMetrics()
      return response.data
    },
    refetchInterval: refreshInterval,
    retry: 1,
  })

  // Active alerts
  const { data: alerts = [] } = useQuery({
    queryKey: ['monitoring-alerts'],
    queryFn: async () => {
      try {
        const response = await analyticsApi.getAlerts()
        return response.data?.data || response.data || []
      } catch { return [] }
    },
    refetchInterval: 15000,
  })

  // Enterprise dashboard (SLA, compliance)
  const { data: dashboard } = useQuery({
    queryKey: ['monitoring-dashboard'],
    queryFn: async () => {
      try {
        const response = await analyticsApi.getDashboard()
        return response.data
      } catch { return null }
    },
    refetchInterval: 30000,
  })

  const isLoading = loadingLive && loadingMetrics

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  const sys = metrics?.system || {}
  const app = metrics?.application || {}
  const proto = liveStats?.protocols || metrics?.protocols || {}
  const perf = liveStats?.performance || metrics?.performance || {}
  const sec = liveStats?.security || metrics?.security || {}
  const summary = liveStats?.summary || {}
  const sla = dashboard?.sla || {}

  // Derive system health status
  const memUsed = sys.memoryUsage?.heapUsed || 0
  const memTotal = sys.memoryUsage?.heapTotal || 1
  const memPct = (memUsed / memTotal) * 100
  const errorRate = perf.errorRate || 0
  const systemStatus: 'healthy' | 'degraded' | 'down' =
    errorRate > 10 ? 'down' : errorRate > 5 || memPct > 90 ? 'degraded' : 'healthy'

  const activeAlerts = Array.isArray(alerts) ? alerts.filter((a: any) => !a.isResolved) : []
  const criticalAlerts = activeAlerts.filter((a: any) => a.severity === 'critical')
  const lastUpdated = liveUpdatedAt ? new Date(liveUpdatedAt).toLocaleTimeString() : 'N/A'

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
            Monitoring
            <StatusDot status={systemStatus} />
          </h1>
          <p className="text-muted-foreground">
            Live system metrics and performance
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">Updated {lastUpdated}</span>
          <div className="flex items-center gap-1">
            {[
              { label: '5s', value: 5000 },
              { label: '15s', value: 15000 },
              { label: '30s', value: 30000 },
              { label: 'Off', value: 0 },
            ].map(opt => (
              <Button
                key={opt.label}
                variant={refreshInterval === opt.value ? 'default' : 'outline'}
                size="sm"
                className="h-7 text-xs px-2"
                onClick={() => setRefreshInterval(opt.value)}
              >
                {opt.label}
              </Button>
            ))}
          </div>
        </div>
      </div>

      {/* Critical Alerts Banner */}
      {criticalAlerts.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <div className="flex items-center gap-2 text-red-800 font-medium mb-2">
            <ShieldAlert className="h-5 w-5" />
            {criticalAlerts.length} Critical Alert{criticalAlerts.length !== 1 ? 's' : ''}
          </div>
          <div className="space-y-1">
            {criticalAlerts.map((alert: any) => (
              <div key={alert.id} className="text-sm text-red-700">
                {alert.title}: {alert.message}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* System Health Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <MetricCard
          icon={Clock}
          label="Uptime"
          value={sys.uptime ? formatUptime(sys.uptime) : '--'}
          color="green"
        />
        <MetricCard
          icon={HardDrive}
          label="Memory (Heap)"
          value={memUsed ? formatBytes(memUsed) : '--'}
          sub={memTotal ? `of ${formatBytes(memTotal)} (${memPct.toFixed(0)}%)` : undefined}
          color={memPct > 85 ? 'red' : memPct > 70 ? 'orange' : 'blue'}
        />
        <MetricCard
          icon={Cpu}
          label="CPU (User)"
          value={sys.cpuUsage?.user != null ? `${(sys.cpuUsage.user / 1000000).toFixed(1)}s` : '--'}
          sub={sys.cpuUsage?.system != null ? `sys: ${(sys.cpuUsage.system / 1000000).toFixed(1)}s` : undefined}
          color="purple"
        />
        <MetricCard
          icon={Server}
          label="Load Average"
          value={sys.loadAverage?.length ? sys.loadAverage[0].toFixed(2) : '--'}
          sub={sys.loadAverage?.length >= 3 ? `${sys.loadAverage[1].toFixed(2)} / ${sys.loadAverage[2].toFixed(2)}` : undefined}
          color="gray"
        />
        <MetricCard
          icon={Activity}
          label="Total Requests"
          value={app.requests?.total?.toLocaleString() || summary.totalRequests?.toLocaleString() || '0'}
          sub={app.requests?.rate ? `${app.requests.rate.toFixed(1)}/s` : undefined}
          color="blue"
        />
        <MetricCard
          icon={Wrench}
          label="Tool Executions"
          value={app.tools?.executions?.toLocaleString() || '0'}
          sub={app.tools?.averageExecutionTime ? `avg ${formatMs(app.tools.averageExecutionTime)}` : undefined}
          color="green"
        />
      </div>

      {/* Performance + Request Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Performance */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Timer className="h-4 w-4 text-muted-foreground" />
              Response Times
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="text-center p-3 bg-gray-50 rounded-lg">
                <div className="text-xs text-muted-foreground mb-1">Average</div>
                <div className="text-xl font-bold">{formatMs(perf.averageResponseTime || 0)}</div>
              </div>
              <div className="text-center p-3 bg-gray-50 rounded-lg">
                <div className="text-xs text-muted-foreground mb-1">P95</div>
                <div className="text-xl font-bold">{formatMs(perf.p95ResponseTime || 0)}</div>
              </div>
              <div className="text-center p-3 bg-gray-50 rounded-lg">
                <div className="text-xs text-muted-foreground mb-1">P99</div>
                <div className="text-xl font-bold">{formatMs(perf.p99ResponseTime || 0)}</div>
              </div>
            </div>
            <div className="space-y-3">
              <ProgressBar
                value={perf.cacheHitRate || 0}
                max={100}
                color="emerald"
                label="Cache Hit Rate"
              />
              <ProgressBar
                value={perf.errorRate || 0}
                max={100}
                color={errorRate > 5 ? 'red' : errorRate > 2 ? 'orange' : 'green'}
                label="Error Rate"
              />
            </div>
          </CardContent>
        </Card>

        {/* Request Breakdown */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-muted-foreground" />
              Requests
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="flex items-center gap-3 p-3 bg-green-50 rounded-lg">
                <CheckCircle2 className="h-5 w-5 text-green-600" />
                <div>
                  <div className="text-xs text-muted-foreground">Successful</div>
                  <div className="text-xl font-bold text-green-700">
                    {app.requests?.successful?.toLocaleString() || '0'}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 bg-red-50 rounded-lg">
                <XCircle className="h-5 w-5 text-red-600" />
                <div>
                  <div className="text-xs text-muted-foreground">Failed</div>
                  <div className="text-xl font-bold text-red-700">
                    {app.requests?.failed?.toLocaleString() || '0'}
                  </div>
                </div>
              </div>
            </div>
            {app.requests?.total > 0 && (
              <ProgressBar
                value={app.requests.successful || 0}
                max={app.requests.total}
                color="green"
                label="Success Rate"
              />
            )}
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="p-3 bg-gray-50 rounded-lg">
                <div className="text-xs text-muted-foreground">Request Rate</div>
                <div className="text-lg font-semibold">{(app.requests?.rate || 0).toFixed(1)}/s</div>
              </div>
              <div className="p-3 bg-gray-50 rounded-lg">
                <div className="text-xs text-muted-foreground">Active Tools</div>
                <div className="text-lg font-semibold">{app.tools?.active || summary.activeTools || 0}</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Protocol Metrics */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Radio className="h-4 w-4 text-muted-foreground" />
            Protocol Activity
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* MCP */}
            <div className="border rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-xs bg-blue-50 text-blue-700 border-blue-200">MCP</Badge>
                  <span className="text-sm font-medium">JSON-RPC</span>
                </div>
                <Badge variant="secondary" className="text-xs">
                  {app.activeConnections?.mcp || 0} conn
                </Badge>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Sessions</span>
                  <span className="font-medium">{proto.mcp?.sessions || 0}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Tool Calls</span>
                  <span className="font-medium">{proto.mcp?.toolCalls || 0}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Response Time</span>
                  <span className="font-medium">{formatMs(proto.mcp?.responseTime || 0)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Error Rate</span>
                  <span className={cn('font-medium', (proto.mcp?.errorRate || 0) > 5 ? 'text-red-600' : 'text-green-600')}>
                    {(proto.mcp?.errorRate || 0).toFixed(1)}%
                  </span>
                </div>
              </div>
            </div>

            {/* UTCP */}
            <div className="border rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-xs bg-purple-50 text-purple-700 border-purple-200">UTCP</Badge>
                  <span className="text-sm font-medium">Universal</span>
                </div>
                <Badge variant="secondary" className="text-xs">
                  {app.activeConnections?.utcp || 0} conn
                </Badge>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Manuals Served</span>
                  <span className="font-medium">{proto.utcp?.manuals || 0}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Direct Calls</span>
                  <span className="font-medium">{proto.utcp?.directCalls || 0}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Proxy Executions</span>
                  <span className="font-medium">{proto.utcp?.proxyExecutions || 0}</span>
                </div>
              </div>
            </div>

            {/* A2A */}
            <div className="border rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-xs bg-green-50 text-green-700 border-green-200">A2A</Badge>
                  <span className="text-sm font-medium">Agent-to-Agent</span>
                </div>
                <Badge variant="secondary" className="text-xs">
                  {app.activeConnections?.a2a || 0} conn
                </Badge>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Active Agents</span>
                  <span className="font-medium">{proto.a2a?.activeAgents || 0}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Messages</span>
                  <span className="font-medium">{proto.a2a?.messages || 0}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Workflows</span>
                  <span className="font-medium">{proto.a2a?.workflows || 0}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Connection breakdown */}
          {app.activeConnections && (
            <div className="mt-4 pt-4 border-t">
              <div className="text-xs text-muted-foreground mb-2">Active Connections by Transport</div>
              <div className="flex gap-3 flex-wrap">
                {Object.entries(app.activeConnections as Record<string, number>).map(([type, count]) => (
                  <div key={type} className="flex items-center gap-1.5 text-sm">
                    <Wifi className="h-3 w-3 text-muted-foreground" />
                    <span className="text-muted-foreground uppercase text-xs">{type}:</span>
                    <span className="font-medium">{count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Security + Resources */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Security */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Shield className="h-4 w-4 text-muted-foreground" />
              Security
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex items-center gap-3 p-3 border rounded-lg">
                <ShieldAlert className="h-5 w-5 text-red-500" />
                <div>
                  <div className="text-xs text-muted-foreground">Threats Blocked</div>
                  <div className="text-lg font-semibold">{sec.threatsBlocked || 0}</div>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 border rounded-lg">
                <Eye className="h-5 w-5 text-blue-500" />
                <div>
                  <div className="text-xs text-muted-foreground">PII Filtered</div>
                  <div className="text-lg font-semibold">{sec.piiFiltered || 0}</div>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 border rounded-lg">
                <Ban className="h-5 w-5 text-orange-500" />
                <div>
                  <div className="text-xs text-muted-foreground">Rate Limits</div>
                  <div className="text-lg font-semibold">{sec.rateLimitsApplied || 0}</div>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 border rounded-lg">
                <Lock className="h-5 w-5 text-gray-500" />
                <div>
                  <div className="text-xs text-muted-foreground">Auth Failures</div>
                  <div className="text-lg font-semibold">{sec.authFailures || 0}</div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Resources / SLA */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
              Platform Resources
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 border rounded-lg">
                <div className="text-xs text-muted-foreground">APIs</div>
                <div className="text-lg font-semibold">{app.apis?.total || 0}</div>
                <div className="text-xs text-green-600">{app.apis?.active || 0} active / {app.apis?.healthy || 0} healthy</div>
              </div>
              <div className="p-3 border rounded-lg">
                <div className="text-xs text-muted-foreground">Tools</div>
                <div className="text-lg font-semibold">{app.tools?.total || 0}</div>
                <div className="text-xs text-green-600">{app.tools?.active || 0} active</div>
              </div>
              <div className="p-3 border rounded-lg">
                <div className="text-xs text-muted-foreground">Sessions</div>
                <div className="text-lg font-semibold">{summary.activeSessions || 0}</div>
                <div className="text-xs text-muted-foreground">active</div>
              </div>
              <div className="p-3 border rounded-lg">
                <div className="text-xs text-muted-foreground">SLA Uptime</div>
                <div className="text-lg font-semibold">
                  {sla.uptime != null ? `${(sla.uptime * 100).toFixed(2)}%` : '--'}
                </div>
                <div className="text-xs text-muted-foreground">
                  {sla.availabilityTarget ? `target: ${sla.availabilityTarget}%` : ''}
                </div>
              </div>
            </div>
            {sla.responseTimeTarget && (
              <div className="mt-3">
                <ProgressBar
                  value={sla.responseTimeTarget - (sla.currentResponseTime || 0)}
                  max={sla.responseTimeTarget}
                  color={sla.currentResponseTime > sla.responseTimeTarget ? 'red' : 'green'}
                  label={`Response Time vs Target (${formatMs(sla.currentResponseTime || 0)} / ${formatMs(sla.responseTimeTarget)})`}
                />
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Active Alerts */}
      {activeAlerts.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-muted-foreground" />
              Active Alerts ({activeAlerts.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {activeAlerts.map((alert: any) => (
                <div
                  key={alert.id}
                  className={cn(
                    'flex items-center justify-between p-3 rounded-lg border',
                    alert.severity === 'critical' && 'bg-red-50 border-red-200',
                    alert.severity === 'error' && 'bg-orange-50 border-orange-200',
                    alert.severity === 'warning' && 'bg-yellow-50 border-yellow-200',
                    alert.severity === 'info' && 'bg-blue-50 border-blue-200',
                  )}
                >
                  <div className="flex items-center gap-3">
                    <Badge
                      variant="outline"
                      className={cn(
                        'text-xs',
                        alert.severity === 'critical' && 'bg-red-100 text-red-700 border-red-300',
                        alert.severity === 'error' && 'bg-orange-100 text-orange-700 border-orange-300',
                        alert.severity === 'warning' && 'bg-yellow-100 text-yellow-700 border-yellow-300',
                        alert.severity === 'info' && 'bg-blue-100 text-blue-700 border-blue-300',
                      )}
                    >
                      {alert.severity}
                    </Badge>
                    <div>
                      <div className="text-sm font-medium">{alert.title}</div>
                      <div className="text-xs text-muted-foreground">{alert.message}</div>
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {alert.triggeredAt ? new Date(alert.triggeredAt).toLocaleTimeString() : ''}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
