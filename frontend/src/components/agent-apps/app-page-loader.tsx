import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Package } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'
import {
  DISTRIBUTION_LABELS,
  agentAppsApi,
  isDistributionTarget,
  type AgentApp,
  type AppDistribution,
} from '@/lib/agent-apps'

/**
 * Loads the app a sub-page of /apps/:slug belongs to, and renders the
 * loading and error states those pages share.
 *
 * Same query key as the app's own page, so moving between the app and
 * one of its distributions does not refetch.
 */
export function WithApp({ slug, children }: { slug: string; children: (app: AgentApp) => ReactNode }) {
  const { data: app, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['agent-app', slug],
    queryFn: () => agentAppsApi.getById(slug),
    enabled: !!slug,
  })

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner />
      </div>
    )
  }
  if (isError || !app) return <QueryError error={error} onRetry={() => refetch()} />
  return <>{children(app)}</>
}

/**
 * The distribution a route names, or a page that says the app does not
 * ship there -- a stale link after a distribution was removed, or a
 * target the API does not know.
 */
export function WithDistribution({
  app,
  target,
  children,
}: {
  app: AgentApp
  target: string | undefined
  children: (distribution: AppDistribution) => ReactNode
}) {
  const distribution = isDistributionTarget(target)
    ? (app.distributions ?? []).find((d) => d.target === target)
    : undefined
  if (!distribution) {
    const name = isDistributionTarget(target) ? DISTRIBUTION_LABELS[target] : target
    return (
      <EmptyState
        variant="panel"
        icon={Package}
        title={`${app.branding?.appName || app.name} does not ship to ${name ?? 'that'}`}
        description="It may have been removed. Add it again from the app's distributions."
        action={
          <Button asChild>
            <Link to={`/apps/${app.slug}`}>Back to the app</Link>
          </Button>
        }
      />
    )
  }
  return <>{children(distribution)}</>
}
