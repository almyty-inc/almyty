import React, { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  CheckCircle2,
  XCircle,
  Globe,
  Wrench,
  Zap,
  ExternalLink,
  Shield,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { gatewaysApi, toolsApi, apisApi, analyticsApi } from '@/lib/api'
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

function formatUptime(seconds: number): string {
  if (!seconds) return '--'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

const protocolColors: Record<string, string> = {
  mcp: 'bg-blue-50 text-blue-700 border-blue-200',
  utcp: 'bg-purple-50 text-purple-700 border-purple-200',
  a2a: 'bg-green-50 text-green-700 border-green-200',
  skills: 'bg-orange-50 text-orange-700 border-orange-200',
}

type Tab = 'tools' | 'gateways' | 'apis'

export function AnalyticsPage() {
  const { currentOrganization } = useOrganizationStore()
  const [tab, setTab] = useState<Tab>('tools')
  const [protocolFilter, setProtocolFilter] = useState<string>('all')

  const { data: tools = [], isLoading: loadingTools } = useQuery({
    queryKey: ['tools', currentOrganization?.id],
    queryFn: async () => {
      const response = await toolsApi.getAll(currentOrganization?.id)
      return response.data?.data?.tools || response.data?.tools || []
    },
    enabled: !!currentOrganization,
  })

  const { data: gateways = [], isLoading: loadingGateways } = useQuery({
    queryKey: ['gateways', currentOrganization?.id],
    queryFn: async () => {
      const response = await gatewaysApi.getAll()
      return response.data?.data?.gateways || response.data?.data || []
    },
    enabled: !!currentOrganization,
  })

  const { data: apis = [], isLoading: loadingApis } = useQuery({
    queryKey: ['apis'],
    queryFn: async () => {
      const response = await apisApi.getAll()
      return response.data?.data?.apis || response.data?.apis || response.data?.data || []
    },
  })

  const { data: metrics } = useQuery({
    queryKey: ['monitoring-metrics'],
    queryFn: async () => {
      try { return (await analyticsApi.getMetrics()).data } catch { return null }
    },
    refetchInterval: 30000,
  })

  const isLoading = loadingTools || loadingGateways || loadingApis
  if (isLoading) {
    return <div className="flex items-center justify-center h-96"><LoadingSpinner size="lg" /></div>
  }

  const toolList = Array.isArray(tools) ? tools : []
  const gatewayList = Array.isArray(gateways) ? gateways : []
  const apiList = Array.isArray(apis) ? apis : []

  const totalUsage = toolList.reduce((sum: number, t: any) => sum + (t.usageCount || 0), 0)
  const totalGwReqs = gatewayList.reduce((sum: number, g: any) => sum + (g.totalRequests || 0), 0)
  const totalOps = apiList.reduce((sum: number, a: any) => {
    const ops = a.operations || a.operationCount || 0
    return sum + (Array.isArray(ops) ? ops.length : ops)
  }, 0)

  // Filter tools by protocol
  const filteredTools = protocolFilter === 'all'
    ? toolList
    : toolList.filter((t: any) => {
        return gatewayList.some((gw: any) =>
          gw.type === protocolFilter && gw.tools?.some((gt: any) => gt.id === t.id)
        )
      })

  const sortedTools = [...filteredTools].sort((a: any, b: any) => (b.usageCount || 0) - (a.usageCount || 0))
  const protocols = [...new Set(gatewayList.map((g: any) => g.type))] as string[]
  const uptime = metrics?.system?.uptime

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Analytics</h1>
          <div className="flex items-center gap-4 mt-1 text-sm text-muted-foreground">
            <span>{apiList.length} APIs · {totalOps} operations</span>
            <span>{toolList.length} tools · {totalUsage} calls</span>
            <span>{gatewayList.length} gateways · {totalGwReqs} requests</span>
          </div>
        </div>
        {uptime != null && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="inline-block w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            Up {formatUptime(uptime)}
          </div>
        )}
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b">
        {([
          { key: 'tools' as Tab, label: 'Tools', count: toolList.length, icon: Wrench },
          { key: 'gateways' as Tab, label: 'Gateways', count: gatewayList.length, icon: Zap },
          { key: 'apis' as Tab, label: 'APIs', count: apiList.length, icon: Globe },
        ]).map(({ key, label, count, icon: Icon }) => (
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
            <span className="text-xs bg-muted px-1.5 py-0.5 rounded-full ml-1">{count}</span>
          </button>
        ))}
      </div>

      {/* Tools tab */}
      {tab === 'tools' && (
        <div>
          {/* Protocol filter */}
          {protocols.length > 0 && (
            <div className="flex items-center gap-1 mb-3">
              <span className="text-xs text-muted-foreground mr-1">Protocol:</span>
              <Button
                variant={protocolFilter === 'all' ? 'default' : 'ghost'}
                size="sm"
                className="h-6 text-xs px-2"
                onClick={() => setProtocolFilter('all')}
              >
                All
              </Button>
              {protocols.map((p) => (
                <Button
                  key={p}
                  variant={protocolFilter === p ? 'default' : 'ghost'}
                  size="sm"
                  className="h-6 text-xs px-2"
                  onClick={() => setProtocolFilter(p)}
                >
                  {p.toUpperCase()}
                </Button>
              ))}
            </div>
          )}

          {sortedTools.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              {protocolFilter !== 'all'
                ? 'No tools on this protocol'
                : <>No tools yet. <Link to="/apis" className="text-primary hover:underline">Import an API</Link> to generate tools.</>}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="pb-2 font-medium">Name</th>
                  <th className="pb-2 font-medium">Method</th>
                  <th className="pb-2 font-medium">Served via</th>
                  <th className="pb-2 font-medium text-right">Calls</th>
                  <th className="pb-2 font-medium text-right">Success</th>
                  <th className="pb-2 font-medium text-right">Avg Time</th>
                  <th className="pb-2 font-medium text-right">Last Used</th>
                </tr>
              </thead>
              <tbody>
                {sortedTools.map((tool: any) => {
                  const onGateways = gatewayList.filter((gw: any) => gw.tools?.some((t: any) => t.id === tool.id))
                  return (
                    <tr key={tool.id} className="border-b last:border-0 hover:bg-muted/50">
                      <td className="py-2">
                        <Link to={`/tools/${tool.id}`} className="font-medium hover:underline text-xs">{tool.name}</Link>
                      </td>
                      <td className="py-2 text-xs text-muted-foreground capitalize">{tool.executionMethod || 'http'}</td>
                      <td className="py-2">
                        <div className="flex gap-1">
                          {onGateways.length > 0 ? onGateways.map((gw: any) => (
                            <Badge key={gw.id} variant="outline" className={cn('text-[10px] uppercase px-1.5 py-0', protocolColors[gw.type])}>
                              {gw.type}
                            </Badge>
                          )) : <span className="text-xs text-muted-foreground">--</span>}
                        </div>
                      </td>
                      <td className="py-2 text-right font-medium">{(tool.usageCount || 0).toLocaleString()}</td>
                      <td className="py-2 text-right">
                        {tool.usageCount > 0 ? (
                          <span className={cn('font-medium',
                            tool.successRate >= 90 ? 'text-green-600' : tool.successRate >= 70 ? 'text-yellow-600' : 'text-red-600'
                          )}>{tool.successRate}%</span>
                        ) : <span className="text-muted-foreground">--</span>}
                      </td>
                      <td className="py-2 text-right text-muted-foreground">{formatMs(tool.averageResponseTime)}</td>
                      <td className="py-2 text-right text-xs text-muted-foreground">{formatDate(tool.lastUsedAt)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Gateways tab */}
      {tab === 'gateways' && (
        <div>
          {gatewayList.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              No gateways. <Link to="/gateways" className="text-primary hover:underline">Create one</Link>.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="pb-2 font-medium">Name</th>
                  <th className="pb-2 font-medium">Protocol</th>
                  <th className="pb-2 font-medium">Endpoint</th>
                  <th className="pb-2 font-medium text-right">Tools</th>
                  <th className="pb-2 font-medium text-right">Requests</th>
                  <th className="pb-2 font-medium text-right">Success Rate</th>
                  <th className="pb-2 font-medium text-right">Last Request</th>
                  <th className="pb-2 font-medium text-center">Health</th>
                  <th className="pb-2 font-medium">Auth</th>
                </tr>
              </thead>
              <tbody>
                {gatewayList.map((gw: any) => {
                  const toolCount = gw.tools?.length || gw.toolCount || 0
                  const total = gw.totalRequests || 0
                  const success = gw.successfulRequests || 0
                  const rate = total > 0 ? ((success / total) * 100).toFixed(1) + '%' : '--'
                  const authTypes = gw.authConfigs?.map((a: any) => a.type).filter(Boolean) || []
                  return (
                    <tr key={gw.id} className="border-b last:border-0 hover:bg-muted/50">
                      <td className="py-2">
                        <Link to={`/gateways/${gw.id}`} className="font-medium hover:underline text-sm">{gw.name}</Link>
                      </td>
                      <td className="py-2">
                        <Badge variant="outline" className={cn('text-xs uppercase', protocolColors[gw.type])}>{gw.type}</Badge>
                      </td>
                      <td className="py-2 text-xs text-muted-foreground font-mono">{gw.endpoint}</td>
                      <td className="py-2 text-right font-medium">{toolCount}</td>
                      <td className="py-2 text-right font-medium">{total.toLocaleString()}</td>
                      <td className="py-2 text-right">{rate}</td>
                      <td className="py-2 text-right text-xs text-muted-foreground">{formatDate(gw.lastRequestAt)}</td>
                      <td className="py-2 text-center">
                        {gw.isHealthy !== false
                          ? <CheckCircle2 className="h-4 w-4 text-green-500 mx-auto" />
                          : <XCircle className="h-4 w-4 text-red-500 mx-auto" />}
                      </td>
                      <td className="py-2">
                        {authTypes.length > 0 ? (
                          <span className="text-xs capitalize flex items-center gap-1">
                            <Shield className="h-3 w-3 text-muted-foreground" />{authTypes.join(', ')}
                          </span>
                        ) : <span className="text-xs text-muted-foreground">--</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* APIs tab */}
      {tab === 'apis' && (
        <div>
          {apiList.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              No APIs connected. <Link to="/apis" className="text-primary hover:underline">Import one</Link>.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="pb-2 font-medium">Name</th>
                  <th className="pb-2 font-medium">Type</th>
                  <th className="pb-2 font-medium">Base URL</th>
                  <th className="pb-2 font-medium text-right">Operations</th>
                  <th className="pb-2 font-medium text-right">Tools</th>
                  <th className="pb-2 font-medium">Auth</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2 font-medium text-right">Added</th>
                </tr>
              </thead>
              <tbody>
                {apiList.map((api: any) => {
                  const ops = api.operations || []
                  const opCount = Array.isArray(ops) ? ops.length : (api.operationCount || 0)
                  const apiTools = toolList.filter((t: any) => {
                    if (!t.operationId || !Array.isArray(ops)) return false
                    return ops.some((op: any) => op.id === t.operationId)
                  })
                  const toolCount = apiTools.length > 0 ? apiTools.length : (opCount > 0 ? opCount : 0)
                  const authType = api.authentication?.type || 'none'
                  return (
                    <tr key={api.id} className="border-b last:border-0 hover:bg-muted/50">
                      <td className="py-2">
                        <Link to={`/apis/${api.id}`} className="font-medium hover:underline text-sm">{api.name}</Link>
                      </td>
                      <td className="py-2">
                        <Badge variant="outline" className="text-xs">{api.type || 'openapi'}</Badge>
                      </td>
                      <td className="py-2 text-xs text-muted-foreground flex items-center gap-1 font-mono">
                        <ExternalLink className="h-3 w-3 shrink-0" />{api.baseUrl || '--'}
                      </td>
                      <td className="py-2 text-right font-medium">{opCount}</td>
                      <td className="py-2 text-right font-medium">{toolCount}</td>
                      <td className="py-2 text-xs capitalize">{authType}</td>
                      <td className="py-2">
                        <Badge variant={api.status === 'active' ? 'default' : 'secondary'} className="text-xs">{api.status}</Badge>
                      </td>
                      <td className="py-2 text-right text-xs text-muted-foreground">{formatDate(api.createdAt)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}
