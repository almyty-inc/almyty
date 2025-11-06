import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  BarChart3,
  Users,
  Zap,
  Activity,
  TrendingUp,
  TrendingDown,
  ArrowUpRight,
  ArrowDownRight,
  Globe,
} from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { analyticsApi, gatewaysApi, toolsApi } from '@/lib/api'
import { formatNumber, formatCurrency } from '@/lib/utils'
import { useOrganizationStore } from '@/store/organization'

export function DashboardPage() {
  const { currentOrganization } = useOrganizationStore()
  const navigate = useNavigate()

  const { data: dashboardData, isLoading } = useQuery({
    queryKey: ['dashboard', currentOrganization?.id],
    queryFn: () => analyticsApi.getDashboard(),
    enabled: !!currentOrganization,
    refetchInterval: 30000, // Refresh every 30 seconds
  })

  const { data: gatewaysData } = useQuery({
    queryKey: ['gateways', currentOrganization?.id],
    queryFn: () => gatewaysApi.getAll(),
    enabled: !!currentOrganization,
  })

  const { data: toolsData } = useQuery({
    queryKey: ['tools', currentOrganization?.id],
    queryFn: () => toolsApi.getAll(currentOrganization?.id),
    enabled: !!currentOrganization,
  })

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  const dashboard = dashboardData?.data
  const gateways = gatewaysData?.data?.data?.gateways || gatewaysData?.data?.data || []
  const tools = toolsData?.data?.data?.tools || toolsData?.data?.tools || []

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


      {/* Metrics Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Requests</CardTitle>
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {dashboard?.totalRequests ? formatNumber(dashboard.totalRequests) : '0'}
            </div>
            <div className="flex items-center text-xs text-muted-foreground">
              {dashboard?.metrics?.requests?.change ? (
                dashboard.metrics.requests.change > 0 ? (
                  <>
                    <TrendingUp className="mr-1 h-3 w-3 text-green-500" />
                    <span className="text-green-500">
                      +{dashboard.metrics.requests.change}%
                    </span>
                  </>
                ) : (
                  <>
                    <TrendingDown className="mr-1 h-3 w-3 text-red-500" />
                    <span className="text-red-500">
                      {dashboard.metrics.requests.change}%
                    </span>
                  </>
                )
              ) : (
                <span>No change</span>
              )} from last month
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Users</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {dashboard?.totalUsers ? formatNumber(dashboard.totalUsers) : '0'}
            </div>
            <p className="text-xs text-muted-foreground">
              Across {dashboard?.totalOrganizations || 0} organizations
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Response Time</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {dashboard?.metrics?.responseTime?.current || 0}ms
            </div>
            <div className="flex items-center text-xs text-muted-foreground">
              {dashboard?.metrics?.responseTime?.change ? (
                dashboard.metrics.responseTime.change < 0 ? (
                  <>
                    <ArrowDownRight className="mr-1 h-3 w-3 text-green-500" />
                    <span className="text-green-500">
                      {dashboard.metrics.responseTime.change}%
                    </span>
                  </>
                ) : (
                  <>
                    <ArrowUpRight className="mr-1 h-3 w-3 text-red-500" />
                    <span className="text-red-500">
                      +{dashboard.metrics.responseTime.change}%
                    </span>
                  </>
                )
              ) : (
                <span>No change</span>
              )} from last hour
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Costs</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {dashboard?.metrics?.costs?.current ?
                formatCurrency(dashboard.metrics.costs.current) : '$0.00'
              }
            </div>
            <p className="text-xs text-muted-foreground">
              This month
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Recent Activity & Quick Stats */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
        <Card className="col-span-4">
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
            <CardDescription>
              Latest events across your gateways and tools
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {dashboard?.recentActivity?.map((activity: any) => (
                <div key={activity.id} className="flex items-center space-x-4">
                  <div className="w-2 h-2 bg-blue-500 rounded-full" />
                  <div className="flex-1">
                    <p className="text-sm font-medium">{activity.description}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(activity.timestamp).toLocaleString()}
                    </p>
                  </div>
                </div>
              )) || (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No recent activity
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="col-span-3">
          <CardHeader>
            <CardTitle>Quick Stats</CardTitle>
            <CardDescription>
              Overview of your resources
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Zap className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">Gateways</span>
              </div>
              <span className="text-2xl font-bold">
                {gateways.length}
              </span>
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Activity className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">Tools</span>
              </div>
              <span className="text-2xl font-bold">
                {tools.length}
              </span>
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <BarChart3 className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">Error Rate</span>
              </div>
              <span className="text-2xl font-bold">
                {dashboard?.metrics?.errorRate?.current || 0}%
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Action Items */}
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