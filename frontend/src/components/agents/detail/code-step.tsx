/**
 * A run_code step in a run's step list (code mode, docs/design/code-mode.md
 * part C, "The trace"): what the script did at a glance, and on request the
 * script itself, what it logged and returned, its change set, and every
 * call it made, in order, from the run's trace.
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Code2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ChangeSetView, argumentsLine } from '@/components/approvals/change-set-view'
import { api } from '@/lib/api'
import { pluralized } from '@/lib/utils'
import type { AgentRunStep, ChangeSetEntry } from '@/types'
import { formatDuration } from './constants'

interface CodeExecutionTrace {
  id: string
  code: string
  logs: string
  result: unknown
  error: { message: string; line?: number; tool?: string } | null
  status: 'running' | 'completed' | 'failed' | 'waiting_approval' | 'approved' | 'rejected'
  changeSet: ChangeSetEntry[]
  cpuMs: number
  durationMs: number
  calls: Array<{ id: string; toolId: string; toolName: string | null; parameters: Record<string, unknown>; success: boolean; error?: string | null; executionTime: number }>
}

const STATUS_LABEL: Record<CodeExecutionTrace['status'], string> = {
  running: 'running',
  completed: 'done',
  failed: 'failed',
  waiting_approval: 'waiting for approval',
  approved: 'changes approved',
  rejected: 'changes rejected',
}

/** True for the step a run_code call recorded (the one with a trace to open). */
export function isCodeStep(step: AgentRunStep): boolean {
  return step.type === 'tool_call' && step.input?.tool === 'run_code' && typeof step.output?.codeExecutionId === 'string'
}

export function CodeStepCard({ step, index, agentId, runId }: { step: AgentRunStep; index: number; agentId?: string; runId: string }) {
  const [open, setOpen] = useState(false)
  const codeExecutionId: string = step.output.codeExecutionId
  const calls = step.output.calls as { made: number; ran: number; failed: number; staged: number; refused: number } | undefined
  const trace = useQuery({
    queryKey: ['code-execution', agentId, runId, codeExecutionId],
    enabled: open && !!agentId,
    queryFn: async () => (await api.get(`/agents/${agentId}/runs/${runId}/code-executions/${codeExecutionId}`)).data.data as CodeExecutionTrace,
  })
  const failed = step.output.status === 'failed'
  return (
    <div className={`rounded border p-2 text-sm ${failed ? 'border-destructive/30 bg-destructive/5' : 'bg-background'}`} data-testid={`run-step-${index}`}>
      <div className="flex items-start gap-3">
        <div className="flex shrink-0 items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">#{index + 1}</span>
          <Code2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <Badge variant="outline" className="text-[10px]">script</Badge>
        </div>
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="text-xs">
            {calls ? (
              <>
                {pluralized(calls.made, 'call')}: {calls.ran} ran
                {calls.staged ? `, ${calls.staged} waiting for approval` : ''}
                {calls.failed ? `, ${calls.failed} failed` : ''}
                {calls.refused ? `, ${calls.refused} refused` : ''}
              </>
            ) : (
              'A script'
            )}
            {typeof step.output.cpuMs === 'number' && <span className="text-muted-foreground"> · {step.output.cpuMs} ms CPU</span>}
          </div>
          {step.error && <div className="truncate text-xs text-destructive">Error: {step.error}</div>}
        </div>
        <div className="shrink-0 text-right text-[10px] text-muted-foreground">
          {step.duration ? formatDuration(step.duration) : ''}
          {agentId && (
            <Button variant="ghost" size="sm" className="ml-2 h-6 px-2 text-xs" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              {open ? 'Hide script' : 'Show script'}
            </Button>
          )}
        </div>
      </div>
      {open && (
        <div className="mt-2 space-y-3 border-t pt-2" data-testid="code-trace">
          {trace.isLoading && <div className="h-16 animate-pulse rounded bg-muted" />}
          {trace.isError && <p className="text-xs text-red-600 dark:text-red-400">Could not load the script.</p>}
          {trace.data && (
            <>
              <div>
                <div className="mb-1 flex flex-wrap items-center gap-2 text-xs font-medium">
                  Script <Badge variant="outline" className="text-[10px]">{STATUS_LABEL[trace.data.status]}</Badge>
                  <span className="font-normal text-muted-foreground">
                    {formatDuration(trace.data.durationMs)} · {trace.data.cpuMs} ms CPU
                  </span>
                </div>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">
                  {trace.data.code.split('\n').map((line, i) => (
                    <div key={i} className={trace.data!.error?.line === i + 1 ? 'bg-destructive/15' : undefined}>
                      <span className="mr-3 inline-block w-6 select-none text-right text-muted-foreground">{i + 1}</span>
                      {line}
                    </div>
                  ))}
                </pre>
              </div>
              {trace.data.error && (
                <p className="text-xs text-destructive">
                  {trace.data.error.line ? `Line ${trace.data.error.line}: ` : ''}
                  {trace.data.error.message}
                </p>
              )}
              {trace.data.logs && (
                <div>
                  <div className="mb-1 text-xs font-medium">Log</div>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">{trace.data.logs}</pre>
                </div>
              )}
              {trace.data.result !== null && trace.data.result !== undefined && (
                <div>
                  <div className="mb-1 text-xs font-medium">Returned</div>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">
                    {typeof trace.data.result === 'string' ? trace.data.result : JSON.stringify(trace.data.result, null, 2)}
                  </pre>
                </div>
              )}
              {trace.data.changeSet.length > 0 && (
                <div>
                  <div className="mb-1 text-xs font-medium">Changes it asked to make</div>
                  <ChangeSetView entries={trace.data.changeSet} />
                </div>
              )}
              <div>
                <div className="mb-1 text-xs font-medium">Calls that ran ({trace.data.calls.length})</div>
                {trace.data.calls.length === 0 ? (
                  <p className="text-xs text-muted-foreground">None.</p>
                ) : (
                  <ol className="space-y-1 text-xs" data-testid="code-calls">
                    {trace.data.calls.map((c, i) => (
                      <li key={c.id} className="flex flex-wrap items-baseline gap-2">
                        <span className="w-5 text-right font-mono text-muted-foreground">{i + 1}</span>
                        <span className="font-mono">{c.toolName ?? 'deleted tool'}</span>
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">{argumentsLine(c.parameters, 120)}</span>
                        <span className={c.success ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}>
                          {c.success ? 'ok' : (c.error ?? 'failed')}
                        </span>
                        <span className="text-muted-foreground">{formatDuration(c.executionTime)}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
