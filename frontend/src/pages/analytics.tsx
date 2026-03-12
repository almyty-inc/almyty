import React from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Target,
  Server,
  Zap,
  Construction,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { gatewaysApi, toolsApi, apisApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'
import { LoadingSpinner } from '@/components/ui/loading-spinner'

export function AnalyticsPage() {
  const { currentOrganization } = useOrganizationStore()

  const { data: tools = [], isLoading: loadingTools } = useQuery({
    queryKey: ['tools', currentOrganization?.id],
    queryFn: async () => {
      const response = await toolsApi.getAll(currentOrganization?.id)
      return response.data?.data?.tools || response.data?.tools || response.data || []
    },
    enabled: !!currentOrganization,
  })

  const { data: gateways = [], isLoading: loadingGateways } = useQuery({
    queryKey: ['gateways', currentOrganization?.id],
    queryFn: async () => {
      const response = await gatewaysApi.getAll()
      return response.data?.data?.gateways || response.data?.data || response.data || []
    },
    enabled: !!currentOrganization,
  })

  const { data: apis = [], isLoading: loadingApis } = useQuery({
    queryKey: ['apis'],
    queryFn: async () => {
      const response = await apisApi.getAll()
      return response.data?.data?.apis || response.data?.data || response.data || []
    },
  })

  const isLoading = loadingTools || loadingGateways || loadingApis

  const toolCount = Array.isArray(tools) ? tools.length : 0
  const gatewayCount = Array.isArray(gateways) ? gateways.length : 0
  const apiCount = Array.isArray(apis) ? apis.length : 0

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
          Overview of your resources
        </p>
      </div>

      {/* Resource Overview — Real data from actual API queries */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Tools</CardTitle>
            <Target className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{toolCount}</div>
            <p className="text-xs text-muted-foreground">
              Across {gatewayCount} gateways
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
            <p className="text-xs text-muted-foreground">
              Serving {toolCount} tools
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">APIs</CardTitle>
            <Server className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{apiCount}</div>
            <p className="text-xs text-muted-foreground">
              Connected and parsed
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Usage Analytics — Coming Soon */}
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-16">
          <Construction className="h-12 w-12 text-muted-foreground mb-4" />
          <h3 className="text-lg font-semibold mb-2">Usage Analytics Coming Soon</h3>
          <p className="text-sm text-muted-foreground text-center max-w-md">
            Request tracking, cost analysis, performance metrics, and error monitoring
            will be available here once request logging is implemented.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
