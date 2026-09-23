import { useParams, Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft, Check, ChevronRight, Package, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { DETAIL_TITLE_CLASSES } from '@/components/layout/page-header'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'
import { EmptyState } from '@/components/ui/empty-state'
import { ProtocolBadge } from '@/components/ui/protocol-badge'
import { agentsApi } from '@/lib/api'
import {
  DISTRIBUTION_BLURBS,
  DISTRIBUTION_LABELS,
  agentAppsApi,
  type AppDistribution,
  type DistributionStatus,
} from '@/lib/agent-apps'
import { AppAgentsPanel } from '@/components/agent-apps/app-agents-panel'
import { AppSettingsPanel } from '@/components/agent-apps/app-settings-panel'

/** How each distribution status reads and colours in a badge. */
const STATUS: Record<DistributionStatus, { label: string; variant: 'success' | 'secondary' | 'warning' | 'outline' | 'destructive' }> = {
  live: { label: 'Live', variant: 'success' },
  built: { label: 'Built', variant: 'secondary' },
  building: { label: 'Building', variant: 'warning' },
  draft: { label: 'Draft', variant: 'outline' },
  failed: { label: 'Build failed', variant: 'destructive' },
}

/**
 * One app: what it is made of, and everywhere it ships.
 *
 * Structured like every other detail page in the product -- a header, a
 * row of tabbed sections, cards for the things it contains. Each
 * distribution has a page of its own (/apps/:slug/distributions/:target)
 * with its settings, its callback URL and its publish or build controls.
 * What stops the app as a whole from shipping is said here, once, not
 * inside every distribution.
 */
export function AppDetailPage() {
  const { slug = '' } = useParams<{ slug: string }>()
  const queryClient = useQueryClient()

  const {
    data: app,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['agent-app', slug],
    queryFn: () => agentAppsApi.getById(slug),
    enabled: !!slug,
  })

  const { data: check } = useQuery({
    queryKey: ['agent-app-check', slug],
    queryFn: () => agentAppsApi.check(slug),
    enabled: !!app,
  })

  const { data: agentsData } = useQuery({
    queryKey: ['agents'],
    queryFn: () => agentsApi.getAll(),
  })

  const agents = (() => {
    const raw = (agentsData as any)?.agents ?? agentsData
    return Array.isArray(raw) ? raw : []
  })()

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['agent-app', slug] })
    queryClient.invalidateQueries({ queryKey: ['agent-app-check', slug] })
  }

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner />
      </div>
    )
  }

  if (isError || !app) {
    return <QueryError error={error} onRetry={() => refetch()} />
  }

  const distributions = app.distributions ?? []
  const refusals = check?.refusals ?? []
  const addPath = `/apps/${app.slug}/distributions/new`

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-1 text-sm text-muted-foreground">
        <Link to="/apps" className="hover:text-foreground">
          Apps
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-foreground">{app.branding?.appName || app.name}</span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-y-3">
        <div className="flex min-w-0 items-center space-x-4">
          <Button variant="outline" size="sm" asChild>
            <Link to="/apps" aria-label="Back to apps">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div className="flex min-w-0 items-center space-x-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <Package className="h-6 w-6 text-primary" />
            </div>
            <div className="min-w-0">
              <h1 className={DETAIL_TITLE_CLASSES}>
                {app.branding?.appName || app.name}
              </h1>
              <code className="text-xs text-muted-foreground">{app.slug}</code>
            </div>
          </div>
        </div>
        <Button asChild>
          <Link to={addPath}>
            <Plus className="mr-2 h-4 w-4" />
            Add distribution
          </Link>
        </Button>
      </div>

      {refusals.length > 0 ? (
        <Card className="border-amber-400 p-4" data-testid="app-readiness">
          <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-300">
            <AlertTriangle className="h-4 w-4" />
            Can't publish yet
          </div>
          <ul className="mt-2 space-y-1.5">
            {refusals.map((r) => (
              <li key={r.code} className="text-xs text-muted-foreground">
                {r.message}
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        <p className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
          <Check className="h-4 w-4" />
          Ready to publish
        </p>
      )}

      <Tabs defaultValue="distributions" className="space-y-4">
        <TabsList>
          <TabsTrigger value="distributions">
            Distributions ({distributions.length})
          </TabsTrigger>
          <TabsTrigger value="agents">Agents ({app.agentIds.length})</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="distributions" className="space-y-4">
          {distributions.length === 0 ? (
            <EmptyState
              variant="panel"
              icon={Package}
              title="No distributions yet"
              description="Publish this app as a web app, a terminal, a desktop app, or a messaging channel."
              action={
                <Button asChild>
                  <Link to={addPath}>
                    <Plus className="mr-2 h-4 w-4" />
                    Add distribution
                  </Link>
                </Button>
              }
            />
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {distributions.map((distribution) => (
                <DistributionCard
                  key={distribution.target}
                  to={`/apps/${app.slug}/distributions/${distribution.target}`}
                  distribution={distribution}
                />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="agents">
          <Card className="p-6">
            <AppAgentsPanel app={app} agents={agents} onSaved={invalidate} />
          </Card>
        </TabsContent>

        <TabsContent value="settings">
          <Card className="p-6">
            <AppSettingsPanel app={app} onSaved={invalidate} />
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

/** One place the product ships to, as a card linking to its page. */
function DistributionCard({ distribution, to }: { distribution: AppDistribution; to: string }) {
  const status = STATUS[distribution.status] ?? STATUS.draft

  return (
    <Link to={to} className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <Card className="h-full p-4 transition-colors hover:border-primary/50">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-medium">
            {DISTRIBUTION_LABELS[distribution.target]}
          </span>
          <Badge variant={status.variant}>{status.label}</Badge>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <ProtocolBadge protocol={distribution.target} />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {DISTRIBUTION_BLURBS[distribution.target]}
        </p>
      </Card>
    </Link>
  )
}

export default AppDetailPage
