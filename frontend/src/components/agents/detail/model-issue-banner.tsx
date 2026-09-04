import { AlertTriangle } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { Agent } from '@/types'

/**
 * Shown when the backend recorded that this agent's model is no longer
 * served by its provider (a vendor retired the id). Without it the only
 * trace is a failed run every interval and an alert nobody can act on.
 */
export function ModelIssueBanner({ agent }: { agent: Agent }) {
  const issue = agent.settings?.modelIssue
  if (!issue) return null
  const schedulePaused = agent.settings?.schedule?.pausedReason?.code === issue.code
  const when = new Date(issue.detectedAt)
  const whenLabel = Number.isNaN(when.getTime()) ? '' : when.toLocaleString()

  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
      <div className="space-y-1">
        <p className="font-medium">
          The model <span className="font-mono">{issue.model}</span> is no longer available from its provider.
        </p>
        <p className="text-muted-foreground">
          {issue.message}
          {whenLabel && <> Detected {whenLabel}.</>}
          {schedulePaused && <> The schedule was paused so it stops failing every interval.</>}
        </p>
        <p>
          Pick a current model in the {agent.mode === 'autonomous' ? 'agent configuration' : 'LLM node'}
          {issue.providerId && (
            <>
              {' '}or on the <Link className="underline" to={`/llm-providers/${issue.providerId}`}>provider</Link>
            </>
          )}
          {schedulePaused && <>, then enable the schedule again</>}.
        </p>
      </div>
    </div>
  )
}
