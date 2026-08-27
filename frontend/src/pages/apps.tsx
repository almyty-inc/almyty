import React, { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Package, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'
import { Badge } from '@/components/ui/badge'
import {
  AUTH_MODE_LABELS,
  DISTRIBUTION_LABELS,
  agentAppsApi,
  grantsLocalAccess,
  type AgentApp,
} from '@/lib/agent-apps'
import { CreateAppDialog } from '@/components/agent-apps/create-app-dialog'

/**
 * Apps: the products this organization ships.
 *
 * The last link of the chain the sidebar tells: APIs become tools,
 * tools and models become agents, agents become an app someone can
 * actually use.
 */
export function AppsPage() {
  const [createOpen, setCreateOpen] = useState(false)

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['agent-apps'],
    queryFn: () => agentAppsApi.list(),
  })

  const apps: AgentApp[] = Array.isArray(data) ? data : []

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-heading text-2xl font-semibold">Apps</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your agents, packaged under your own name and shipped where your users are.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          New app
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <LoadingSpinner />
        </div>
      ) : isError ? (
        <QueryError error={error} onRetry={() => refetch()} />
      ) : apps.length === 0 ? (
        <EmptyState
          icon={Package}
          title="No apps yet"
          description="An app gathers one or more agents under your branding and ships them to a web address, a messaging platform, a terminal, or an installable binary."
          action={
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Create your first app
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

      <CreateAppDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  )
}

export default AppsPage
