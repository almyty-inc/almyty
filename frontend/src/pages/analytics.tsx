import React, { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  Activity,
  Zap,
  Clock,
  CheckCircle2,
  XCircle,
  Wrench,
  Globe,
  Shield,
  ExternalLink,
  Key,
  Hash,
  Filter,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
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

export function AnalyticsPage() {
  const { currentOrganization } = useOrganizationStore()
  const [gatewayFilter, setGatewayFilter] = useState<string>('all')

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
      try {
        const response = await analyticsApi.getMetrics()
        return response.data
      } catch { return null }
    },
    refetchInterval: 30000,
  })

  const isLoading = loadingTools || loadingGateways || loadingApis

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  const toolList = Array.isArray(tools) ? tools : []
  const gatewayList = Array.isArray(gateways) ? gateways : []
  const apiList = Array.isArray(apis) ? apis : []

  // Build gateway → tool mapping
  const gwToolMap = new Map<string, Set<string>>()
  gatewayList.forEach((gw: any) => {
    const gwTools = gw.tools || []
    gwTools.forEach((t: any) => {
      if (!gwToolMap.has(t.id)) gwToolMap.set(t.id, new Set())
      gwToolMap.get(t.id)!.add(gw.id)
    })
  })

  // Stats
  const totalUsage = toolList.reduce((sum: number, t: any) => sum + (t.usageCount || 0), 0)
  const totalGatewayRequests = gatewayList.reduce((sum: number, g: any) => sum + (g.totalRequests || 0), 0)
  const totalOperations = apiList.reduce((sum: number, a: any) => {
    const ops = a.operations || a.operationCount || 0
    return sum + (Array.isArray(ops) ? ops.length : ops)
  }, 0)

  // Filter tools by gateway
  const filteredTools = gatewayFilter === 'all'
    ? toolList
    : toolList.filter((t: any) => {
        const gw = gatewayList.find((g: any) => g.id === gatewayFilter)
        return gw?.tools?.some((gt: any) => gt.id === t.id)
      })

  const sortedTools = [...filteredTools].sort((a: any, b: any) => (b.usageCount || 0) - (a.usageCount || 0))
  const uptime = metrics?.system?.uptime

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Analytics</h1>
          <p className="text-muted-foreground">
            API connections, tool usage, and gateway traffic
          </p>
        </div>
        {uptime != null && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="inline-block w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            System up {formatUptime(uptime)}
          </div>
        )}
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Connected APIs</p>
                <p className="text-3xl font-bold">{apiList.length}</p>
                <p className="text-xs text-muted-foreground mt-1">{totalOperations} operations</p>
              </div>
              <Globe className="h-8 w-8 text-blue-500 opacity-50" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Tools</p>
                <p className="text-3xl font-bold">{toolList.length}</p>
                <p className="text-xs text-muted-foreground mt-1">{totalUsage} total calls</p>
              </div>
              <Wrench className="h-8 w-8 text-green-500 opacity-50" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Gateways</p>
                <p className="text-3xl font-bold">{gatewayList.length}</p>
                <p className="text-xs text-muted-foreground mt-1">{totalGatewayRequests} requests</p>
              </div>
              <Zap className="h-8 w-8 text-purple-500 opacity-50" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Protocols</p>
                <div className="flex flex-wrap gap-1 mt-2">
                  {[...new Set(gatewayList.map((g: any) => g.type))].map((type: string) => (
                    <Badge key={type} variant="outline" className={cn('text-xs uppercase', protocolColors[type])}>
                      {type}
                    </Badge>
                  ))}
                </div>
              </div>
              <Activity className="h-8 w-8 text-orange-500 opacity-50" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Two-column: APIs + Gateways */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* APIs */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Globe className="h-4 w-4" />
              Connected APIs
            </CardTitle>
          </CardHeader>
          <CardContent>
            {apiList.length === 0 ? (
              <div className="text-center py-6 text-muted-foreground text-sm">
                <p>No APIs connected</p>
                <Link to="/apis" className="text-primary hover:underline text-xs">Import one</Link>
              </div>
            ) : (
              <div className="space-y-2">
                {apiList.map((api: any) => {
                  const ops = api.operations || []
                  const opCount = Array.isArray(ops) ? ops.length : (api.operationCount || 0)
                  return (
                    <Link key={api.id} to={`/apis/${api.id}`} className="flex items-center justify-between p-3 rounded-lg border hover:bg-gray-50 transition-colors">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm truncate">{api.name}</span>
                          <Badge variant={api.status === 'active' ? 'default' : 'secondary'} className="text-xs shrink-0">
                            {api.status}
                          </Badge>
                        </div>
                        <div className="text-xs text-muted-foreground truncate flex items-center gap-1 mt-0.5">
                          <ExternalLink className="h-3 w-3 shrink-0" />
                          {api.baseUrl || 'No URL'}
                        </div>
                      </div>
                      <div className="text-right shrink-0 ml-3">
                        <div className="text-sm font-medium">{opCount}</div>
                        <div className="text-xs text-muted-foreground">ops</div>
                      </div>
                    </Link>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Gateways */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Zap className="h-4 w-4" />
              Gateways
            </CardTitle>
          </CardHeader>
          <CardContent>
            {gatewayList.length === 0 ? (
              <div className="text-center py-6 text-muted-foreground text-sm">
                <p>No gateways configured</p>
                <Link to="/gateways" className="text-primary hover:underline text-xs">Create one</Link>
              </div>
            ) : (
              <div className="space-y-2">
                {gatewayList.map((gw: any) => {
                  const toolCount = gw.tools?.length || gw.toolCount || 0
                  const total = gw.totalRequests || 0
                  const success = gw.successfulRequests || 0
                  return (
                    <Link key={gw.id} to={`/gateways/${gw.id}`} className="flex items-center justify-between p-3 rounded-lg border hover:bg-gray-50 transition-colors">
                      <div className="flex items-center gap-2 min-w-0">
                        <Badge variant="outline" className={cn('text-xs uppercase shrink-0', protocolColors[gw.type])}>
                          {gw.type}
                        </Badge>
                        <div className="min-w-0">
                          <div className="font-medium text-sm truncate">{gw.name}</div>
                          <div className="text-xs text-muted-foreground">{toolCount} tools</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0 ml-3">
                        <div className="text-right">
                          <div className="text-sm font-medium">{total}</div>
                          <div className="text-xs text-muted-foreground">requests</div>
                        </div>
                        {gw.isHealthy !== false ? (
                          <CheckCircle2 className="h-4 w-4 text-green-500" />
                        ) : (
                          <XCircle className="h-4 w-4 text-red-500" />
                        )}
                      </div>
                    </Link>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Tools — with gateway filter */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Wrench className="h-4 w-4" />
                Tools ({filteredTools.length})
              </CardTitle>
              <CardDescription className="mt-1">
                {gatewayFilter !== 'all'
                  ? `Filtered by ${gatewayList.find((g: any) => g.id === gatewayFilter)?.name}`
                  : 'All tools across all gateways'}
              </CardDescription>
            </div>
            {/* Gateway filter */}
            <div className="flex items-center gap-1">
              <Filter className="h-3.5 w-3.5 text-muted-foreground" />
              <div className="flex gap-1">
                <Button
                  variant={gatewayFilter === 'all' ? 'default' : 'outline'}
                  size="sm"
                  className="h-7 text-xs px-2"
                  onClick={() => setGatewayFilter('all')}
                >
                  All
                </Button>
                {gatewayList.map((gw: any) => (
                  <Button
                    key={gw.id}
                    variant={gatewayFilter === gw.id ? 'default' : 'outline'}
                    size="sm"
                    className="h-7 text-xs px-2"
                    onClick={() => setGatewayFilter(gw.id)}
                  >
                    {gw.name.replace('Petstore ', '')}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {filteredTools.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              {gatewayFilter !== 'all'
                ? 'No tools assigned to this gateway'
                : <>No tools generated yet. <Link to="/apis" className="text-primary hover:underline">Import an API</Link></>}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="pb-2 font-medium text-muted-foreground">Tool</th>
                    <th className="pb-2 font-medium text-muted-foreground">Method</th>
                    <th className="pb-2 font-medium text-muted-foreground">Gateways</th>
                    <th className="pb-2 font-medium text-muted-foreground text-right">Calls</th>
                    <th className="pb-2 font-medium text-muted-foreground text-right">Success</th>
                    <th className="pb-2 font-medium text-muted-foreground text-right">Avg Time</th>
                    <th className="pb-2 font-medium text-muted-foreground text-right">Last Used</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedTools.map((tool: any) => {
                    const toolGateways = gatewayList.filter((gw: any) =>
                      gw.tools?.some((t: any) => t.id === tool.id)
                    )
                    return (
                      <tr key={tool.id} className="border-b last:border-0 hover:bg-gray-50">
                        <td className="py-2.5">
                          <Link to={`/tools/${tool.id}`} className="font-medium hover:underline text-xs">
                            {tool.name}
                          </Link>
                        </td>
                        <td className="py-2.5">
                          <span className="text-xs text-muted-foreground capitalize">{tool.executionMethod || 'http'}</span>
                        </td>
                        <td className="py-2.5">
                          <div className="flex gap-1 flex-wrap">
                            {toolGateways.length > 0 ? toolGateways.map((gw: any) => (
                              <Badge key={gw.id} variant="outline" className={cn('text-[10px] uppercase px-1.5 py-0', protocolColors[gw.type])}>
                                {gw.type}
                              </Badge>
                            )) : (
                              <span className="text-xs text-muted-foreground">none</span>
                            )}
                          </div>
                        </td>
                        <td className="py-2.5 text-right font-medium">{(tool.usageCount || 0).toLocaleString()}</td>
                        <td className="py-2.5 text-right">
                          {tool.usageCount > 0 ? (
                            <span className={cn(
                              'font-medium',
                              tool.successRate >= 90 ? 'text-green-600' :
                              tool.successRate >= 70 ? 'text-yellow-600' : 'text-red-600'
                            )}>
                              {tool.successRate}%
                            </span>
                          ) : (
                            <span className="text-muted-foreground">--</span>
                          )}
                        </td>
                        <td className="py-2.5 text-right text-muted-foreground">{formatMs(tool.averageResponseTime)}</td>
                        <td className="py-2.5 text-right text-xs text-muted-foreground">{formatDate(tool.lastUsedAt)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {sortedTools.length > 20 && (
                <div className="mt-3 text-center">
                  <Link to="/tools" className="text-xs text-primary hover:underline">
                    View all {toolList.length} tools
                  </Link>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
