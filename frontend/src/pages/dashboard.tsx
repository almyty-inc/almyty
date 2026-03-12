import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  BarChart3,
  Users,
  Zap,
  Activity,
  Globe,
  Server,
} from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { gatewaysApi, toolsApi, apisApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'

export function DashboardPage() {
  const { currentOrganization } = useOrganizationStore()
  const navigate = useNavigate()

  const { data: gatewaysData, isLoading: loadingGateways } = useQuery({
    queryKey: ['gateways', currentOrganization?.id],
    queryFn: () => gatewaysApi.getAll(),
    enabled: !!currentOrganization,
  })

  const { data: toolsData, isLoading: loadingTools } = useQuery({
    queryKey: ['tools', currentOrganization?.id],
    queryFn: () => toolsApi.getAll(currentOrganization?.id),
    enabled: !!currentOrganization,
  })

  const { data: apisData, isLoading: loadingApis } = useQuery({
    queryKey: ['apis'],
    queryFn: () => apisApi.getAll(),
    enabled: !!currentOrganization,
  })

  const isLoading = loadingGateways && loadingTools && loadingApis

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  const gateways = gatewaysData?.data?.data?.gateways || gatewaysData?.data?.data || []
  const tools = toolsData?.data?.data?.tools || toolsData?.data?.tools || []
  const apis = apisData?.data?.data?.apis || apisData?.data?.data || apisData?.data || []

  return (
    <div className="space-y-8">
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

      {/* Resource Stats — Real data from actual API queries */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Gateways</CardTitle>
            <Zap className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{gateways.length}</div>
            <p className="text-xs text-muted-foreground">
              Serving {tools.length} tools
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Tools</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{tools.length}</div>
            <p className="text-xs text-muted-foreground">
              Generated from {apis.length} APIs
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">APIs</CardTitle>
            <Server className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{apis.length}</div>
            <p className="text-xs text-muted-foreground">
              {apis.filter((a: any) => a.status === 'active').length} active
            </p>
          </CardContent>
        </Card>
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
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
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
              onClick={() => navigate('/settings')}
            >
              <Users className="h-6 w-6" />
              <span>Invite Team</span>
            </Button>
            <Button
              className="h-24 flex-col space-y-2"
              variant="outline"
              onClick={() => navigate('/analytics')}
            >
              <BarChart3 className="h-6 w-6" />
              <span>View Analytics</span>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
