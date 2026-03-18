import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  Activity,
  AlertTriangle,
  ArrowRight,
} from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { gatewaysApi, toolsApi, apisApi, analyticsApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'

// Helper to humanize a log path
const humanizePath = (path: string, method: string) => {
  if (path.includes('/mcp/')) return `MCP ${method} request`
  if (path.includes('/a2a/')) return `A2A agent discovery`
  if (path.includes('/utcp/')) return `UTCP manifest request`
  if (path.includes('/auth/api-keys')) return `API key check`
  if (path.includes('/auth')) return `Auth check on gateway`
  if (path.includes('/tools')) return `Tools listing`
  // Truncate UUIDs
  return `${method} ${path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '...')}`
}

export function DashboardPage() {
  const { currentOrganization } = useOrganizationStore()
  const orgId = currentOrganization?.id
  const navigate = useNavigate()

  const { data: gatewaysData, isLoading: loadingGateways } = useQuery({
    queryKey: ['gateways', orgId],
    queryFn: () => gatewaysApi.getAll(),
    enabled: !!currentOrganization,
  })

  const { data: toolsData, isLoading: loadingTools } = useQuery({
    queryKey: ['tools', orgId],
    queryFn: () => toolsApi.getAll(orgId),
    enabled: !!currentOrganization,
  })

  const { data: apisData, isLoading: loadingApis } = useQuery({
    queryKey: ['apis'],
    queryFn: () => apisApi.getAll(),
    enabled: !!currentOrganization,
  })

  const { data: recentLogsData } = useQuery({
    queryKey: ['analytics', 'recent-logs', orgId],
    queryFn: async () => {
      const res = await analyticsApi.getRequestLogs({ page: '1', limit: '10' })
      return res.data
    },
    enabled: !!orgId,
  })

  const isLoading = loadingGateways && loadingTools && loadingApis

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  const gatewaysExtracted = gatewaysData?.data?.data?.gateways || gatewaysData?.data?.data || []
  const gateways = Array.isArray(gatewaysExtracted) ? gatewaysExtracted : []
  const toolsExtracted = toolsData?.data?.data?.tools || toolsData?.data?.tools || []
  const tools = Array.isArray(toolsExtracted) ? toolsExtracted : []
  const apisExtracted = apisData?.data?.data?.apis || apisData?.data?.apis || apisData?.data?.data || []
  const apis = Array.isArray(apisExtracted) ? apisExtracted : []

  const recentLogs = recentLogsData?.data || []

  // Action items: APIs with no generated tools
  // Tools connect to APIs through operations, not directly via apiId
  const apisWithNoTools = apis.filter((a: any) => {
    // Check via operations.tools (if loaded) or via tool metadata
    const hasToolsViaOps = a.operations?.some((op: any) => op.tools?.length > 0)
    const hasToolsViaMeta = tools.some((t: any) =>
      t.metadata?.sourceApi?.id === a.id ||
      t.metadata?.apiId === a.id ||
      a.operations?.some((op: any) => op.id === t.operationId)
    )
    return !hasToolsViaOps && !hasToolsViaMeta
  })

  // Action items: Gateways with no auth configured
  // Check authConfigs array, not a count field
  const gatewaysWithNoAuth = gateways.filter((g: any) => {
    return !g.authConfigs?.length && !g.authMethods?.length
  })

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground">
            Overview of your APIs and tools
          </p>
        </div>
        <div className="flex items-center space-x-2">
          <Badge variant="outline">
            {currentOrganization?.name || 'No Organization'}
          </Badge>
          <Button variant="outline" onClick={() => navigate('/analytics')}>
            <Activity className="mr-2 h-4 w-4" />
            View Analytics
          </Button>
        </div>
      </div>

      {/* Pipeline: APIs → Tools → Gateways */}
      <Card>
        <CardContent className="py-6">
          <div className="flex items-center justify-between gap-4">
            <button onClick={() => navigate('/apis')} className="flex-1 text-center p-4 rounded-lg border hover:border-primary hover:bg-primary/5 transition-colors cursor-pointer">
              <div className="text-2xl font-bold">{apis.length}</div>
              <div className="text-sm text-muted-foreground">APIs Connected</div>
            </button>
            <ArrowRight className="h-5 w-5 text-muted-foreground shrink-0" />
            <button onClick={() => navigate('/tools')} className="flex-1 text-center p-4 rounded-lg border hover:border-primary hover:bg-primary/5 transition-colors cursor-pointer">
              <div className="text-2xl font-bold">{tools.length}</div>
              <div className="text-sm text-muted-foreground">Tools Generated</div>
            </button>
            <ArrowRight className="h-5 w-5 text-muted-foreground shrink-0" />
            <button onClick={() => navigate('/gateways')} className="flex-1 text-center p-4 rounded-lg border hover:border-primary hover:bg-primary/5 transition-colors cursor-pointer">
              <div className="text-2xl font-bold">{gateways.length}</div>
              <div className="text-sm text-muted-foreground">Gateways Serving</div>
            </button>
          </div>
        </CardContent>
      </Card>

      {/* Needs Attention */}
      {(apisWithNoTools.length > 0 || gatewaysWithNoAuth.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Needs Attention</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {apisWithNoTools.length > 0 && (
                <div
                  className="flex items-center gap-2 text-sm text-amber-600 cursor-pointer hover:underline"
                  onClick={() => navigate('/apis')}
                >
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  <span>{apisWithNoTools.length} API(s) have no generated tools</span>
                </div>
              )}
              {gatewaysWithNoAuth.length > 0 && (
                <div
                  className="flex items-center gap-2 text-sm text-amber-600 cursor-pointer hover:underline"
                  onClick={() => navigate('/gateways')}
                >
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  <span>{gatewaysWithNoAuth.length} gateway(s) have no authentication configured</span>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recent Activity */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Recent Activity</CardTitle>
        </CardHeader>
        <CardContent>
          {recentLogs.length > 0 ? (
            <div className="space-y-2">
              {recentLogs.map((log: any, i: number) => (
                <div key={log.id || i} className="flex items-center gap-3 text-sm py-1.5 border-b last:border-0">
                  <span className="text-muted-foreground text-xs w-32 shrink-0">
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </span>
                  <span className="truncate flex-1 text-xs">{humanizePath(log.path, log.method)}</span>
                  <Badge variant={log.statusCode < 400 ? 'default' : 'destructive'} className="text-xs">
                    {log.statusCode}
                  </Badge>
                  {log.protocol && (
                    <Badge variant="outline" className="text-xs uppercase">{log.protocol}</Badge>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-center py-4">No recent activity</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
