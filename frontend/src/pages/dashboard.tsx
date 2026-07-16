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
import { useAuthStore } from '@/store/auth'
import { pluralize } from '@/lib/utils'
import type { RequestLog } from '@/types'

// Helper to humanize a log path. The activity feed only receives
// protocol traffic (MCP/UTCP/A2A requests and tool executions), so
// describe the action rather than guessing from loose substrings —
// the old heuristics labeled creates as "Tools listing" and matched
// any path merely containing "/mcp".
const humanizePath = (path: string, method: string) => {
  if (path === '/mcp' || path.startsWith('/mcp/')) return `MCP ${method} request`
  if (path.includes('/.well-known/agent-card')) return 'A2A agent discovery'
  if (path.endsWith('/manual')) return 'UTCP manual fetch'
  if (path.endsWith('/execute')) return `Tool execution`
  // Truncate UUIDs
  return `${method} ${path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '…')}`
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
          ? 'bg-muted border-muted opacity-60'
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
    document.title = 'Dashboard | almyty'
    return () => { document.title = 'almyty' }
  }, [])

  const { currentOrganization } = useOrganizationStore()
  const { user } = useAuthStore()
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
    queryFn: () => analyticsApi.getRequestLogs({ page: '1', limit: '10' }),
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

  const gatewaysExtracted = gatewaysData?.gateways || []
  const gateways = Array.isArray(gatewaysExtracted) ? gatewaysExtracted : []
  const gatewaysTotal = gatewaysData?.total ?? gateways.length
  const toolsExtracted = toolsData?.tools || []
  const tools = Array.isArray(toolsExtracted) ? toolsExtracted : []
  const toolsTotal = toolsData?.total ?? tools.length
  const apisExtracted = apisData?.apis || []
  const apis = Array.isArray(apisExtracted) ? apisExtracted : []
  const apisTotal = apisData?.total ?? apis.length
  const agentsExtracted = agentsData || []
  const agents = Array.isArray(agentsExtracted) ? agentsExtracted : []

  const recentLogs = recentLogsData?.data || []

  // Onboarding: show checklist when not all steps are complete
  const userGateways = gateways.filter((g: any) => !g.isSystem)
  const allStepsComplete = apis.length > 0 && tools.length > 0 && userGateways.length > 0 && agents.length > 0
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
      <div className="flex flex-wrap items-center justify-between gap-2 pb-4 border-b border-gradient-to-r from-border to-transparent">
        <div>
          <h1 className="text-4xl font-heading font-extrabold tracking-tight bg-gradient-to-r from-violet-500 to-cyan-400 bg-clip-text text-transparent">Dashboard</h1>
          <p className="text-muted-foreground">
            Overview of your APIs and tools
          </p>
        </div>
        <div className="flex items-center space-x-2">
          <Badge variant="outline" className="hidden sm:inline-flex">
            {currentOrganization?.name || 'No Organization'}
          </Badge>
          <Button variant="outline" className="border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10" onClick={() => navigate('/analytics')}>
            <Activity className="h-4 w-4 sm:mr-2" />
            <span className="hidden sm:inline">View Analytics</span>
          </Button>
        </div>
      </div>

      {showOnboarding ? (
        /* Getting Started Checklist */
        <Card className="border-t-2 border-t-violet-500/20">
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <CardTitle className="text-lg">
                  {user?.name ? `Welcome, ${user.name.split(' ')[0]}` : 'Welcome to almyty'}
                </CardTitle>
                <p className="text-sm text-muted-foreground mt-1">
                  Four steps from an API schema to a live AI-ready gateway. Open any step and we'll walk you through.
                </p>
              </div>
              {(() => {
                const done = [apis.length > 0, tools.length > 0, userGateways.length > 0, agents.length > 0].filter(Boolean).length
                const pct = Math.round((done / 4) * 100)
                return (
                  <div className="flex flex-col items-end gap-1 min-w-[140px]">
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {done} of 4 complete
                    </span>
                    <div
                      role="progressbar"
                      aria-label="Onboarding progress"
                      aria-valuenow={done}
                      aria-valuemin={0}
                      aria-valuemax={4}
                      className="h-1.5 w-full rounded-full bg-muted overflow-hidden"
                    >
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400 transition-all duration-500 ease-out"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                )
              })()}
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <ChecklistItem
                done={apis.length > 0}
                label="Connect your first API"
                description="Import an OpenAPI, GraphQL, SOAP, or Protobuf schema to auto-generate tools"
                action={() => navigate('/apis?new=1')}
              />
              <ChecklistItem
                done={tools.length > 0}
                label="Generate tools from your API"
                description="Each API operation becomes one callable tool with a typed parameter schema"
                action={() => navigate('/tools')}
              />
              <ChecklistItem
                done={userGateways.length > 0}
                label="Create a gateway"
                description="Serve your tools and agents via MCP, UTCP, A2A, Agent Skills, and more"
                action={() => navigate('/gateways?new=1')}
              />
              <ChecklistItem
                done={agents.length > 0}
                label="Build an agent"
                description="Orchestrate LLM calls, tool calls, conditions, and loops in the visual DAG builder"
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
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-center">
                <button onClick={() => navigate('/apis')} className="flex-1 text-center p-4 rounded-lg border border-t-2 border-t-violet-500/20 hover:border-primary hover:bg-primary/5 transition-colors cursor-pointer">
                  <div className="text-2xl font-bold">{apisTotal}</div>
                  <div className="text-sm text-muted-foreground">{pluralize(apisTotal, 'API')} Connected</div>
                </button>
                <ArrowRight className="h-5 w-5 text-muted-foreground shrink-0 hidden sm:block" />
                <button onClick={() => navigate('/tools')} className="flex-1 text-center p-4 rounded-lg border border-t-2 border-t-violet-500/20 hover:border-primary hover:bg-primary/5 transition-colors cursor-pointer">
                  <div className="text-2xl font-bold">{toolsTotal}</div>
                  <div className="text-sm text-muted-foreground">{pluralize(toolsTotal, 'Tool')} Generated</div>
                </button>
                <ArrowRight className="h-5 w-5 text-muted-foreground shrink-0 hidden sm:block" />
                <button onClick={() => navigate('/gateways')} className="flex-1 text-center p-4 rounded-lg border border-t-2 border-t-cyan-400/20 hover:border-primary hover:bg-primary/5 transition-colors cursor-pointer">
                  <div className="text-2xl font-bold">{gatewaysTotal}</div>
                  <div className="text-sm text-muted-foreground">{pluralize(gatewaysTotal, 'Gateway')} Serving</div>
                </button>
                <ArrowRight className="h-5 w-5 text-muted-foreground shrink-0 hidden sm:block" />
                <button onClick={() => navigate('/agents')} className="flex-1 text-center p-4 rounded-lg border border-t-2 border-t-cyan-400/20 hover:border-primary hover:bg-primary/5 transition-colors cursor-pointer">
                  <div className="text-2xl font-bold">{agents.length}</div>
                  <div className="text-sm text-muted-foreground">{pluralize(agents.length, 'Agent')} Running</div>
                </button>
              </div>
            </CardContent>
          </Card>

          {/* Needs Attention */}
          {(apisWithNoTools.length > 0 || gatewaysWithNoAuth.length > 0) && (
            <Card className="border-t-2 border-t-amber-500/20">
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
      <Card className="border-t-2 border-t-cyan-400/20">
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
