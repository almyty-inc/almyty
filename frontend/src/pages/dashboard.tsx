import React, { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
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
import { gatewaysApi, toolsApi, apisApi, agentsApi, analyticsApi, onboardingApi } from '@/lib/api'
import { GettingStartedCard, useOnboarding, useSeedSampleWorkspace } from '@/components/onboarding/getting-started-card'
import { captureEvent } from '@/lib/analytics'
import { useOrganizationStore } from '@/store/organization'
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

export function DashboardPage() {
  useEffect(() => {
    document.title = 'Dashboard | almyty'
    return () => { document.title = 'almyty' }
  }, [])

  const { currentOrganization } = useOrganizationStore()
  const orgId = currentOrganization?.id
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  // Server-computed onboarding checklist. Derived from real entity
  // state, so CLI-driven completions check themselves off here too.
  const { data: onboarding } = useOnboarding(orgId)

  const seedSample = useSeedSampleWorkspace(orgId)

  const dismissOnboarding = useMutation({
    mutationFn: () => onboardingApi.setDismissed(orgId as string, true),
    onSuccess: (next) => {
      captureEvent('onboarding_dismissed', {
        steps_done: next
          ? Object.values(next.steps).filter(Boolean).length
          : undefined,
      })
      queryClient.invalidateQueries({ queryKey: ['onboarding', orgId] })
    },
  })

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

  // Onboarding: the card is shown while the org has not yet reached the
  // "real" activation milestone and the user has not dismissed it. The
  // completion of each step is computed server-side (see useOnboarding).
  const showOnboarding =
    !!onboarding && !onboarding.dismissed && !onboarding.activatedRealAt

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
        <GettingStartedCard
          state={onboarding}
          onSeedSample={() => seedSample.mutate()}
          seeding={seedSample.isPending}
          onDismiss={() => dismissOnboarding.mutate()}
        />
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
