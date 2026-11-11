/**
 * Runs tab for the agent detail page. Lists autonomous agent runs
 * with expandable step-by-step detail, thread, output, and errors.
 */
import { useEffect, useState } from 'react'
import {
  Loader2,
  ChevronDown,
  ChevronUp,
  Bot,
} from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

import { formatDateTime, pluralized } from '@/lib/utils'
import { EmptyState } from '@/components/ui/empty-state'
import { formatDuration } from './constants'
import { RunStatusBadge } from './run-status-badge'
import { RunApproval } from '@/components/approvals/approval-inspector'
import type { AgentRun } from '@/types'
import { VerifyStepCard, VerifySummary } from './verify-step'
import { CodeStepCard, isCodeStep } from './code-step'
import { PromoteRunSection } from './promote-run-section'
import { RouteTraceTimeline } from './route-trace-timeline'
import { RoleCostTable, StepRoleLine, hasStepSummary, stepSummary } from './run-roles'
import { DeliveryNote } from './schedule-card'
import { MachineProblem } from '@/components/runners/machine-problem'
import type { MachineProblemInfo } from '@/components/runners/hosted-shared'
import { useLiveRun, type LiveRunConnection } from '@/hooks/use-live-run'

interface RunsTabProps {
  runs: AgentRun[]
  /** Needed to fetch a run's route trace, which is scoped by agent. */
  agentId?: string
  /** A run to show opened, from a link to /agents/:id/runs/:runId. */
  openRunId?: string
}

/** Whether any of the run's calls went through routing, so there is a route to show. */
export function runRouted(run: Pick<AgentRun, 'steps'>): boolean {
  return (run.steps ?? []).some((s) => !!(s.output as any)?.routing)
}

/** A tool step whose hosted machine could not start: the backend's sentence and the masked raw error. */
export function stepMachineError(step: { output?: unknown }): MachineProblemInfo | null {
  const m = (step.output as any)?.machineError
  if (!m || typeof m.sentence !== 'string') return null
  return { sentence: m.sentence, detail: typeof m.detail === 'string' ? m.detail : null }
}

