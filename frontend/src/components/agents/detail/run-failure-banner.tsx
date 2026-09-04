import { useQuery } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { agentsApi } from '@/lib/api'
import type { Agent, AgentExecution } from '@/types'

const FAILED = new Set(['failed', 'timeout'])

/**
 * If the most recent thing this agent did failed, say so at the top of
 * its page. Until now a failing agent looked identical to an idle one
 * unless someone opened the runs tab.
 */
export function RunFailureBanner({ agent, executions }: { agent: Agent; executions: AgentExecution[] }) {
  const autonomous = agent.mode === 'autonomous'
  const { data: runs } = useQuery({
    queryKey: ['agent-latest-run', agent.id],
    queryFn: async () => {
      const d: any = await agentsApi.listRuns(agent.id, { limit: 1 })
      const list = Array.isArray(d) ? d : d?.runs || d?.data || []
      return list as Array<{ id: string; status: string; error?: string | null; createdAt: string }>
    },
    enabled: autonomous,
    staleTime: 15_000,
  })

  const latest = autonomous ? runs?.[0] : executions[0]
  if (!latest || !FAILED.has(latest.status)) return null
  const when = new Date(latest.createdAt)
  const whenLabel = Number.isNaN(when.getTime()) ? '' : when.toLocaleString()
  const detail = (latest as any).error as string | undefined

  return (
    <div role="alert" className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
      <div className="space-y-1">
        <p className="font-medium">
          The last run {latest.status === 'timeout' ? 'timed out' : 'failed'}
          {whenLabel && <> ({whenLabel})</>}.
        </p>
        {detail && <p className="break-words font-mono text-xs text-muted-foreground">{detail}</p>}
        <p className="text-muted-foreground">
          Anyone using this agent through an app or channel got no answer. Check the provider on its LLM node, then run it again.
        </p>
      </div>
    </div>
  )
}
