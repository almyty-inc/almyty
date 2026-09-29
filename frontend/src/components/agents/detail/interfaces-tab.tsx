/**
 * Interfaces tab for the agent detail page: where this agent is in
 * front of people, read-only.
 *
 * An app is the one place an agent is put on the web, in Slack or in
 * any other chat app, so this tab only says where that happened and
 * links there: "Used in: Acme support > Slack". Nothing is created or
 * edited here. Gateways that serve the agent without an app (A2A, an
 * OpenAI-compatible endpoint) are listed after it, linking to their own
 * pages.
 */
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Package, Router } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { ProtocolBadge } from '@/components/ui/protocol-badge'
import { QueryError } from '@/components/ui/query-error'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { gatewaysApi } from '@/lib/api'
import { DISTRIBUTION_LABELS, appPlacesApi, type AgentUsage, type DistributionStatus } from '@/lib/agent-apps'
import type { Gateway } from '@/types'

interface InterfacesTabProps {
  agentId: string
  agentName?: string
}

const STATUS: Record<DistributionStatus, { label: string; variant: 'success' | 'secondary' | 'warning' | 'outline' | 'destructive' }> = {
  live: { label: 'Live', variant: 'success' },
  built: { label: 'Built', variant: 'secondary' },
  building: { label: 'Building', variant: 'warning' },
  draft: { label: 'Draft', variant: 'outline' },
  failed: { label: 'Build failed', variant: 'destructive' },
}

/** A gateway an app stood up carries the app's id; those are listed under the app. */
const managedByApp = (gateway: Gateway) => !!(gateway as any)?.configuration?.appId

export function InterfacesTab({ agentId, agentName }: InterfacesTabProps) {
  const usage = useQuery({
    queryKey: ['agent-used-by', agentId],
    queryFn: () => appPlacesApi.usedBy(agentId),
    enabled: !!agentId,
  })

  const gatewaysQuery = useQuery({
    queryKey: ['agent-gateways', agentId],
    queryFn: () => gatewaysApi.getAll({ kind: 'agent', agentId }),
    enabled: !!agentId,
  })

  const apps: AgentUsage[] = Array.isArray(usage.data) ? usage.data : []
  const gateways: Gateway[] = (() => {
    const data: any = gatewaysQuery.data
    const raw = data?.gateways || (Array.isArray(data) ? data : [])
    return Array.isArray(raw) ? raw.filter((g: Gateway) => !managedByApp(g)) : []
  })()

  if (usage.isLoading || gatewaysQuery.isLoading) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner />
      </div>
    )
  }

  if (usage.isError) {
    return <QueryError error={usage.error} onRetry={() => usage.refetch()} title="Couldn't load where this agent is used" />
  }

  if (apps.length === 0 && gateways.length === 0) {
    return (
      <EmptyState
        variant="panel"
        icon={Package}
        title="Not in front of anyone yet"
        description={`Add ${agentName || 'this agent'} to an app to put it on the web, in Slack, or in any other chat app.`}
        action={
          <Button asChild>
            <Link to="/apps">Go to apps</Link>
          </Button>
        }
      />
    )
  }

  return (
    <div className="space-y-6" data-testid="interfaces-used-in">
      {apps.length > 0 && (
        <section className="space-y-2" aria-labelledby="used-in-heading">
          <h3 id="used-in-heading" className="text-sm font-medium text-muted-foreground">
            Used in
          </h3>
          <Card className="divide-y">
            {apps.flatMap((app) =>
              app.places.length === 0
                ? [
                    <Link
                      key={app.slug}
                      to={`/apps/${app.slug}`}
                      className="flex items-center gap-2 px-4 py-3 text-sm hover:bg-muted/50"
                    >
                      <span className="font-medium">{app.name}</span>
                      <span className="text-muted-foreground">answers with another agent everywhere</span>
                      <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    </Link>,
                  ]
                : app.places.map((place) => {
                    const status = STATUS[place.status] ?? STATUS.draft
                    return (
                      <Link
                        key={`${app.slug}:${place.target}`}
                        to={`/apps/${app.slug}/distributions/${place.target}`}
                        className="flex items-center gap-2 px-4 py-3 text-sm hover:bg-muted/50"
                        data-testid="used-in-row"
                      >
                        <span className="font-medium">{app.name}</span>
                        <ChevronRight className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                        <span>{DISTRIBUTION_LABELS[place.target] ?? place.target}</span>
                        <Badge variant={status.variant} className="ml-auto">
                          {status.label}
                        </Badge>
                      </Link>
                    )
                  }),
            )}
          </Card>
        </section>
      )}

      {gateways.length > 0 && (
        <section className="space-y-2" aria-labelledby="gateways-heading">
          <h3 id="gateways-heading" className="text-sm font-medium text-muted-foreground">
            Also served by gateways
          </h3>
          <Card className="divide-y">
            {gateways.map((gateway) => (
              <Link
                key={gateway.id}
                to={`/gateways/${gateway.id}`}
                className="flex items-center gap-2 px-4 py-3 text-sm hover:bg-muted/50"
              >
                <Router className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <span className="font-medium">{gateway.name}</span>
                {gateway.type && <ProtocolBadge protocol={gateway.type} />}
                <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" aria-hidden="true" />
              </Link>
            ))}
          </Card>
        </section>
      )}
    </div>
  )
}
