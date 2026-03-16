import React, { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  Activity,
  ArrowDownToLine,
  Clock,
  DollarSign,
  Globe,
  MessageSquare,
  Wrench,
  Zap,
  AlertTriangle,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { analyticsApi, gatewaysApi, toolsApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { cn } from '@/lib/utils'

function formatMs(ms: number): string {
  if (!ms || ms === 0) return '--'
  if (ms < 1) return '<1ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function formatDate(date: string | null): string {
  if (!date) return 'Never'
  const d = new Date(date)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  if (diff < 60000) return 'Just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return d.toLocaleDateString()
}

function formatNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return n.toString()
}

const protocolColors: Record<string, string> = {
  mcp: 'bg-blue-50 text-blue-700 border-blue-200',
  utcp: 'bg-purple-50 text-purple-700 border-purple-200',
  a2a: 'bg-green-50 text-green-700 border-green-200',
  skills: 'bg-orange-50 text-orange-700 border-orange-200',
}

const statusColors: Record<string, string> = {
  '2': 'text-green-600',
  '3': 'text-blue-600',
  '4': 'text-yellow-600',
  '5': 'text-red-600',
}

type Tab = 'overview' | 'requests' | 'tools' | 'gateways' | 'llm'

export function AnalyticsPage() {
  const { currentOrganization } = useOrganizationStore()
  const [tab, setTab] = useState<Tab>('overview')
  const [timeframe, setTimeframe] = useState('7d')
  const [logPage, setLogPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState<string>('')

  const { data: overview, isLoading: loadingOverview } = useQuery({
    queryKey: ['analytics-overview', currentOrganization?.id],
    queryFn: async () => {
      const res = await analyticsApi.getOverview()
      return res.data
    },
    enabled: !!currentOrganization,
    refetchInterval: 30000,
  })

  const { data: requestLogs, isLoading: loadingLogs } = useQuery({
    queryKey: ['analytics-requests', currentOrganization?.id, logPage, statusFilter],
    queryFn: async () => {
      const params: Record<string, string> = { page: String(logPage), limit: '25' }
      if (statusFilter) params.status = statusFilter
      const res = await analyticsApi.getRequestLogs(params)
      return res.data
    },
    enabled: !!currentOrganization && tab === 'requests',
  })

  const { data: toolUsage, isLoading: loadingToolUsage } = useQuery({
    queryKey: ['analytics-tool-usage', currentOrganization?.id, timeframe],
    queryFn: async () => {
      const res = await analyticsApi.getToolUsage(timeframe)
      return res.data
    },
    enabled: !!currentOrganization && tab === 'tools',
  })

  const { data: gatewayUsage, isLoading: loadingGatewayUsage } = useQuery({
    queryKey: ['analytics-gateway-usage', currentOrganization?.id, timeframe],
    queryFn: async () => {
      const res = await analyticsApi.getGatewayUsage(timeframe)
      return res.data
    },
    enabled: !!currentOrganization && tab === 'gateways',
  })

  const { data: llmUsage, isLoading: loadingLlmUsage } = useQuery({
    queryKey: ['analytics-llm-usage', currentOrganization?.id, timeframe],
    queryFn: async () => {
      const res = await analyticsApi.getLlmUsage(timeframe)
      return res.data
    },
    enabled: !!currentOrganization && tab === 'llm',
  })

  const { data: toolsRaw } = useQuery({
    queryKey: ['tools', currentOrganization?.id],
    queryFn: async () => {
      const res = await toolsApi.getAll(currentOrganization?.id)
      const d = res.data?.data || res.data
      const result = d?.tools || (Array.isArray(d) ? d : [])
      return Array.isArray(result) ? result : []
    },
    enabled: !!currentOrganization,
  })
  const tools = Array.isArray(toolsRaw) ? toolsRaw : []

  const { data: gatewaysRaw } = useQuery({
    queryKey: ['gateways', currentOrganization?.id],
    queryFn: async () => {
      const res = await gatewaysApi.getAll()
      const d = res.data?.data || res.data
      const result = d?.gateways || (Array.isArray(d) ? d : [])
      return Array.isArray(result) ? result : []
    },
    enabled: !!currentOrganization,
  })
  const gateways = Array.isArray(gatewaysRaw) ? gatewaysRaw : []

  const toolMap = Object.fromEntries(tools.map((t: any) => [t.id, t]))
  const gatewayMap = Object.fromEntries(gateways.map((g: any) => [g.id, g]))

  const handleExport = async (type: string, format: string) => {
    try {
      const res = await analyticsApi.exportData(format, type)
      const blob = new Blob([typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2)], {
        type: format === 'csv' ? 'text/csv' : 'application/json',
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${type}-${new Date().toISOString().split('T')[0]}.${format}`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Export failed:', err)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Analytics</h1>
          <p className="text-muted-foreground">Real-time usage data across all protocols</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => handleExport('requests', 'csv')}>
            <ArrowDownToLine className="h-4 w-4 mr-1" /> Export CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleExport('requests', 'json')}>
            <ArrowDownToLine className="h-4 w-4 mr-1" /> Export JSON
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b">
        {([
          { key: 'overview' as Tab, label: 'Overview', icon: Activity },
          { key: 'requests' as Tab, label: 'Request Log', icon: Globe },
          { key: 'tools' as Tab, label: 'Tools', icon: Wrench },
          { key: 'gateways' as Tab, label: 'Gateways', icon: Zap },
          { key: 'llm' as Tab, label: 'LLM', icon: MessageSquare },
        ]).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn(
              'flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px',
              tab === key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>

      {/* Overview tab */}
      {tab === 'overview' && (
        <div>
          {loadingOverview ? (
            <div className="flex items-center justify-center h-48"><LoadingSpinner size="lg" /></div>
          ) : overview ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard icon={Globe} label="Requests (24h)" value={formatNumber(overview.last24h?.requests || 0)} />
              <StatCard icon={Wrench} label="Tool Executions (24h)" value={formatNumber(overview.last24h?.toolExecutions || 0)} />
              <StatCard icon={Clock} label="Avg Response (24h)" value={formatMs(overview.last24h?.avgResponseTime || 0)} />
              <StatCard icon={AlertTriangle} label="Errors (24h)" value={formatNumber(overview.last24h?.errors || 0)}
                className={overview.last24h?.errors > 0 ? 'border-red-200 bg-red-50/50' : ''} />
              <StatCard icon={MessageSquare} label="LLM Sessions (24h)" value={formatNumber(overview.last24h?.llmSessions || 0)} />
              <StatCard icon={Globe} label="Requests (7d)" value={formatNumber(overview.last7d?.requests || 0)} />
              <StatCard icon={Wrench} label="Tool Executions (7d)" value={formatNumber(overview.last7d?.toolExecutions || 0)} />
              <StatCard icon={DollarSign} label="LLM Cost (7d)"
                value={`$${((overview.last7d?.llmCostCents || 0) / 100).toFixed(4)}`} />
            </div>
          ) : (
            <div className="text-center py-12 text-muted-foreground">
              No analytics data yet. Use the system to generate data.
            </div>
          )}
        </div>
      )}

      {/* Request Log tab */}
      {tab === 'requests' && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <span className="text-xs text-muted-foreground">Filter:</span>
            {['', 'success', 'error'].map(f => (
              <Button key={f || 'all'} variant={statusFilter === f ? 'default' : 'ghost'}
                size="sm" className="h-6 text-xs px-2"
                onClick={() => { setStatusFilter(f); setLogPage(1) }}>
                {f || 'All'}
              </Button>
            ))}
          </div>

          {loadingLogs ? (
            <div className="flex items-center justify-center h-48"><LoadingSpinner size="lg" /></div>
          ) : requestLogs?.data?.length > 0 ? (
            <>
              <div className="rounded-lg border bg-card overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground bg-muted/50">
                      <th className="px-3 py-2 font-medium">Time</th>
                      <th className="px-3 py-2 font-medium">Method</th>
                      <th className="px-3 py-2 font-medium">Path</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                      <th className="px-3 py-2 font-medium text-right">Time</th>
                      <th className="px-3 py-2 font-medium">Protocol</th>
                      <th className="px-3 py-2 font-medium">IP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {requestLogs.data.map((log: any) => (
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
                            <Badge variant="outline" className={cn('text-[10px] uppercase px-1.5 py-0', protocolColors[log.protocol])}>
                              {log.protocol}
                            </Badge>
                          ) : <span className="text-muted-foreground">--</span>}
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
                  <Button variant="outline" size="sm" disabled={logPage <= 1}
                    onClick={() => setLogPage(p => p - 1)}>Prev</Button>
                  <Button variant="outline" size="sm" disabled={logPage >= requestLogs.pages}
                    onClick={() => setLogPage(p => p + 1)}>Next</Button>
                </div>
              </div>
            </>
          ) : (
            <div className="text-center py-12 text-muted-foreground">
              No request logs yet. Logs are recorded automatically as the system is used.
            </div>
          )}
        </div>
      )}

      {/* Tools tab */}
      {tab === 'tools' && (
        <div>
          <TimeframeSelector value={timeframe} onChange={setTimeframe} />
          {loadingToolUsage ? (
            <div className="flex items-center justify-center h-48"><LoadingSpinner size="lg" /></div>
          ) : (Array.isArray(toolUsage) && toolUsage.length > 0) ? (
            <div className="rounded-lg border bg-card">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground bg-muted/50">
                    <th className="px-4 py-3 font-medium">Tool</th>
                    <th className="px-4 py-3 font-medium text-right">Executions</th>
                    <th className="px-4 py-3 font-medium text-right">Success Rate</th>
                    <th className="px-4 py-3 font-medium text-right">Avg Time</th>
                    <th className="px-4 py-3 font-medium text-right">Last Used</th>
                  </tr>
                </thead>
                <tbody>
                  {toolUsage.map((t: any) => {
                    const tool = toolMap[t.toolId]
                    return (
                      <tr key={t.toolId} className="border-b last:border-0 hover:bg-muted/30">
                        <td className="px-4 py-2.5">
                          <Link to={`/tools/${t.toolId}`} className="font-medium hover:underline text-xs">
                            {tool?.name || t.toolId.slice(0, 8)}
                          </Link>
                        </td>
                        <td className="px-4 py-2.5 text-right font-medium">{t.totalExecutions.toLocaleString()}</td>
                        <td className="px-4 py-2.5 text-right">
                          <span className={cn('font-medium',
                            t.successRate >= 90 ? 'text-green-600' : t.successRate >= 70 ? 'text-yellow-600' : 'text-red-600'
                          )}>{t.successRate}%</span>
                        </td>
                        <td className="px-4 py-2.5 text-right text-muted-foreground">{formatMs(t.avgExecutionTime)}</td>
                        <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">{formatDate(t.lastUsed)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-center py-12 text-muted-foreground">
              No tool usage data for this period.
            </div>
          )}
        </div>
      )}

      {/* Gateways tab */}
      {tab === 'gateways' && (
        <div>
          <TimeframeSelector value={timeframe} onChange={setTimeframe} />
          {loadingGatewayUsage ? (
            <div className="flex items-center justify-center h-48"><LoadingSpinner size="lg" /></div>
          ) : (Array.isArray(gatewayUsage) && gatewayUsage.length > 0) ? (
            <div className="rounded-lg border bg-card">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground bg-muted/50">
                    <th className="px-4 py-3 font-medium">Gateway</th>
                    <th className="px-4 py-3 font-medium">Protocol</th>
                    <th className="px-4 py-3 font-medium text-right">Requests</th>
                    <th className="px-4 py-3 font-medium text-right">Success</th>
                    <th className="px-4 py-3 font-medium text-right">Errors</th>
                    <th className="px-4 py-3 font-medium text-right">Success Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {gatewayUsage.map((g: any) => {
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
                            <Badge variant="outline" className={cn('text-xs uppercase', protocolColors[gateway.type])}>
                              {gateway.type}
                            </Badge>
                          ) : '--'}
                        </td>
                        <td className="px-4 py-2.5 text-right font-medium">{g.totalRequests.toLocaleString()}</td>
                        <td className="px-4 py-2.5 text-right text-green-600">{g.successCount.toLocaleString()}</td>
                        <td className="px-4 py-2.5 text-right text-red-600">{g.errorCount.toLocaleString()}</td>
                        <td className="px-4 py-2.5 text-right">
                          <span className={cn('font-medium',
                            g.successRate >= 90 ? 'text-green-600' : g.successRate >= 70 ? 'text-yellow-600' : 'text-red-600'
                          )}>{g.successRate}%</span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-center py-12 text-muted-foreground">
              No gateway usage data for this period.
            </div>
          )}
        </div>
      )}

      {/* LLM tab */}
      {tab === 'llm' && (
        <div>
          <TimeframeSelector value={timeframe} onChange={setTimeframe} />
          {loadingLlmUsage ? (
            <div className="flex items-center justify-center h-48"><LoadingSpinner size="lg" /></div>
          ) : (Array.isArray(llmUsage) && llmUsage.length > 0) ? (
            <div className="rounded-lg border bg-card">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground bg-muted/50">
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
                  {llmUsage.map((l: any) => (
                    <tr key={l.providerId} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-4 py-2.5 font-medium text-sm">{l.providerId.slice(0, 8)}</td>
                      <td className="px-4 py-2.5 text-right">{l.sessionCount.toLocaleString()}</td>
                      <td className="px-4 py-2.5 text-right">{l.totalMessages.toLocaleString()}</td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground">{formatNumber(l.totalInputTokens)}</td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground">{formatNumber(l.totalOutputTokens)}</td>
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
            <div className="text-center py-12 text-muted-foreground">
              No LLM usage data for this period.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function StatCard({ icon: Icon, label, value, className }: {
  icon: any; label: string; value: string; className?: string
}) {
  return (
    <div className={cn('rounded-lg border bg-card p-4', className)}>
      <div className="flex items-center gap-2 text-muted-foreground mb-1">
        <Icon className="h-4 w-4" />
        <span className="text-xs">{label}</span>
      </div>
      <div className="text-2xl font-bold">{value}</div>
    </div>
  )
}

function TimeframeSelector({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-1 mb-3">
      <span className="text-xs text-muted-foreground mr-1">Timeframe:</span>
      {['1h', '24h', '7d', '30d'].map(tf => (
        <Button key={tf} variant={value === tf ? 'default' : 'ghost'}
          size="sm" className="h-6 text-xs px-2"
          onClick={() => onChange(tf)}>
          {tf}
        </Button>
      ))}
    </div>
  )
}
