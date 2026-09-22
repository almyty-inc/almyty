import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'

interface ExecutionSettings {
  strategyKey?: string | null
  orchestrator?: { enabled: boolean; fallbackStrategyKey: string }
}

/** The saved graph is not the execution plan when a strategy owns the run. */
export function ExecutionPlan({ agentId, onConfigure, children }: { agentId: string; onConfigure: () => void; children: ReactNode }) {
  const query = useQuery({
    queryKey: ['agent-execution', agentId],
    queryFn: async () => (await api.get(`/agents/${agentId}/execution`)).data.data as ExecutionSettings,
  })
  if (query.isPending) return <p role="status">Loading execution plan…</p>
  if (query.isError) return <p role="alert">Could not load the execution plan. <button type="button" className="underline" onClick={() => query.refetch()}>Retry</button></p>
  const execution = query.data
  if (!execution.orchestrator?.enabled && !execution.strategyKey) return <>{children}</>
  return (
    <Card>
      <CardHeader><CardTitle>Execution plan</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {execution.orchestrator?.enabled
          ? <p>The orchestrator chooses a strategy per request. Its fallback is <strong>{execution.orchestrator.fallbackStrategyKey}</strong>.</p>
          : <p>This agent runs the <strong>{execution.strategyKey}</strong> strategy.</p>}
        <p className="text-sm text-muted-foreground">Models are assigned through roles on the Execution tab. The saved builder graph is not used for these runs.</p>
        <p className="text-sm text-muted-foreground">The Runs tab records which strategy was actually used for each request.</p>
        <Button variant="outline" onClick={onConfigure}>Configure strategy and roles</Button>
      </CardContent>
    </Card>
  )
}
