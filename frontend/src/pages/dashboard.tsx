import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  Zap,
  Wrench,
  Activity,
  Globe,
  AlertTriangle,
} from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { StatCard } from '@/components/ui/stat-card'
import { gatewaysApi, toolsApi, apisApi, analyticsApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'

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
  const apisWithNoTools = apis.filter((a: any) => {
    const apiTools = tools.filter((t: any) => t.apiId === a.id)
    return apiTools.length === 0
  })

  // Action items: Gateways with no API keys (no auth configs)
  const gatewaysWithNoKeys = gateways.filter((g: any) => {
    return !g.apiKeyCount && !g.authConfigCount
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

      {/* Resource Stats */}
      <div className="grid gap-4 md:grid-cols-3">
        <StatCard
          icon={Zap}
          label="Gateways"
          value={gateways.length}
          subtitle={`Serving ${tools.length} tools`}
        />
        <StatCard
          icon={Wrench}
          label="Tools"
          value={tools.length}
          subtitle={`Generated from ${apis.length} APIs`}
        />
        <StatCard
          icon={Globe}
          label="APIs"
          value={apis.length}
          subtitle={`${apis.filter((a: any) => a.status === 'active').length} active`}
        />
      </div>

      {/* Quick Actions */}
      <Card>
        <CardHeader>
          <CardTitle>Quick Actions</CardTitle>
          <CardDescription>
            Get started with common tasks
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-3">
            <Button
              className="h-24 flex-col space-y-2"
              variant="outline"
              onClick={() => navigate('/gateways')}
            >
              <Zap className="h-6 w-6" />
              <span>Create Gateway</span>
            </Button>
            <Button
              className="h-24 flex-col space-y-2"
              variant="outline"
              onClick={() => navigate('/apis')}
            >
              <Globe className="h-6 w-6" />
              <span>Add API</span>
            </Button>
            <Button
              className="h-24 flex-col space-y-2"
              variant="outline"
              onClick={() => navigate('/tools')}
            >
              <Wrench className="h-6 w-6" />
              <span>Create Tool</span>
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Needs Attention */}
      {(apisWithNoTools.length > 0 || gatewaysWithNoKeys.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Needs Attention</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {apisWithNoTools.length > 0 && (
                <div className="flex items-center gap-2 text-sm text-amber-600">
                  <AlertTriangle className="h-4 w-4" />
                  <span>{apisWithNoTools.length} API(s) have no generated tools</span>
                </div>
              )}
              {gatewaysWithNoKeys.length > 0 && (
                <div className="flex items-center gap-2 text-sm text-amber-600">
                  <AlertTriangle className="h-4 w-4" />
                  <span>{gatewaysWithNoKeys.length} gateway(s) have no API keys</span>
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
                  <Badge variant="outline" className="text-xs">{log.method}</Badge>
                  <span className="truncate flex-1 font-mono text-xs">{log.path}</span>
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
