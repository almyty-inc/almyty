import React, { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate, Link } from 'react-router-dom'
import {
  Activity,
  AlertTriangle,
  ArrowRight,
} from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ProtocolBadge } from '@/components/ui/protocol-badge'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/layout/page-header'
import { gatewaysApi, toolsApi, apisApi, agentsApi, analyticsApi, onboardingApi } from '@/lib/api'
import { GettingStartedCard, useOnboarding } from '@/components/onboarding/getting-started-card'
import { useProductTour } from '@/components/onboarding/product-tour'
import { captureEvent } from '@/lib/analytics'
import { useOrganizationStore } from '@/store/organization'
import { useNotifications } from '@/store/app'
import { getApiErrorMessage } from '@/lib/api-error'
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

export function DashboardPage() {
  useEffect(() => {
    document.title = 'Dashboard | almyty'
    return () => { document.title = 'almyty' }
  }, [])

  const { currentOrganization } = useOrganizationStore()
  const orgId = currentOrganization?.id
  const { error: notifyError } = useNotifications()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { user } = useAuthStore()

  // Coach-mark product tour (see components/onboarding/product-tour.tsx).
  const { startTour, maybeAutoStart } = useProductTour(user?.id)

  // Server-computed onboarding checklist. Derived from real entity
  // state, so CLI-driven completions check themselves off here too.
  const { data: onboarding } = useOnboarding(orgId)

  // Auto-start the coach-mark tour once, on the dashboard, for a user
  // whose onboarding is incomplete and who has not yet seen or dismissed
  // it. `maybeAutoStart` no-ops when the seen flag is set, when
  // onboarding is complete, or after it has already fired this mount. The
  // short delay lets the sidebar and getting-started card paint their
  // `data-tour` anchors before the spotlight looks for them.
  useEffect(() => {
    if (!onboarding) return
    const cardVisible = !onboarding.dismissed && !onboarding.activatedRealAt
    if (!cardVisible) return
    const s = onboarding.steps
    const complete = s.provider && s.api && s.gateway && s.first_call
    const t = window.setTimeout(() => maybeAutoStart(complete), 500)
    return () => window.clearTimeout(t)
  }, [onboarding, maybeAutoStart])


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
    // Without this a refused dismiss left the card sitting there with
    // no explanation, so the only reading was that Dismiss is broken.
    onError: (err: unknown) =>
      notifyError(
        'Could not dismiss getting started',
        getApiErrorMessage(err, 'The card is still here. Please try again.'),
      ),
  })

  const {
    data: gatewaysData,
    isLoading: loadingGateways,
    isError: gatewaysFailed,
    error: gatewaysError,
    refetch: refetchGateways,
  } = useQuery({
    queryKey: ['gateways', orgId],
    queryFn: () => gatewaysApi.getAll(),
    enabled: !!currentOrganization,
  })

  const {
    data: toolsData,
    isLoading: loadingTools,
    isError: toolsFailed,
    error: toolsError,
    refetch: refetchTools,
  } = useQuery({
    queryKey: ['tools', orgId],
    queryFn: () => toolsApi.getAll(orgId),
    enabled: !!currentOrganization,
  })

  const {
    data: apisData,
    isLoading: loadingApis,
    isError: apisFailed,
    error: apisError,
    refetch: refetchApis,
  } = useQuery({
    queryKey: ['apis'],
    queryFn: () => apisApi.getAll(),
    enabled: !!currentOrganization,
  })

  const {
    data: agentsData,
    isLoading: loadingAgents,
    isError: agentsFailed,
    error: agentsError,
    refetch: refetchAgents,
  } = useQuery({
    queryKey: ['agents', orgId],
    queryFn: () => agentsApi.getAll(),
    enabled: !!currentOrganization,
  })

  const { data: recentLogsData } = useQuery({
    queryKey: ['analytics', 'recent-logs', orgId],
    queryFn: () => analyticsApi.getRequestLogs({ page: '1', limit: '10' }),
    enabled: !!orgId,
  })

  // Any one of these still loading means the numbers below are not the
  // truth yet. With `&&`, visiting Gateways and then Dashboard inside
  // the 30s staleTime made one query fresh, which let the whole page
  // render "0 APIs · 0 Tools · 0 Gateways · 0 Agents" until the other
  // three landed -- on an org with plenty of all four.
  const isLoading = loadingGateways || loadingTools || loadingApis || loadingAgents

  // A failed count is not a count of zero. None of these queries used to
  // expose `isError`, so on a failure `isLoading` was false and `data`
  // undefined: the extraction below produced empty arrays and the page told
  // a fully populated org it had "0 APIs · 0 Tools · 0 Gateways · 0 Agents",
  // Getting-Started card and all. Say we could not load it, and offer a retry.
  const failed = gatewaysFailed || toolsFailed || apisFailed || agentsFailed
  const loadError = gatewaysError ?? toolsError ?? apisError ?? agentsError

  if (failed) {
    return (
      <QueryError
        error={loadError}
        title="We couldn't load your dashboard"
        onRetry={() => {
          void refetchGateways()
          void refetchTools()
          void refetchApis()
          void refetchAgents()
        }}
      />
    )
  }

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
      <PageHeader
        title="Dashboard"
        description={currentOrganization?.name ? `${currentOrganization.name}: your APIs, tools, gateways and agents at a glance` : 'Your APIs, tools, gateways and agents at a glance'}
        actions={
          <Button variant="outline" onClick={() => navigate('/analytics')}>
            <Activity className="mr-2 h-4 w-4" />
            View analytics
          </Button>
        }
      />

      {showOnboarding ? (
        <GettingStartedCard
          state={onboarding}
          onDismiss={() => dismissOnboarding.mutate()}
          onStartTour={() => startTour({ manual: true })}
        />
      ) : (
        <>
          {/* Pipeline: APIs → Tools → Gateways → Agents */}
          <Card>
            <CardContent className="py-6">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-center">
                <button onClick={() => navigate('/apis')} className="flex-1 text-center p-4 rounded-lg border border-t-2 border-t-violet-500/20 hover:border-primary hover:bg-primary/5 transition-colors cursor-pointer">
                  <div className="text-2xl font-bold">{apisTotal}</div>
                  <div className="text-sm text-muted-foreground">{pluralize(apisTotal, 'API')}</div>
                </button>
                <ArrowRight className="h-5 w-5 text-muted-foreground shrink-0 hidden sm:block" />
                <button onClick={() => navigate('/tools')} className="flex-1 text-center p-4 rounded-lg border border-t-2 border-t-violet-500/20 hover:border-primary hover:bg-primary/5 transition-colors cursor-pointer">
                  <div className="text-2xl font-bold">{toolsTotal}</div>
                  <div className="text-sm text-muted-foreground">{pluralize(toolsTotal, 'Tool')}</div>
                </button>
                <ArrowRight className="h-5 w-5 text-muted-foreground shrink-0 hidden sm:block" />
                <button onClick={() => navigate('/gateways')} className="flex-1 text-center p-4 rounded-lg border border-t-2 border-t-cyan-400/20 hover:border-primary hover:bg-primary/5 transition-colors cursor-pointer">
                  <div className="text-2xl font-bold">{gatewaysTotal}</div>
                  <div className="text-sm text-muted-foreground">{pluralize(gatewaysTotal, 'Gateway')}</div>
                </button>
                <ArrowRight className="h-5 w-5 text-muted-foreground shrink-0 hidden sm:block" />
                <button onClick={() => navigate('/agents')} className="flex-1 text-center p-4 rounded-lg border border-t-2 border-t-cyan-400/20 hover:border-primary hover:bg-primary/5 transition-colors cursor-pointer">
                  <div className="text-2xl font-bold">{agents.length}</div>
                  <div className="text-sm text-muted-foreground">{pluralize(agents.length, 'Agent')}</div>
                </button>
              </div>
            </CardContent>
          </Card>

          {/* Needs Attention */}
          {(apisWithNoTools.length > 0 || gatewaysWithNoAuth.length > 0) && (
            <Card className="border-t-2 border-t-amber-500/20">
              <CardHeader>
                <CardTitle className="text-lg">Needs attention</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {/*
                    These two were <div onClick> styled as links -- and they are
                    the only remediation path offered for "no authentication
                    configured", so a keyboard user had no way to act on the
                    warning at all. Real links fix that and get cmd-click too.
                  */}
                  {apisWithNoTools.length > 0 && (
                    <Link
                      to="/apis"
                      className="flex items-center gap-2 text-sm text-amber-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
                    >
                      <AlertTriangle className="h-4 w-4 shrink-0" />
                      <span>{apisWithNoTools.length} API(s) have no generated tools</span>
                    </Link>
                  )}
                  {gatewaysWithNoAuth.length > 0 && (
                    <Link
                      to="/gateways"
                      className="flex items-center gap-2 text-sm text-amber-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
                    >
                      <AlertTriangle className="h-4 w-4 shrink-0" />
                      <span>{gatewaysWithNoAuth.length} gateway(s) have no authentication configured</span>
                    </Link>
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
          <CardTitle className="text-lg">Recent activity</CardTitle>
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
                    <ProtocolBadge protocol={log.protocol} />
                  )}
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              variant="inline"
              icon={Activity}
              title="No recent activity"
              description="Calls to your gateways and agents show up here as they happen."
              className="py-6"
            />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
