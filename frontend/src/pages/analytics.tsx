import React, { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  DollarSign,
  Clock,
  CheckCircle2,
  Target,
  Server,
  Zap,
  TrendingUp,
  TrendingDown,
  RefreshCw,
  Download,
  AlertTriangle,
  BarChart3,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { analyticsApi, gatewaysApi, toolsApi, apisApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'

interface DashboardMetrics {
  totalRequests: number
  totalCost: number
  avgResponseTime: number
  successRate: number
  activeTools: number
  activeGateways: number
  activeApis: number
  trends?: {
    requests?: number
    cost?: number
    responseTime?: number
    successRate?: number
  }
}

export function AnalyticsPage() {
  const [selectedDateRange, setSelectedDateRange] = useState('7d')
  const { currentOrganization } = useOrganizationStore()

  const { data: tools = [], isLoading: loadingTools } = useQuery({
    queryKey: ['tools', currentOrganization?.id],
    queryFn: async () => {
      const response = await toolsApi.getAll(currentOrganization?.id)
      return response.data
    },
    enabled: !!currentOrganization,
  })

  const { data: gateways = [], isLoading: loadingGateways } = useQuery({
    queryKey: ['gateways', currentOrganization?.id],
    queryFn: async () => {
      const response = await gatewaysApi.getAll(currentOrganization?.id)
      return response.data
    },
    enabled: !!currentOrganization,
  })

  const { data: apis = [], isLoading: loadingApis } = useQuery({
    queryKey: ['apis'],
    queryFn: async () => {
      const response = await apisApi.getAll()
      return response.data
    },
  })

  const { data: dashboardData, isLoading: loadingDashboard, refetch: refetchDashboard } = useQuery({
    queryKey: ['dashboard-metrics', selectedDateRange],
    queryFn: async () => {
      try {
        const response = await analyticsApi.getDashboard()
        return response.data
      } catch (error: any) {
        // If dashboard endpoint doesn't exist or fails, return calculated metrics
        return null
      }
    },
  })

  const { data: usageMetrics } = useQuery({
    queryKey: ['usage-metrics', selectedDateRange],
    queryFn: async () => {
      try {
        const response = await analyticsApi.getUsageMetrics({ period: selectedDateRange })
        return response.data
      } catch (error) {
        return null
      }
    },
  })

  const { data: costAnalysis } = useQuery({
    queryKey: ['cost-analysis', selectedDateRange],
    queryFn: async () => {
      try {
        const response = await analyticsApi.getCostAnalysis({ period: selectedDateRange })
        return response.data
      } catch (error) {
        return null
      }
    },
  })

  const { data: performanceMetrics } = useQuery({
    queryKey: ['performance-metrics', selectedDateRange],
    queryFn: async () => {
      try {
        const response = await analyticsApi.getPerformanceMetrics({ period: selectedDateRange })
        return response.data
      } catch (error) {
        return null
      }
    },
  })

  const { data: errorAnalysis } = useQuery({
    queryKey: ['error-analysis', selectedDateRange],
    queryFn: async () => {
      try {
        const response = await analyticsApi.getErrorAnalysis({ period: selectedDateRange })
        return response.data
      } catch (error) {
        return null
      }
    },
  })

  // Calculate metrics from available data
  const metrics: DashboardMetrics = {
    totalRequests: dashboardData?.totalRequests || usageMetrics?.totalRequests || 0,
    totalCost: dashboardData?.totalCost || costAnalysis?.totalCost || 0,
    avgResponseTime: dashboardData?.avgResponseTime || performanceMetrics?.avgResponseTime || 0,
    successRate: dashboardData?.successRate || (usageMetrics?.successRate ?? 0),
    activeTools: Array.isArray(tools) ? tools.length : 0,
    activeGateways: Array.isArray(gateways) ? gateways.length : 0,
    activeApis: Array.isArray(apis) ? apis.length : 0,
    trends: dashboardData?.trends || {},
  }

  const formatNumber = (num: number) => {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M'
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K'
    return num.toString()
  }

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(amount)
  }

  const getTrendIcon = (trend?: number) => {
    if (!trend) return null
    if (trend > 0) return <TrendingUp className="h-4 w-4 text-green-500" />
    if (trend < 0) return <TrendingDown className="h-4 w-4 text-red-500" />
    return <Activity className="h-4 w-4 text-gray-500" />
  }

  const getTrendColor = (trend?: number) => {
    if (!trend) return 'text-gray-600'
    return trend > 0 ? 'text-green-600' : trend < 0 ? 'text-red-600' : 'text-gray-600'
  }

  const exportData = async (format: 'csv' | 'json' | 'pdf') => {
    try {
      const response = await analyticsApi.export(format, { period: selectedDateRange })
      const blob = new Blob([response.data], { type: response.headers['content-type'] })
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `analytics-${selectedDateRange}.${format}`
      link.click()
      window.URL.revokeObjectURL(url)
    } catch (error) {
      console.error('Export failed:', error)
    }
  }

  const isLoading = loadingTools || loadingGateways || loadingApis || loadingDashboard

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Analytics</h1>
          <p className="text-muted-foreground">
            Monitor your API usage, performance, and costs in real-time
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={selectedDateRange} onValueChange={setSelectedDateRange}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1h">Last Hour</SelectItem>
              <SelectItem value="24h">Last 24h</SelectItem>
              <SelectItem value="7d">Last 7 days</SelectItem>
              <SelectItem value="30d">Last 30 days</SelectItem>
              <SelectItem value="90d">Last 90 days</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            onClick={() => refetchDashboard()}
            className="gap-2"
            disabled={isLoading}
          >
            <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button className="gap-2" onClick={() => exportData('csv')}>
            <Download className="h-4 w-4" />
            Export
          </Button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Requests</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatNumber(metrics.totalRequests)}</div>
            {metrics.trends?.requests !== undefined && (
              <div className="flex items-center gap-1 text-xs">
                {getTrendIcon(metrics.trends.requests)}
                <span className={getTrendColor(metrics.trends.requests)}>
                  {Math.abs(metrics.trends.requests)}%
                </span>
                <span className="text-muted-foreground">from last period</span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Cost</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(metrics.totalCost)}</div>
            {metrics.trends?.cost !== undefined && (
              <div className="flex items-center gap-1 text-xs">
                {getTrendIcon(metrics.trends.cost)}
                <span className={getTrendColor(metrics.trends.cost)}>
                  {Math.abs(metrics.trends.cost)}%
                </span>
                <span className="text-muted-foreground">from last period</span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Avg Response Time</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {metrics.avgResponseTime > 0 ? `${metrics.avgResponseTime}ms` : 'N/A'}
            </div>
            {metrics.trends?.responseTime !== undefined && (
              <div className="flex items-center gap-1 text-xs">
                {getTrendIcon(metrics.trends.responseTime)}
                <span className={getTrendColor(metrics.trends.responseTime)}>
                  {Math.abs(metrics.trends.responseTime)}%
                </span>
                <span className="text-muted-foreground">from last period</span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Success Rate</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {metrics.successRate > 0 ? `${metrics.successRate}%` : 'N/A'}
            </div>
            {metrics.trends?.successRate !== undefined && (
              <div className="flex items-center gap-1 text-xs">
                {getTrendIcon(metrics.trends.successRate)}
                <span className={getTrendColor(metrics.trends.successRate)}>
                  {Math.abs(metrics.trends.successRate)}%
                </span>
                <span className="text-muted-foreground">from last period</span>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Resource Overview */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Tools</CardTitle>
            <Target className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{metrics.activeTools}</div>
            <p className="text-xs text-muted-foreground">
              Across {metrics.activeGateways} gateways
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Gateways</CardTitle>
            <Zap className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{metrics.activeGateways}</div>
            <p className="text-xs text-muted-foreground">
              Serving {metrics.activeTools} tools
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Connected APIs</CardTitle>
            <Server className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{metrics.activeApis}</div>
            <p className="text-xs text-muted-foreground">
              Generated {metrics.activeTools} tools
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Detailed Analytics Tabs */}
      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="usage">Usage</TabsTrigger>
          <TabsTrigger value="costs">Costs</TabsTrigger>
          <TabsTrigger value="performance">Performance</TabsTrigger>
          <TabsTrigger value="errors">Errors</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          {metrics.totalRequests === 0 && metrics.activeTools === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12">
                <BarChart3 className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-semibold mb-2">No Data Yet</h3>
                <p className="text-sm text-muted-foreground text-center max-w-md">
                  Start by creating APIs and tools to see analytics data. Once you begin making requests through your gateways, metrics will appear here.
                </p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>System Overview</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-sm text-muted-foreground">Total Resources</p>
                      <p className="text-2xl font-bold">
                        {metrics.activeApis + metrics.activeGateways + metrics.activeTools}
                      </p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Request Volume</p>
                      <p className="text-2xl font-bold">{formatNumber(metrics.totalRequests)}</p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="usage" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Usage Metrics</CardTitle>
            </CardHeader>
            <CardContent>
              {usageMetrics ? (
                <div className="space-y-4">
                  <p className="text-sm text-muted-foreground">
                    Detailed usage metrics will be displayed here when available.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-8">
                  <AlertTriangle className="h-8 w-8 text-muted-foreground mb-2" />
                  <p className="text-sm text-muted-foreground">
                    No usage data available for the selected period
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="costs" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Cost Analysis</CardTitle>
            </CardHeader>
            <CardContent>
              {costAnalysis ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <p className="text-sm text-muted-foreground">Total Spend</p>
                      <p className="text-xl font-bold">{formatCurrency(metrics.totalCost)}</p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Avg Cost/Request</p>
                      <p className="text-xl font-bold">
                        {metrics.totalRequests > 0
                          ? formatCurrency(metrics.totalCost / metrics.totalRequests)
                          : 'N/A'}
                      </p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Projected Monthly</p>
                      <p className="text-xl font-bold">
                        {formatCurrency(metrics.totalCost * 4.33)}
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-8">
                  <AlertTriangle className="h-8 w-8 text-muted-foreground mb-2" />
                  <p className="text-sm text-muted-foreground">
                    No cost data available for the selected period
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="performance" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Performance Metrics</CardTitle>
            </CardHeader>
            <CardContent>
              {performanceMetrics ? (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm text-muted-foreground">Avg Response Time</p>
                    <p className="text-xl font-bold">
                      {metrics.avgResponseTime > 0 ? `${metrics.avgResponseTime}ms` : 'N/A'}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Success Rate</p>
                    <p className="text-xl font-bold">
                      {metrics.successRate > 0 ? `${metrics.successRate}%` : 'N/A'}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-8">
                  <AlertTriangle className="h-8 w-8 text-muted-foreground mb-2" />
                  <p className="text-sm text-muted-foreground">
                    No performance data available for the selected period
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="errors" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Error Analysis</CardTitle>
            </CardHeader>
            <CardContent>
              {errorAnalysis ? (
                <div className="space-y-4">
                  <p className="text-sm text-muted-foreground">
                    Error details will be displayed here when available.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-8">
                  <CheckCircle2 className="h-8 w-8 text-green-500 mb-2" />
                  <p className="text-sm text-muted-foreground">
                    No errors recorded for the selected period
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
