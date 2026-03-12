import React from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Target,
  Server,
  Zap,
  Activity,
  BarChart3,
  TrendingUp,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Wrench,
  Bot,
  Brain,
  Globe,
  Shield,
  ArrowUpRight,
  ArrowDownRight,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { gatewaysApi, toolsApi, apisApi, llmProvidersApi, analyticsApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'
import { LoadingSpinner } from '@/components/ui/loading-spinner'

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

  const { data: providers = [] } = useQuery({
    queryKey: ['llm-providers'],
    queryFn: async () => {
      const response = await llmProvidersApi.getAll()
      return response.data?.data?.providers || []
    },
  })

  const { data: dashboardData } = useQuery({
    queryKey: ['analytics-dashboard'],
    queryFn: async () => {
      try {
        const response = await analyticsApi.getDashboard()
        return response.data
      } catch {
        return null
      }
    },
  })

  const isLoading = loadingTools || loadingGateways || loadingApis

  const toolCount = Array.isArray(tools) ? tools.length : 0
  const gatewayCount = Array.isArray(gateways) ? gateways.length : 0
  const apiCount = Array.isArray(apis) ? apis.length : 0
  const providerCount = Array.isArray(providers) ? providers.length : 0

  // Derive stats from real data
  const activeGateways = Array.isArray(gateways) ? gateways.filter((g: any) => g.status === 'active').length : 0
  const activeApis = Array.isArray(apis) ? apis.filter((a: any) => a.status === 'active').length : 0
  const activeProviders = Array.isArray(providers) ? providers.filter((p: any) => p.status === 'active').length : 0

  // Tool types breakdown
  const toolsByType = Array.isArray(tools) ? tools.reduce((acc: Record<string, number>, tool: any) => {
    const type = tool.type || 'unknown'
    acc[type] = (acc[type] || 0) + 1
    return acc
  }, {} as Record<string, number>) : {}

  // Gateway types breakdown
  const gatewaysByType = Array.isArray(gateways) ? gateways.reduce((acc: Record<string, number>, gw: any) => {
    const type = gw.type || 'unknown'
    acc[type] = (acc[type] || 0) + 1
    return acc
  }, {} as Record<string, number>) : {}

  // Tool execution method breakdown
  const toolsByMethod = Array.isArray(tools) ? tools.reduce((acc: Record<string, number>, tool: any) => {
    const method = tool.executionMethod || 'http'
    acc[method] = (acc[method] || 0) + 1
    return acc
  }, {} as Record<string, number>) : {}

  // Provider cost totals
  const totalProviderCost = Array.isArray(providers)
    ? providers.reduce((sum: number, p: any) => sum + (p.totalCost || 0), 0)
    : 0
  const totalProviderRequests = Array.isArray(providers)
    ? providers.reduce((sum: number, p: any) => sum + (p.totalRequests || 0), 0)
    : 0

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Analytics</h1>
        <p className="text-muted-foreground">
          Platform overview and resource metrics
        </p>
      </div>

      {/* Top-level KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">APIs</CardTitle>
            <Globe className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{apiCount}</div>
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3 text-green-500" />
              {activeApis} active
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Tools</CardTitle>
            <Wrench className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{toolCount}</div>
            <p className="text-xs text-muted-foreground">
              From {apiCount} API{apiCount !== 1 ? 's' : ''}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Gateways</CardTitle>
            <Zap className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{gatewayCount}</div>
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3 text-green-500" />
              {activeGateways} active
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">LLM Providers</CardTitle>
            <Brain className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{providerCount}</div>
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3 text-green-500" />
              {activeProviders} active
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Detailed Breakdowns */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Tool Types */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Tools by Type</CardTitle>
            <CardDescription>Distribution of tool types in your organization</CardDescription>
          </CardHeader>
          <CardContent>
            {Object.keys(toolsByType).length === 0 ? (
              <p className="text-sm text-muted-foreground">No tools yet</p>
            ) : (
              <div className="space-y-3">
                {Object.entries(toolsByType).map(([type, count]) => (
                  <div key={type} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs capitalize">{type}</Badge>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-24 h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-blue-500 rounded-full"
                          style={{ width: `${(count / toolCount) * 100}%` }}
                        />
                      </div>
                      <span className="text-sm font-medium w-8 text-right">{count}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Gateway Types */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Gateways by Protocol</CardTitle>
            <CardDescription>Distribution across protocol types</CardDescription>
          </CardHeader>
          <CardContent>
            {Object.keys(gatewaysByType).length === 0 ? (
              <p className="text-sm text-muted-foreground">No gateways yet</p>
            ) : (
              <div className="space-y-3">
                {Object.entries(gatewaysByType).map(([type, count]) => (
                  <div key={type} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs uppercase">{type}</Badge>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-24 h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-purple-500 rounded-full"
                          style={{ width: `${(count / gatewayCount) * 100}%` }}
                        />
                      </div>
                      <span className="text-sm font-medium w-8 text-right">{count}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Execution Methods */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Execution Methods</CardTitle>
            <CardDescription>How tools execute their logic</CardDescription>
          </CardHeader>
          <CardContent>
            {Object.keys(toolsByMethod).length === 0 ? (
              <p className="text-sm text-muted-foreground">No tools yet</p>
            ) : (
              <div className="space-y-3">
                {Object.entries(toolsByMethod).map(([method, count]) => (
                  <div key={method} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs capitalize">{method}</Badge>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-24 h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-green-500 rounded-full"
                          style={{ width: `${(count / toolCount) * 100}%` }}
                        />
                      </div>
                      <span className="text-sm font-medium w-8 text-right">{count}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* LLM Provider Usage */}
      {providerCount > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">LLM Provider Overview</CardTitle>
            <CardDescription>Cost and usage across configured providers</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div className="bg-gray-50 rounded-lg p-4">
                <div className="text-sm text-muted-foreground">Total LLM Cost</div>
                <div className="text-2xl font-bold">${totalProviderCost.toFixed(2)}</div>
              </div>
              <div className="bg-gray-50 rounded-lg p-4">
                <div className="text-sm text-muted-foreground">Total LLM Requests</div>
                <div className="text-2xl font-bold">{totalProviderRequests.toLocaleString()}</div>
              </div>
            </div>
            <div className="space-y-3">
              {providers.map((provider: any) => (
                <div key={provider.id} className="flex items-center justify-between p-3 border rounded-lg">
                  <div className="flex items-center gap-3">
                    <div className={`w-2 h-2 rounded-full ${provider.status === 'active' ? 'bg-green-500' : 'bg-gray-300'}`} />
                    <div>
                      <div className="font-medium text-sm">{provider.name}</div>
                      <div className="text-xs text-muted-foreground">{provider.type} · {provider.configuration?.model || 'default'}</div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-medium">${(provider.totalCost || 0).toFixed(2)}</div>
                    <div className="text-xs text-muted-foreground">{(provider.totalRequests || 0)} requests</div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Gateway Details Table */}
      {gatewayCount > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Gateway Status</CardTitle>
            <CardDescription>All gateways and their current status</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {gateways.map((gw: any) => (
                <div key={gw.id} className="flex items-center justify-between p-3 border rounded-lg hover:bg-gray-50 transition-colors">
                  <div className="flex items-center gap-3">
                    <Zap className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <div className="font-medium text-sm">{gw.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {gw.endpoint || gw.id.slice(0, 8)}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge variant="outline" className="text-xs uppercase">{gw.type}</Badge>
                    <Badge variant={gw.status === 'active' ? 'default' : 'secondary'} className="text-xs">
                      {gw.status}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {gw.toolCount || 0} tools
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* API Status */}
      {apiCount > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">API Status</CardTitle>
            <CardDescription>Connected APIs and their schemas</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {(Array.isArray(apis) ? apis : []).map((api: any) => (
                <div key={api.id} className="flex items-center justify-between p-3 border rounded-lg hover:bg-gray-50 transition-colors">
                  <div className="flex items-center gap-3">
                    <Globe className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <div className="font-medium text-sm">{api.name}</div>
                      <div className="text-xs text-muted-foreground">{api.baseUrl || 'No base URL'}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge variant="outline" className="text-xs">{api.type || 'openapi'}</Badge>
                    <Badge variant={api.status === 'active' ? 'default' : 'secondary'} className="text-xs">
                      {api.status}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Platform Health (from enterprise dashboard if available) */}
      {dashboardData && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Platform Health</CardTitle>
            <CardDescription>System monitoring and compliance</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-green-50 rounded-lg p-3">
                <div className="text-xs text-muted-foreground">PII Filtering</div>
                <div className="flex items-center gap-1 mt-1">
                  <Shield className="h-4 w-4 text-green-600" />
                  <span className="text-sm font-medium text-green-700">Enabled</span>
                </div>
              </div>
              <div className="bg-green-50 rounded-lg p-3">
                <div className="text-xs text-muted-foreground">Security Scanning</div>
                <div className="flex items-center gap-1 mt-1">
                  <Shield className="h-4 w-4 text-green-600" />
                  <span className="text-sm font-medium text-green-700">Enabled</span>
                </div>
              </div>
              <div className="bg-green-50 rounded-lg p-3">
                <div className="text-xs text-muted-foreground">Audit Logging</div>
                <div className="flex items-center gap-1 mt-1">
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                  <span className="text-sm font-medium text-green-700">90-day retention</span>
                </div>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-xs text-muted-foreground">Active Alerts</div>
                <div className="flex items-center gap-1 mt-1">
                  {(dashboardData as any)?.alerts?.total > 0 ? (
                    <>
                      <AlertTriangle className="h-4 w-4 text-yellow-600" />
                      <span className="text-sm font-medium">{(dashboardData as any).alerts.total}</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="h-4 w-4 text-green-600" />
                      <span className="text-sm font-medium text-green-700">None</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
