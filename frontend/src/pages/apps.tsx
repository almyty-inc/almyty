import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { Package, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/page-header'
import { PageIntro } from '@/components/onboarding/page-intro'
import { formatDateTime, pluralized } from '@/lib/utils'
import {
  AUTH_MODE_LABELS,
  DISTRIBUTION_LABELS,
  agentAppsApi,
  grantsLocalAccess,
  type AgentApp,
} from '@/lib/agent-apps'
import { useNewParamRedirect } from '@/hooks/use-new-param-redirect'

/**
 * Apps: the products this organization ships.
 *
 * The last link of the chain the sidebar tells: APIs become tools,
 * tools and models become agents, agents become an app someone can
 * actually use.
 */
export function AppsPage() {
  const navigate = useNavigate()
  // Old ?new=1 links (bookmarks, docs) land on the create page.
  useNewParamRedirect('/apps/new')

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['agent-apps'],
    queryFn: () => agentAppsApi.list(),
  })

  const apps: AgentApp[] = Array.isArray(data) ? data : []

  return (
    <div className="space-y-6">
      <PageHeader
        title="Apps"
        description={
          isLoading ? (
            <span className="inline-block h-4 w-48 animate-pulse rounded bg-muted" />
          ) : apps.length > 0 ? (
            pluralized(apps.length, 'app')
          ) : undefined
        }
        actions={
          <Button onClick={() => navigate('/apps/new')}>
            <Plus className="mr-2 h-4 w-4" />
            Create app
          </Button>
        }
      />
      <PageIntro topic="apps" />

      {isLoading ? (
        <div className="flex justify-center py-12">
          <LoadingSpinner />
        </div>
      ) : isError ? (
        <QueryError error={error} onRetry={() => refetch()} />
      ) : apps.length === 0 ? (
        <EmptyState
          variant="panel"
          icon={Package}
          title="No apps yet"
          description="An app puts your agent in front of people: on the web, in Slack or another chat app, or as a terminal or desktop app."
          action={
            <Button onClick={() => navigate('/apps/new')}>
              <Plus className="mr-2 h-4 w-4" />
              Create app
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {apps.map((app) => {
            const shipped = app.distributions ?? []
            const local = grantsLocalAccess(app.capabilities)
            return (
              <Link key={app.id} to={`/apps/${app.slug}`}>
                <Card className="h-full transition-shadow hover:shadow-md">
                  <CardContent className="space-y-3 pt-5">
                    <div className="flex items-start gap-3">
                      <span
                        aria-hidden
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold text-white"
                        style={{
                          background: app.branding?.primaryColor || '#8b5cf6',
                        }}
                      >
                        {(app.branding?.appName || app.name).charAt(0).toUpperCase()}
                      </span>
                      <div className="min-w-0">
                        <div className="truncate font-medium">
                          {app.branding?.appName || app.name}
                        </div>
                        <code className="truncate text-xs text-muted-foreground">{app.slug}</code>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-1.5">
                      <Badge variant="secondary">{AUTH_MODE_LABELS[app.authMode]}</Badge>
                      {local && (
                        <Badge variant="outline" className="border-amber-400 text-amber-600">
                          Local access
                        </Badge>
                      )}
                      {!app.isActive && <Badge variant="outline">Paused</Badge>}
                      {app.health?.state === 'failing' && (
                        <Badge
                          variant="outline"
                          className="border-red-400 text-red-600"
                          title={`${app.health.agentName}: ${app.health.message} (${formatDateTime(app.health.at)})`}
                        >
                          Last run failed
                        </Badge>
                      )}

                    </div>

                    <p className="text-xs text-muted-foreground">
                      {app.agentIds.length === 0
                        ? 'No agents yet'
                        : `${app.agentIds.length} agent${app.agentIds.length === 1 ? '' : 's'}`}
                      {shipped.length > 0 && (
                        <>
                          {' · '}
                          {shipped
                            .slice(0, 3)
                            .map((d) => DISTRIBUTION_LABELS[d.target] ?? d.target)
                            .join(', ')}
                          {shipped.length > 3 && ` +${shipped.length - 3}`}
                        </>
                      )}
                    </p>
                  </CardContent>
                </Card>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default AppsPage
