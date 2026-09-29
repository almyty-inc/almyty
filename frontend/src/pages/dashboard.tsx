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
import { apisApi, analyticsApi, onboardingApi } from '@/lib/api'
import { agentsQuery, gatewaysQuery, toolsQuery } from '@/lib/list-queries'
import { GuideCard } from '@/components/onboarding/guide-card'
import { useOnboarding } from '@/components/onboarding/use-onboarding'
import { nextStep, stepsDone } from '@/components/onboarding/guide-steps'
import { captureEvent } from '@/lib/analytics'
import { useOrganizationStore } from '@/store/organization'
import { useNotifications } from '@/store/app'
import { getApiErrorMessage } from '@/lib/api-error'
import { pluralize } from '@/lib/utils'
import type { RequestLog } from '@/types'

/** Gateway types that take gateway sign-in (API key, bearer, OAuth). */
const PROTOCOL_GATEWAY_TYPES = new Set(['mcp', 'utcp', 'skills', 'a2a', 'acp', 'openai_chat'])

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
  // Server-computed guide state. Derived from real entity state, so
  // CLI-driven completions check themselves off here too.
  const { data: onboarding } = useOnboarding(orgId)

  const dismissOnboarding = useMutation({
    mutationFn: () => onboardingApi.setDismissed(orgId as string, true),
    onSuccess: (next) => {
      captureEvent('onboarding_dismissed', {
        steps_done: next ? stepsDone(next) : undefined,
      })
      queryClient.invalidateQueries({ queryKey: ['onboarding', orgId] })
    },
    // Without this a refused dismiss left the card sitting there with
    // no explanation, so the only reading was that Dismiss is broken.
    onError: (err: unknown) =>
      notifyError(
        'Could not hide the guide',
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
    ...gatewaysQuery(orgId),
    enabled: !!currentOrganization,
  })

  const {
    data: toolsData,
    isLoading: loadingTools,
    isError: toolsFailed,
    error: toolsError,
    refetch: refetchTools,
  } = useQuery({
    ...toolsQuery(orgId),
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
    ...agentsQuery(orgId),
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

  const gateways = gatewaysData?.items ?? []
  const gatewaysTotal = gatewaysData?.total ?? gateways.length
  const tools = toolsData?.items ?? []
  const toolsTotal = toolsData?.total ?? tools.length
  const apisExtracted = apisData?.apis || []
  const apis = Array.isArray(apisExtracted) ? apisExtracted : []
  const apisTotal = apisData?.total ?? apis.length
  const agents = agentsData ?? []

  const recentLogs = recentLogsData?.data || []

  // The guide card is a way into /guide: shown until every step is done,
  // unless this user hid it. Each step's completion is computed
  // server-side from what exists (see useOnboarding), and the guide stays
  // reachable from the sidebar after the card is hidden.
  const showGuide = !!onboarding && !onboarding.dismissed && nextStep(onboarding) !== null
  // The built-in system gateway every org has does not count as something built.
  const hasAnything =
    apisTotal + toolsTotal + agents.length > 0 || gateways.some((g: { isSystem?: boolean }) => !g.isSystem)

  // Action items: APIs with no tools. The server counts each API's live
  // tools (linked directly or through an operation); guessing here from
  // metadata copies and the first page of tools flagged APIs that had tools.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apisWithNoTools = apis.filter((a: any) => typeof a.toolCount === 'number' && a.toolCount === 0)

  // Action items: protocol gateways anyone can call. Only the protocol types
  // take gateway sign-in; chat and channel gateways authenticate their own
  // way and the built-in system gateway uses OAuth, so counting those said
  // something untrue about them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gatewaysWithNoAuth = gateways.filter((g: any) => {
    if (g.isSystem || !PROTOCOL_GATEWAY_TYPES.has(g.type)) return false
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

      {showGuide && (
        <GuideCard state={onboarding} onDismiss={() => dismissOnboarding.mutate()} />
      )}

      {/* Four zeros tell a new org nothing; while the guide card is up
          on an empty org it says what to do instead. */}
      {(!showGuide || hasAnything) && (
        <>
          {/* Pipeline: APIs → Tools → Gateways → Agents */}
          <Card>
            <CardContent className="py-6">
              <div className="grid grid-cols-2 gap-3 items-center sm:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr]">
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
                      <span>{apisWithNoTools.length === 1 ? '1 API has no tools yet' : `${apisWithNoTools.length} APIs have no tools yet`}</span>
                    </Link>
                  )}
                  {gatewaysWithNoAuth.length > 0 && (
                    <Link
                      to="/gateways"
                      className="flex items-center gap-2 text-sm text-amber-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
                    >
                      <AlertTriangle className="h-4 w-4 shrink-0" />
                      <span>{gatewaysWithNoAuth.length === 1 ? '1 gateway is open to anyone: add sign-in' : `${gatewaysWithNoAuth.length} gateways are open to anyone: add sign-in`}</span>
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