export function RunsTab({ runs, agentId, openRunId }: RunsTabProps) {
  const [expandedRunId, setExpandedRunId] = useState<string | null>(openRunId ?? null)
  // A link to another run while this tab is showing opens that one.
  useEffect(() => {
    if (openRunId) setExpandedRunId(openRunId)
  }, [openRunId])

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Autonomous runs</CardTitle>
          <Badge variant="outline">{pluralized(runs.length, 'run')}</Badge>
        </div>
        <CardDescription className="text-xs">
          Runs this agent made in autonomous mode, step by step
        </CardDescription>
      </CardHeader>
      <CardContent>
        {runs.length === 0 ? (
          // A tab called "Runs" that never shows the run you just made is a
          // trap. This one only ever lists autonomous runs; a workflow agent's
          // runs land under Recent runs on Overview, so say so.
          <EmptyState
            icon={Bot}
            title="No autonomous runs yet"
            description={
              <>
                Runs appear here once this agent runs in autonomous mode. A workflow agent&rsquo;s runs
                are listed under <span className="font-medium">Recent runs</span> on the Overview tab
                instead.
              </>
            }
          />
        ) : (
          <div className="@container overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"></TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Input</TableHead>
                  <TableHead>Steps</TableHead>
                  <TableHead>Cost</TableHead>
                  <TableHead>Tokens</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => (
                  <RunRow
                    key={run.id}
                    run={run}
                    agentId={agentId}
                    expanded={expandedRunId === run.id}
                    onToggle={() => setExpandedRunId(expandedRunId === run.id ? null : run.id)}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * One run in the list. Opened while it is still going, it stays live: its
 * steps, status and totals follow the run's event log, and a connection
 * that drops picks up after the last event it showed (useLiveRun).
 */
function RunRow({
  run: listed,
  agentId,
  expanded,
  onToggle,
}: {
  run: AgentRun
  agentId?: string
  expanded: boolean
  onToggle: () => void
}) {
  const queryClient = useQueryClient()
  const { run, connection } = useLiveRun(agentId, listed, expanded, {
    // Finished: read the list again for what the log does not carry.
    onFinished: () => {
      if (agentId) queryClient.invalidateQueries({ queryKey: ['agent-runs', agentId] })
    },
  })

  return (
    <>
      <TableRow
        className="cursor-pointer hover:bg-muted/50"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => onToggle()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
      >
        <TableCell className="px-2">
          {expanded
            ? <ChevronUp className="h-4 w-4 text-muted-foreground" />
            : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </TableCell>
        <TableCell>
          <RunStatusBadge status={run.status} />
          <DeliveryNote outcome={run.metadata?.channelDelivery} />
        </TableCell>
        <TableCell className="text-sm max-w-[200px] truncate">
          {run.input ? JSON.stringify(run.input).slice(0, 80) : '--'}
        </TableCell>
        <TableCell className="text-sm">
          {run.currentStep}/{run.maxSteps}
        </TableCell>
        <TableCell className="text-sm">
          {run.totalCost > 0 ? `$${run.totalCost.toFixed(4)}` : '--'}
        </TableCell>
        <TableCell className="text-sm">
          {run.totalTokens > 0 ? run.totalTokens.toLocaleString() : '--'}
        </TableCell>
        <TableCell className="text-sm">
          {run.executionTime > 0 ? formatDuration(run.executionTime) : '--'}
        </TableCell>
        <TableCell className="text-sm text-muted-foreground">
          {formatDateTime(run.createdAt)}
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow>
          <TableCell colSpan={8} className="bg-surround p-4 sm:p-5">
            {/* The details take the visible width of the list (100cqw of the
                @container around it) and stay put while the columns scroll
                sideways on a phone, so nothing in them is cut off; a long
                step line truncates instead of widening the table. */}
            <div className="sticky left-0 w-[calc(100cqw-2rem)] sm:w-[calc(100cqw-2.5rem)] flow-root space-y-4">
                {/* A run held for a person: the request beside its steps
                    (floated right on wide screens, first on a phone). */}
                {run.status === 'waiting_approval' && (
                  <RunApproval runId={run.id} className="lg:float-right lg:mb-4 lg:ml-5 lg:w-80" />
                )}
                {/* While the run is going, its steps arrive as it takes them. */}
                <LiveRunNote connection={connection} />
              {/* Verification verdict (if the agent ran a verify gate) */}
              <VerifySummary run={run} />
              {/* Where the requests went. Only for runs that
                  routed — a pinned-model run has no trace to
                  show and an empty panel would read as broken. */}
              {agentId && runRouted(run) && (
                <div>
                  <h4 className="mb-2 text-sm font-medium">Route</h4>
                  <RouteTraceTimeline agentId={agentId} executionId={run.id} />
                </div>
              )}
              {/* Which role spent what, for runs of an agent with several models */}
              <RoleCostTable run={run} />
              {/* Steps: the model and tool history, in order. */}
              {run.steps && run.steps.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold mb-2">Steps</h4>
                  <div className="space-y-3">
                    {run.steps.map((step, idx) => {
                      if (step.type === 'verify') return <VerifyStepCard key={idx} step={step} index={idx} />
                      if (isCodeStep(step)) return <CodeStepCard key={idx} step={step} index={idx} agentId={agentId} runId={run.id} />
                      const summary = stepSummary(step)
                      const machineError = stepMachineError(step)
                      return (
                      <div key={idx} className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border bg-card p-3 text-sm sm:flex-nowrap" data-testid={`run-step-${idx}`}>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-selection text-xs font-semibold tabular-nums text-selection-foreground" aria-label={`Step ${idx + 1}`}>{idx + 1}</span>
                          <Badge variant="outline" className="font-mono">{step.type}</Badge>
                        </div>
                        <div className="order-last min-w-0 flex-1 basis-full space-y-0.5 sm:order-none sm:basis-auto">
                          <StepRoleLine step={step} />
                          {summary && <div className="text-sm">{summary}</div>}
                          {step.input && !hasStepSummary(step) && (
                            <div className="text-xs text-muted-foreground truncate">
                              In: {typeof step.input === 'string' ? step.input : JSON.stringify(step.input)}
                            </div>
                          )}
                          {step.output && !hasStepSummary(step) && !machineError && (
                            <div className="text-xs truncate">
                              Out: {typeof step.output === 'string' ? step.output : JSON.stringify(step.output)}
                            </div>
                          )}
                          {machineError ? (
                            <MachineProblem problem={machineError} testId={`run-step-${idx}-machine`} />
                          ) : step.error && (
                            <div className="text-xs text-destructive truncate">
                              Error: {step.error}
                            </div>
                          )}
                        </div>
                        <div className="text-xs tabular-nums text-muted-foreground shrink-0 text-right">
                          {step.duration ? formatDuration(step.duration) : ''}
                          {step.cost ? ` / $${step.cost.toFixed(4)}` : ''}
                        </div>
                      </div>
                      )
                    })}
                  </div>
                </div>
              )}
              {/* Thread */}
              {run.thread && run.thread.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium mb-2">Thread</h4>
                  <div className="space-y-1 max-h-[300px] overflow-y-auto">
                    {run.thread.map((msg, idx) => (
                      <div key={idx} className={`p-2 rounded text-sm ${msg.role === 'assistant' ? 'bg-primary/5 border-l-2 border-primary' : 'bg-background dark:bg-muted/40 border'}`}>
                        <span className="text-xs font-medium text-muted-foreground">{msg.role}</span>
                        <div className="text-xs mt-0.5 whitespace-pre-wrap">
                          {typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {/* Error */}
              {run.error && (
                <div className="rounded-lg border border-danger-border bg-danger-subtle p-3 text-sm text-danger">
                  {run.error}
                </div>
              )}
              {/* Output */}
              {run.output && (
                <div>
                  <h4 className="text-sm font-semibold mb-1.5">Output</h4>
                  <div className="rounded-lg border bg-code p-3 font-mono text-[0.8125rem] leading-[1.375rem] text-code-foreground whitespace-pre-wrap [overflow-wrap:anywhere] max-h-[240px] overflow-auto">
                    {typeof run.output === 'string' ? run.output : JSON.stringify(run.output, null, 2)}
                  </div>
                </div>
              )}
              {/* Promote a completed run to a reusable skill, in place */}
              {run.status === 'completed' && <PromoteRunSection runId={run.id} />}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  )
}

/** Whether an open run's view is following it live, or catching up after a dropped connection. */
export function LiveRunNote({ connection }: { connection: LiveRunConnection }) {
  if (connection === 'live') {
    return (
      <Badge variant="outline" className="gap-1.5 text-xs font-normal" data-testid="run-live">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
        Live
      </Badge>
    )
  }
  if (connection === 'connecting' || connection === 'reconnecting') {
    return (
      <Badge variant="outline" className="gap-1.5 text-xs font-normal text-muted-foreground" data-testid="run-reconnecting">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        {connection === 'connecting' ? 'Connecting' : 'Reconnecting, nothing is lost'}
      </Badge>
    )
  }
  if (connection === 'gone') {
    // Refused for good (gone, or no longer ours to see): what is on screen is the last known state.
    return (
      <Badge variant="outline" className="text-xs font-normal text-muted-foreground" data-testid="run-gone">
        This run is no longer available. Showing what was last seen.
      </Badge>
    )
  }
  return null
}
