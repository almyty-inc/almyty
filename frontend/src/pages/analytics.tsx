import React, { useState, useMemo, useEffect } from 'react'
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
  Bot,
  CheckCircle2,
  XCircle,
} from 'lucide-react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { analyticsApi, gatewaysApi, toolsApi, agentsApi, llmProvidersApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { cn } from '@/lib/utils'
import type { Tool, Gateway, RequestLog, ToolUsageEntry, GatewayUsageEntry, LlmUsageEntry, TimelineEntry, AnalyticsOverview, Agent, AgentExecution } from '@/types'

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
  mcp: 'bg-violet-500/20 text-violet-300 border-violet-500/30',
  utcp: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  a2a: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30',
  skills: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
}

const statusColors: Record<string, string> = {
  '2': 'text-green-600',
  '3': 'text-blue-600',
  '4': 'text-yellow-600',
  '5': 'text-red-600',
}

type Tab = 'overview' | 'requests' | 'tools' | 'gateways' | 'llm' | 'agents'

export function AnalyticsPage() {
  useEffect(() => {
    document.title = 'Analytics | almyty'
    return () => { document.title = 'almyty' }
  }, [])

  const { currentOrganization } = useOrganizationStore()
  const [tab, setTab] = useState<Tab>('overview')
  const [timeframe, setTimeframe] = useState('7d')
  const [logPage, setLogPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState<string>('')

  const { data: overview, isLoading: loadingOverview } = useQuery({
    queryKey: ['analytics-overview', currentOrganization?.id],
    queryFn: () => analyticsApi.getOverview(),
    enabled: !!currentOrganization,
    refetchInterval: 30000,
  })

  const { data: requestLogs, isLoading: loadingLogs } = useQuery({
    queryKey: ['analytics-requests', currentOrganization?.id, logPage, statusFilter],
    queryFn: async () => {
      const params: Record<string, string> = { page: String(logPage), limit: '25' }
      if (statusFilter) params.status = statusFilter
      return analyticsApi.getRequestLogs(params)
    },
    enabled: !!currentOrganization && tab === 'requests',
  })

  const { data: toolUsage, isLoading: loadingToolUsage } = useQuery({
    queryKey: ['analytics-tool-usage', currentOrganization?.id, timeframe],
    queryFn: () => analyticsApi.getToolUsage(timeframe),
    enabled: !!currentOrganization && tab === 'tools',
  })

  const { data: gatewayUsage, isLoading: loadingGatewayUsage } = useQuery({
    queryKey: ['analytics-gateway-usage', currentOrganization?.id, timeframe],
    queryFn: () => analyticsApi.getGatewayUsage(timeframe),
    enabled: !!currentOrganization && tab === 'gateways',
  })

  const { data: llmUsage, isLoading: loadingLlmUsage } = useQuery({
    queryKey: ['analytics-llm-usage', currentOrganization?.id, timeframe],
    queryFn: () => analyticsApi.getLlmUsage(timeframe),
    enabled: !!currentOrganization && tab === 'llm',
  })

  const { data: llmProvidersData } = useQuery({
    queryKey: ['llm-providers'],
    queryFn: () => llmProvidersApi.getAll(),
    enabled: !!currentOrganization && tab === 'llm',
  })
  const providerNameMap = useMemo(() => {
    const providers = llmProvidersData?.providers || llmProvidersData || []
    const arr = Array.isArray(providers) ? providers : []
    const map: Record<string, string> = {}
    arr.forEach((p: any) => { map[p.id] = p.name })
    return map
  }, [llmProvidersData])

  const { data: timeline } = useQuery({
    queryKey: ['analytics-timeline', currentOrganization?.id],
    queryFn: () => analyticsApi.getTimeline('7d', 'day'),
    enabled: !!currentOrganization && tab === 'overview',
  })

  const timelineData = useMemo(() => {
    if (Array.isArray(timeline) && timeline.length > 0) {
      return timeline.map((entry: TimelineEntry) => ({
        date: new Date(entry.timestamp || entry.date || '').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        requests: entry.requests || entry.count || 0,
      }))
    }
    // Fallback: generate empty 7-day data
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

  // Fetch all agents for the Agents tab
  const { data: agentsRaw, isLoading: loadingAgents } = useQuery({
    queryKey: ['analytics-agents', currentOrganization?.id],
    queryFn: async () => {
      const d = await agentsApi.getAll()
      const result = d?.agents || (Array.isArray(d) ? d : [])
      return Array.isArray(result) ? result : []
    },
    enabled: !!currentOrganization && tab === 'agents',
  })
  const agents: Agent[] = Array.isArray(agentsRaw) ? agentsRaw : []

  // Fetch recent executions for each agent (aggregated)
  const { data: agentExecutionsMap } = useQuery({
    queryKey: ['analytics-agent-executions', currentOrganization?.id, agents.map(a => a.id).join(',')],
    queryFn: async () => {
      const map: Record<string, AgentExecution[]> = {}
      await Promise.all(
        agents.map(async (agent) => {
          try {
            const d = await agentsApi.getExecutions(agent.id, { limit: 50 })
            map[agent.id] = Array.isArray(d) ? d : d?.executions || []
          } catch {
            map[agent.id] = []
          }
        })
      )
      return map
    },
    enabled: !!currentOrganization && tab === 'agents' && agents.length > 0,
  })

  // Compute agent analytics from the data we have
  const agentStats = useMemo(() => {
    if (!agents.length) return null
    const now = Date.now()
    const day = 24 * 60 * 60 * 1000
    let total24h = 0
    let total7d = 0
    let totalSuccess = 0
    let totalExecs = 0
    let totalTime = 0
    let timedExecs = 0
    const perAgent: Array<{
      agent: Agent
      executions24h: number
      executions7d: number
      successRate: number
      avgTime: number
      recentFailures: AgentExecution[]
    }> = []

    for (const agent of agents) {
      const executions = agentExecutionsMap?.[agent.id] || []
      let a24h = 0
      let a7d = 0
      let aSuccess = 0
      let aTime = 0
      let aTimed = 0
      const failures: AgentExecution[] = []

      for (const exec of executions) {
        const age = now - new Date(exec.createdAt).getTime()
        if (age < day) a24h++
        if (age < 7 * day) a7d++
        if (exec.status === 'completed') aSuccess++
        if (exec.status === 'failed' || exec.status === 'timeout') {
          failures.push(exec)
        }
        if (exec.executionTime > 0) {
          aTime += exec.executionTime
          aTimed++
        }
      }

      total24h += a24h
      total7d += a7d
      totalSuccess += agent.successfulExecutions
      totalExecs += agent.totalExecutions
      if (aTimed > 0) {
        totalTime += aTime
        timedExecs += aTimed
      }

      perAgent.push({
        agent,
        executions24h: a24h,
        executions7d: a7d,
        successRate: executions.length > 0 ? Math.round((aSuccess / executions.length) * 100) : (agent.totalExecutions > 0 ? Math.round((agent.successfulExecutions / agent.totalExecutions) * 100) : 0),
        avgTime: aTimed > 0 ? aTime / aTimed : agent.averageExecutionTime,
        recentFailures: failures.slice(0, 3),
      })
    }

    // Sort by total executions (agent-level stat)
    perAgent.sort((a, b) => b.agent.totalExecutions - a.agent.totalExecutions)

    const allFailures = perAgent.flatMap(p => p.recentFailures).sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    ).slice(0, 10)

    return {
      total24h,
      total7d,
      overallSuccessRate: totalExecs > 0 ? Math.round((totalSuccess / totalExecs) * 100) : 0,
      avgExecutionTime: timedExecs > 0 ? totalTime / timedExecs : 0,
      perAgent,
      recentFailures: allFailures,
    }
  }, [agents, agentExecutionsMap])

  const { data: toolsRaw } = useQuery({
    queryKey: ['tools', currentOrganization?.id],
    queryFn: async () => {
      const d = await toolsApi.getAll(currentOrganization?.id)
      const result = d?.tools || (Array.isArray(d) ? d : [])
      return Array.isArray(result) ? result : []
    },
    enabled: !!currentOrganization,
  })
  const tools = Array.isArray(toolsRaw) ? toolsRaw : []

  const { data: gatewaysRaw } = useQuery({
    queryKey: ['gateways', currentOrganization?.id],
    queryFn: async () => {
      const d = await gatewaysApi.getAll()
      const result = d?.gateways || (Array.isArray(d) ? d : [])
      return Array.isArray(result) ? result : []
    },
    enabled: !!currentOrganization,
  })
  const gateways = Array.isArray(gatewaysRaw) ? gatewaysRaw : []

  const toolMap = Object.fromEntries(tools.map((t: Tool) => [t.id, t]))
  const gatewayMap = Object.fromEntries(gateways.map((g: Gateway) => [g.id, g]))

  const handleExport = async (type: string, format: string) => {
    try {
      const res = await analyticsApi.exportData(format, type)
      const blob = new Blob([typeof res === 'string' ? res : JSON.stringify(res, null, 2)], {
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
      <div className="flex items-center justify-between pb-4 border-b">
        <div>
          <h1 className="text-4xl font-heading font-extrabold tracking-tight">Analytics</h1>
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
          { key: 'agents' as Tab, label: 'Agents', icon: Bot },
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
            <div className="text-center py-12">
              <Activity className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm font-medium text-muted-foreground">No analytics data yet</p>
              <p className="text-xs text-muted-foreground mt-1">Usage data will appear here as you use the system.</p>
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
                    <Line type="monotone" dataKey="requests" stroke="hsl(222.2, 47.4%, 11.2%)" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Request Log tab */}
      {tab === 'requests' && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <span className="text-xs text-muted-foreground">Filter:</span>
            <div className="flex gap-1">
              {[
                { value: '', label: 'All' },
                { value: 'success', label: 'Success' },
                { value: 'error', label: 'Error' },
              ].map(f => (
                <Button key={f.value || 'all'} variant={statusFilter === f.value ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => { setStatusFilter(f.value); setLogPage(1) }}>
                  {f.label}
                </Button>
              ))}
            </div>
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
            <div className="text-center py-12">
              <Globe className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm font-medium text-muted-foreground">No request logs yet</p>
              <p className="text-xs text-muted-foreground mt-1">Logs are recorded automatically as API requests come in.</p>
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
                  {toolUsage.map((t: ToolUsageEntry) => {
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
            <div className="text-center py-12">
              <Wrench className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm font-medium text-muted-foreground">No tool usage data</p>
              <p className="text-xs text-muted-foreground mt-1">Tool execution stats will appear here once tools are used.</p>
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
            <div className="text-center py-12">
              <Zap className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm font-medium text-muted-foreground">No gateway usage data</p>
              <p className="text-xs text-muted-foreground mt-1">Gateway traffic stats will appear here once gateways receive requests.</p>
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
                  {llmUsage.map((l: LlmUsageEntry) => (
                    <tr key={l.providerId} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-4 py-2.5 font-medium text-sm">{providerNameMap[l.providerId] || l.providerId.slice(0, 8)}</td>
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
            <div className="text-center py-12">
              <MessageSquare className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm font-medium text-muted-foreground">No LLM usage data</p>
              <p className="text-xs text-muted-foreground mt-1">LLM session and cost data will appear here once AI models are used.</p>
            </div>
          )}
        </div>
      )}

      {/* Agents tab */}
      {tab === 'agents' && (
        <div>
          {loadingAgents ? (
            <div className="flex items-center justify-center h-48"><LoadingSpinner size="lg" /></div>
          ) : agentStats && agents.length > 0 ? (
            <div className="space-y-6">
              {/* Summary stats */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <StatCard icon={Bot} label="Executions (24h)" value={formatNumber(agentStats.total24h)} />
                <StatCard icon={Bot} label="Executions (7d)" value={formatNumber(agentStats.total7d)} />
                <StatCard icon={CheckCircle2} label="Success Rate" value={`${agentStats.overallSuccessRate}%`}
                  className={agentStats.overallSuccessRate >= 90 ? '' : agentStats.overallSuccessRate >= 70 ? 'border-yellow-200 bg-yellow-50/50' : 'border-red-200 bg-red-50/50'} />
                <StatCard icon={Clock} label="Avg Execution Time" value={formatMs(agentStats.avgExecutionTime)} />
              </div>

              {/* Top agents by usage */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Top Agents by Usage</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="rounded-lg border bg-card">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-muted-foreground bg-muted/50">
                          <th className="px-4 py-3 font-medium">Agent</th>
                          <th className="px-4 py-3 font-medium">Status</th>
                          <th className="px-4 py-3 font-medium text-right">Total Execs</th>
                          <th className="px-4 py-3 font-medium text-right">24h</th>
                          <th className="px-4 py-3 font-medium text-right">7d</th>
                          <th className="px-4 py-3 font-medium text-right">Success Rate</th>
                          <th className="px-4 py-3 font-medium text-right">Avg Time</th>
                          <th className="px-4 py-3 font-medium text-right">Cost</th>
                        </tr>
                      </thead>
                      <tbody>
                        {agentStats.perAgent.map(({ agent, executions24h, executions7d, successRate, avgTime }) => (
                          <tr key={agent.id} className="border-b last:border-0 hover:bg-muted/30">
                            <td className="px-4 py-2.5">
                              <Link to={`/agents/${agent.id}`} className="font-medium hover:underline text-sm">
                                {agent.name}
                              </Link>
                            </td>
                            <td className="px-4 py-2.5">
                              <Badge variant={agent.status === 'active' ? 'success' : agent.status === 'error' ? 'destructive' : 'secondary'}
                                className="text-xs">
                                {agent.status}
                              </Badge>
                            </td>
                            <td className="px-4 py-2.5 text-right font-medium">{agent.totalExecutions.toLocaleString()}</td>
                            <td className="px-4 py-2.5 text-right text-muted-foreground">{executions24h}</td>
                            <td className="px-4 py-2.5 text-right text-muted-foreground">{executions7d}</td>
                            <td className="px-4 py-2.5 text-right">
                              <span className={cn('font-medium',
                                successRate >= 90 ? 'text-green-600' : successRate >= 70 ? 'text-yellow-600' : 'text-red-600'
                              )}>{successRate}%</span>
                            </td>
                            <td className="px-4 py-2.5 text-right text-muted-foreground">{formatMs(avgTime)}</td>
                            <td className="px-4 py-2.5 text-right text-muted-foreground">
                              {agent.totalCost > 0 ? `$${agent.totalCost.toFixed(4)}` : '--'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>

              {/* Recent Failures */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Recent Failures</CardTitle>
                </CardHeader>
                <CardContent>
                  {agentStats.recentFailures.length === 0 ? (
                    <div className="text-center py-6">
                      <CheckCircle2 className="h-8 w-8 text-green-500 mx-auto mb-2" />
                      <p className="text-sm text-muted-foreground">No recent failures</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {agentStats.recentFailures.map((exec) => {
                        const agentForExec = agents.find(a => a.id === exec.agentId)
                        return (
                          <div key={exec.id} className="flex items-start gap-3 p-3 rounded-lg border bg-red-50/30 dark:bg-red-950/20">
                            <XCircle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <Link to={`/agents/${exec.agentId}`} className="text-sm font-medium hover:underline">
                                  {agentForExec?.name || exec.agentId.slice(0, 8)}
                                </Link>
                                <Badge variant="destructive" className="text-[10px]">{exec.status}</Badge>
                                <span className="text-xs text-muted-foreground ml-auto whitespace-nowrap">
                                  {formatDate(exec.createdAt)}
                                </span>
                              </div>
                              {exec.error && (
                                <p className="text-xs text-red-600 dark:text-red-400 mt-1 truncate">
                                  {exec.error}
                                </p>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          ) : (
            <div className="text-center py-12">
              <Bot className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm font-medium text-muted-foreground">No agent data yet</p>
              <p className="text-xs text-muted-foreground mt-1">Agent execution stats will appear here once agents are created and invoked.</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function StatCard({ icon: Icon, label, value, className }: {
  icon: React.ComponentType<{ className?: string }>; label: string; value: string; className?: string
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
