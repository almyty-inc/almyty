import { AlertTriangle } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import { modelsApi, type AgentModelIssue } from '@/lib/models-api'
import { providerPath } from '@/components/llm-providers/paths'

/**
 * Shown on an agent when a model it names cannot be used now: the
 * provider stopped listing it, refused the connection's key, said the model
 * is gone, or the connection's owner turned it off. Worked out from the
 * catalog as it is (GET /models/agents/:id/issues), so it goes away by
 * itself once the model is back or the agent uses another one.
 */
export function ModelAvailabilityBanner({ agentId }: { agentId: string }) {
  const issuesQuery = useQuery({
    queryKey: ['models', 'agent-issues', agentId],
    queryFn: async () => {
      const rows = await modelsApi.agentIssues(agentId)
      return Array.isArray(rows) ? rows : []
    },
    enabled: !!agentId,
    staleTime: 30_000,
  })
  const issues: AgentModelIssue[] = issuesQuery.data ?? []
  if (issues.length === 0) return null

  return (
    <div role="alert" className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm" data-testid="model-availability-banner">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden />
      <div className="min-w-0 flex-1 space-y-2">
        <ul className="space-y-1.5">
          {issues.map((issue) => (
            <li key={`${issue.providerId}::${issue.model}`}>
              <p className="font-medium">
                <span className="font-mono">{issue.modelName}</span> is no longer available from{' '}
                {issue.connectionName ? (
                  <Link className="underline" to={providerPath(issue.providerId)}>
                    {issue.connectionName}
                  </Link>
                ) : (
                  'its connection'
                )}
                .
              </p>
              <p className="text-muted-foreground">
                {issue.reason} Used in: {issue.where.join(', ')}.
              </p>
            </li>
          ))}
        </ul>
        <Button asChild size="sm" variant="outline">
          <Link to={`/agents/${agentId}/edit`}>Pick another model</Link>
        </Button>
      </div>
    </div>
  )
}
