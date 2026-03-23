import React, { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Check,
  Circle,
  ChevronRight,
} from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { gatewaysApi, toolsApi, apisApi, agentsApi, analyticsApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'
import type { RequestLog } from '@/types'

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

function ChecklistItem({ done, label, description, action }: {
  done: boolean
  label: string
  description: string
  action: () => void
}) {
  return (
    <button
      onClick={action}
      className={`flex items-center gap-3 w-full text-left p-3 rounded-lg border transition-colors ${
        done
          ? 'bg-muted/50 border-muted opacity-60'
          : 'hover:border-primary hover:bg-primary/5 cursor-pointer'
      }`}
    >
      {done ? (
        <div className="flex items-center justify-center h-6 w-6 rounded-full bg-green-100 text-green-600 shrink-0">
          <Check className="h-4 w-4" />
        </div>
      ) : (
        <Circle className="h-6 w-6 text-muted-foreground shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <div className={`text-sm font-medium ${done ? 'line-through text-muted-foreground' : ''}`}>
          {label}
        </div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
    </button>
  )
}

export function DashboardPage() {
  useEffect(() => {
    document.title = 'Dashboard | apifai'
    return () => { document.title = 'apifai' }
  }, [])

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

  const { data: agentsData, isLoading: loadingAgents } = useQuery({
    queryKey: ['agents', orgId],
    queryFn: () => agentsApi.getAll(),
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

  const isLoading = loadingGateways && loadingTools && loadingApis && loadingAgents

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  const gatewaysExtracted = gatewaysData?.data?.gateways || gatewaysData?.data || []
  const gateways = Array.isArray(gatewaysExtracted) ? gatewaysExtracted : []
  const toolsExtracted = toolsData?.data?.tools || toolsData?.data || []
  const tools = Array.isArray(toolsExtracted) ? toolsExtracted : []
  const apisExtracted = apisData?.data?.apis || apisData?.data || []
  const apis = Array.isArray(apisExtracted) ? apisExtracted : []
  const agentsExtracted = agentsData?.data || []
  const agents = Array.isArray(agentsExtracted) ? agentsExtracted : []

  const recentLogs = recentLogsData?.data || []

  // Onboarding: show checklist when not all steps are complete
  const allStepsComplete = apis.length > 0 && tools.length > 0 && gateways.length > 0 && agents.length > 0
  const showOnboarding = !allStepsComplete

  // Action items: APIs with no generated tools
  // Tools connect to APIs through operations, not directly via apiId
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gatewaysWithNoAuth = gateways.filter((g: any) => {
    return !g.authConfigs?.length && !g.authMethods?.length
  })

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between pb-4 border-b border-gradient-to-r from-border to-transparent">
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

      {showOnboarding ? (
        /* Getting Started Checklist */
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Getting Started</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <ChecklistItem
                done={apis.length > 0}
                label="Connect your first API"
                description="Import an OpenAPI spec to auto-generate tools"
                action={() => navigate('/apis')}
              />
              <ChecklistItem
                done={tools.length > 0}
                label="Generate tools from your API"
                description="Auto-generate AI-ready tools from API operations"
                action={() => navigate('/tools')}
              />
              <ChecklistItem
                done={gateways.length > 0}
                label="Create a gateway"
                description="Serve your tools via MCP, A2A, UTCP, or Skills"
                action={() => navigate('/gateways')}
              />
              <ChecklistItem
                done={agents.length > 0}
                label="Build an agent"
                description="Orchestrate LLM calls and tools into a pipeline"
                action={() => navigate('/agents/new')}
              />
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Pipeline: APIs → Tools → Gateways → Agents */}
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
                <ArrowRight className="h-5 w-5 text-muted-foreground shrink-0" />
                <button onClick={() => navigate('/agents')} className="flex-1 text-center p-4 rounded-lg border hover:border-primary hover:bg-primary/5 transition-colors cursor-pointer">
                  <div className="text-2xl font-bold">{agents.length}</div>
                  <div className="text-sm text-muted-foreground">Agents Running</div>
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
        </>
      )}

      {/* Recent Activity */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Recent Activity</CardTitle>
        </CardHeader>
        <CardContent>
          {recentLogs.length > 0 ? (
            <div className="space-y-2">
              {recentLogs.map((log: RequestLog, i: number) => (
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
