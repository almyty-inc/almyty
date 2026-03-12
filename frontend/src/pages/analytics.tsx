import React from 'react'
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
  Timer,
  Wifi,
  ExternalLink,
  Key,
  ArrowRight,
  BarChart3,
  Hash,
  TrendingUp,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
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

export function AnalyticsPage() {
  const { currentOrganization } = useOrganizationStore()

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

  // Light system health check (just uptime + status)
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

  // Tool stats
  const totalUsage = toolList.reduce((sum: number, t: any) => sum + (t.usageCount || 0), 0)
  const avgSuccessRate = toolList.length > 0
    ? toolList.reduce((sum: number, t: any) => sum + (t.successRate || 0), 0) / toolList.length
    : 0
  const toolsWithUsage = toolList.filter((t: any) => t.usageCount > 0)
  const topTools = [...toolList].sort((a: any, b: any) => (b.usageCount || 0) - (a.usageCount || 0)).slice(0, 10)

  // Gateway stats
  const totalGatewayRequests = gatewayList.reduce((sum: number, g: any) => sum + (g.totalRequests || 0), 0)
  const totalGatewaySuccess = gatewayList.reduce((sum: number, g: any) => sum + (g.successfulRequests || 0), 0)

  // API stats
  const activeApis = apiList.filter((a: any) => a.status === 'active')
  const totalOperations = apiList.reduce((sum: number, a: any) => {
    const ops = a.operations || a.operationCount || 0
    return sum + (Array.isArray(ops) ? ops.length : ops)
  }, 0)

  // Auth methods across APIs
  const authMethods = apiList.reduce((acc: Record<string, number>, api: any) => {
    const auth = api.authentication?.type || 'none'
    acc[auth] = (acc[auth] || 0) + 1
    return acc
  }, {} as Record<string, number>)

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
                <p className="text-xs text-muted-foreground mt-1">
                  {totalOperations} operations parsed
                </p>
              </div>
              <Globe className="h-8 w-8 text-blue-500 opacity-50" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Generated Tools</p>
                <p className="text-3xl font-bold">{toolList.length}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {toolsWithUsage.length} used at least once
                </p>
              </div>
              <Wrench className="h-8 w-8 text-green-500 opacity-50" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Gateway Requests</p>
                <p className="text-3xl font-bold">{totalGatewayRequests.toLocaleString()}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {totalGatewaySuccess} successful
                </p>
              </div>
              <Zap className="h-8 w-8 text-purple-500 opacity-50" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Tool Calls</p>
                <p className="text-3xl font-bold">{totalUsage.toLocaleString()}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {avgSuccessRate > 0 ? `${avgSuccessRate.toFixed(0)}% avg success` : 'No calls yet'}
                </p>
              </div>
              <Activity className="h-8 w-8 text-orange-500 opacity-50" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Connected APIs */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Globe className="h-4 w-4" />
            Connected APIs
          </CardTitle>
          <CardDescription>Data sources feeding your tool library</CardDescription>
        </CardHeader>
        <CardContent>
          {apiList.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Globe className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p>No APIs connected yet</p>
              <Link to="/apis" className="text-sm text-primary hover:underline">Import an API</Link>
            </div>
          ) : (
            <div className="space-y-3">
              {apiList.map((api: any) => {
                const ops = api.operations || []
                const opCount = Array.isArray(ops) ? ops.length : (api.operationCount || 0)
                const toolsFromApi = toolList.filter((t: any) => {
                  if (!t.operationId) return false
                  if (Array.isArray(ops)) {
                    return ops.some((op: any) => op.id === t.operationId)
                  }
                  return false
                })
                const authType = api.authentication?.type || 'none'

                return (
                  <div key={api.id} className="border rounded-lg p-4">
                    <div className="flex items-start justify-between">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <Link to={`/apis/${api.id}`} className="font-medium text-sm hover:underline">
                            {api.name}
                          </Link>
                          <Badge variant={api.status === 'active' ? 'default' : 'secondary'} className="text-xs">
                            {api.status}
                          </Badge>
                          <Badge variant="outline" className="text-xs">{api.type || 'openapi'}</Badge>
                        </div>
                        <div className="text-xs text-muted-foreground flex items-center gap-1">
                          <ExternalLink className="h-3 w-3" />
                          {api.baseUrl || 'No base URL'}
                        </div>
                      </div>
                      <div className="text-right text-sm">
                        <div className="font-medium">{opCount} operations</div>
                        <div className="text-xs text-muted-foreground">
                          {toolsFromApi.length > 0 ? `${toolsFromApi.length} tools generated` : `${toolList.length > 0 ? toolList.length : opCount} tools`}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-4 mt-3 pt-3 border-t text-xs text-muted-foreground">
                      <div className="flex items-center gap-1">
                        <Key className="h-3 w-3" />
                        Auth: <span className="font-medium capitalize">{authType}</span>
                      </div>
                      {api.version && (
                        <div className="flex items-center gap-1">
                          <Hash className="h-3 w-3" />
                          v{api.version}
                        </div>
                      )}
                      <div className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        Added {formatDate(api.createdAt)}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Gateway Traffic */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Zap className="h-4 w-4" />
            Gateway Traffic
          </CardTitle>
          <CardDescription>Protocol endpoints and their usage</CardDescription>
        </CardHeader>
        <CardContent>
          {gatewayList.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Zap className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p>No gateways configured yet</p>
              <Link to="/gateways" className="text-sm text-primary hover:underline">Create a gateway</Link>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="pb-2 font-medium text-muted-foreground">Gateway</th>
                    <th className="pb-2 font-medium text-muted-foreground">Protocol</th>
                    <th className="pb-2 font-medium text-muted-foreground text-right">Tools</th>
                    <th className="pb-2 font-medium text-muted-foreground text-right">Requests</th>
                    <th className="pb-2 font-medium text-muted-foreground text-right">Success</th>
                    <th className="pb-2 font-medium text-muted-foreground text-right">Last Activity</th>
                    <th className="pb-2 font-medium text-muted-foreground text-center">Health</th>
                    <th className="pb-2 font-medium text-muted-foreground">Auth</th>
                  </tr>
                </thead>
                <tbody>
                  {gatewayList.map((gw: any) => {
                    const toolCount = gw.tools?.length || gw.toolCount || 0
                    const total = gw.totalRequests || 0
                    const success = gw.successfulRequests || 0
                    const successRate = total > 0 ? ((success / total) * 100).toFixed(1) : '--'
                    const authCount = gw.authConfigs?.length || 0
                    const authTypes = gw.authConfigs?.map((a: any) => a.type).filter(Boolean) || []

                    return (
                      <tr key={gw.id} className="border-b last:border-0 hover:bg-gray-50">
                        <td className="py-3">
                          <Link to={`/gateways/${gw.id}`} className="font-medium hover:underline">
                            {gw.name}
                          </Link>
                          <div className="text-xs text-muted-foreground">{gw.endpoint}</div>
                        </td>
                        <td className="py-3">
                          <Badge
                            variant="outline"
                            className={cn('text-xs uppercase', {
                              'bg-blue-50 text-blue-700 border-blue-200': gw.type === 'mcp',
                              'bg-purple-50 text-purple-700 border-purple-200': gw.type === 'utcp',
                              'bg-green-50 text-green-700 border-green-200': gw.type === 'a2a',
                              'bg-orange-50 text-orange-700 border-orange-200': gw.type === 'skills',
                            })}
                          >
                            {gw.type}
                          </Badge>
                        </td>
                        <td className="py-3 text-right font-medium">{toolCount}</td>
                        <td className="py-3 text-right font-medium">{total.toLocaleString()}</td>
                        <td className="py-3 text-right">
                          {successRate !== '--' ? (
                            <span className={cn(
                              'font-medium',
                              parseFloat(successRate) >= 95 ? 'text-green-600' :
                              parseFloat(successRate) >= 80 ? 'text-yellow-600' : 'text-red-600'
                            )}>
                              {successRate}%
                            </span>
                          ) : (
                            <span className="text-muted-foreground">--</span>
                          )}
                        </td>
                        <td className="py-3 text-right text-muted-foreground text-xs">
                          {formatDate(gw.lastRequestAt)}
                        </td>
                        <td className="py-3 text-center">
                          {gw.isHealthy !== false ? (
                            <CheckCircle2 className="h-4 w-4 text-green-500 mx-auto" />
                          ) : (
                            <XCircle className="h-4 w-4 text-red-500 mx-auto" />
                          )}
                        </td>
                        <td className="py-3">
                          {authTypes.length > 0 ? (
                            <div className="flex items-center gap-1">
                              <Shield className="h-3 w-3 text-muted-foreground" />
                              <span className="text-xs capitalize">{authTypes.join(', ')}</span>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">None</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Tools by Gateway */}
      {gatewayList.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              Tools by Gateway
            </CardTitle>
            <CardDescription>Which tools are served through which gateway</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {gatewayList.map((gw: any) => {
                const gwTools = gw.tools || []
                const gwToolUsage = gwTools.reduce((sum: number, t: any) => sum + (t.usageCount || 0), 0)
                const badgeMap: Record<string, string> = {
                  mcp: 'bg-blue-50 text-blue-700 border-blue-200',
                  utcp: 'bg-purple-50 text-purple-700 border-purple-200',
                  a2a: 'bg-green-50 text-green-700 border-green-200',
                  skills: 'bg-orange-50 text-orange-700 border-orange-200',
                }
                const typeBadgeClass = badgeMap[gw.type] || 'bg-gray-50 text-gray-700 border-gray-200'

                return (
                  <div key={gw.id} className="border rounded-lg">
                    <div className="flex items-center justify-between p-3 bg-gray-50 rounded-t-lg">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className={cn('text-xs uppercase', typeBadgeClass)}>
                          {gw.type}
                        </Badge>
                        <Link to={`/gateways/${gw.id}`} className="font-medium text-sm hover:underline">
                          {gw.name}
                        </Link>
                      </div>
                      <div className="flex items-center gap-4 text-xs text-muted-foreground">
                        <span>{gwTools.length} tools</span>
                        <span>{gwToolUsage} total calls</span>
                        <span>{(gw.totalRequests || 0)} gateway requests</span>
                      </div>
                    </div>
                    {gwTools.length > 0 ? (
                      <div className="p-3">
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                          {gwTools.slice(0, 12).map((tool: any) => (
                            <div key={tool.id} className="flex items-center justify-between p-2 rounded border text-xs">
                              <Link to={`/tools/${tool.id}`} className="font-medium truncate hover:underline max-w-[60%]">
                                {tool.name}
                              </Link>
                              <div className="flex items-center gap-2 text-muted-foreground">
                                <span>{tool.usageCount || 0} calls</span>
                                {tool.usageCount > 0 && (
                                  <span className={cn(
                                    tool.successRate >= 90 ? 'text-green-600' :
                                    tool.successRate >= 70 ? 'text-yellow-600' : 'text-red-600'
                                  )}>
                                    {tool.successRate}%
                                  </span>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                        {gwTools.length > 12 && (
                          <p className="text-xs text-muted-foreground mt-2">
                            +{gwTools.length - 12} more tools
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="p-3 text-xs text-muted-foreground text-center">
                        No tools assigned to this gateway
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Tool Usage */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Wrench className="h-4 w-4" />
            Tool Usage
          </CardTitle>
          <CardDescription>
            {toolsWithUsage.length > 0
              ? `${toolsWithUsage.length} of ${toolList.length} tools have been called`
              : `${toolList.length} tools generated, none called yet`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {toolList.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Wrench className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p>No tools generated yet</p>
              <Link to="/apis" className="text-sm text-primary hover:underline">Import an API to generate tools</Link>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="pb-2 font-medium text-muted-foreground">Tool</th>
                    <th className="pb-2 font-medium text-muted-foreground">Type</th>
                    <th className="pb-2 font-medium text-muted-foreground">Method</th>
                    <th className="pb-2 font-medium text-muted-foreground text-right">Calls</th>
                    <th className="pb-2 font-medium text-muted-foreground text-right">Success Rate</th>
                    <th className="pb-2 font-medium text-muted-foreground text-right">Avg Response</th>
                    <th className="pb-2 font-medium text-muted-foreground text-right">Last Used</th>
                  </tr>
                </thead>
                <tbody>
                  {topTools.map((tool: any) => (
                    <tr key={tool.id} className="border-b last:border-0 hover:bg-gray-50">
                      <td className="py-2.5">
                        <Link to={`/tools/${tool.id}`} className="font-medium hover:underline text-xs">
                          {tool.name}
                        </Link>
                      </td>
                      <td className="py-2.5">
                        <Badge variant="outline" className="text-xs capitalize">{tool.type || 'function'}</Badge>
                      </td>
                      <td className="py-2.5">
                        <span className="text-xs text-muted-foreground capitalize">{tool.executionMethod || 'http'}</span>
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
                      <td className="py-2.5 text-right text-muted-foreground">
                        {formatMs(tool.averageResponseTime)}
                      </td>
                      <td className="py-2.5 text-right text-xs text-muted-foreground">
                        {formatDate(tool.lastUsedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {toolList.length > 10 && (
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
