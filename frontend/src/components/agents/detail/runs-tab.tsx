/**
 * Runs tab for the agent detail page. Lists every run of the agent --
 * workflow runs and autonomous runs -- with expandable step-by-step
 * detail, thread, output, and errors.
 */
import React, { useEffect, useMemo, useState } from 'react'
import {
  Loader2,
  ArrowLeft,
  ChevronRight,
  Bot,
} from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Disclosure } from '@/components/ui/disclosure'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

import { formatDateTime, pluralized } from '@/lib/utils'
import { runInputPreview, stepInputPreview } from '@/lib/run-input'
import { agentsApi } from '@/lib/api'
import { EmptyState } from '@/components/ui/empty-state'
import { costTitle, formatCost, formatDuration } from '@/lib/format'
import { RunStatusBadge } from './run-status-badge'
import { RunApproval } from '@/components/approvals/approval-inspector'
import type { AgentExecution, AgentRun } from '@/types'
import { UnverifiedNote, VerifyStepCard, VerifySummary } from './verify-step'
import { CodeStepCard, isCodeStep } from './code-step'
import { PromoteRunSection } from './promote-run-section'
import { DeleteRunButton } from './delete-run-button'
import { useCanManageAgent } from '@/hooks/use-organization-role'
import { RouteTraceTimeline } from './route-trace-timeline'
import { RoleCostTable, StepRoleLine, hasStepSummary, stepSummary } from './run-roles'
import { DeliveryNote } from './schedule-card'
import { executionModels } from './routing-attribution'
import { STEP_NAMES, stepNameOf } from '../step-values'
import { MachineProblem } from '@/components/runners/machine-problem'
import type { MachineProblemInfo } from '@/components/runners/hosted-shared'
import { useLiveRun, type LiveRunConnection } from '@/hooks/use-live-run'
import { AssistantMarkdown } from '@/components/hosted-chat/assistant-markdown'
import { RecalledMemories } from './recalled-memories'

interface RunsTabProps {
  /** Autonomous runs. */
  runs: AgentRun[]
  /** Workflow runs, listed with them. */
  executions?: AgentExecution[]
  /** Needed to fetch a run's route trace, which is scoped by agent. */
  agentId?: string
  /** A run to show opened, from a link to /agents/:id/runs/:runId. */
  openRunId?: string
  /** The agent's owner: they, and the organization's admins and owners, may delete its runs. */
  ownerUserId?: string | null
  /** The server's answer to "may this person manage the agent" (GET /agents/:id); wins over the owner guess. */
  viewerCanManage?: boolean
  /**
   * How many runs the agent has in all (the lists' `pagination.total`).
   * The lists hold one page, so their length is the page size.
   */
  total?: number
  /** How many autonomous runs and workflow runs there are in all: while a list holds fewer, "Show more" reads its next page. */
  runsTotal?: number
  executionsTotal?: number
}

/**
 * A run's output. Text is the agent's answer, rendered from its markdown
 * the way Try it and the web chat render it (an agent's tables showed as
 * pipes here); anything else is shown as JSON.
 */
export function RunOutput({ output }: { output: unknown }) {
  if (typeof output === 'string') {
    return (
      <div data-testid="run-output" className="rounded-lg border bg-surround p-3 text-sm break-words max-h-[400px] overflow-auto">
        <AssistantMarkdown>{output}</AssistantMarkdown>
      </div>
    )
  }
  return (
    <div data-testid="run-output" className="rounded-lg border bg-code p-3 font-mono text-[0.8125rem] leading-[1.375rem] text-code-foreground whitespace-pre-wrap [overflow-wrap:anywhere] max-h-[240px] overflow-auto">
      {JSON.stringify(output, null, 2)}
    </div>
  )
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

/** How many runs one page of either list holds: the size the lists are first read with. */
export const RUNS_PAGE_SIZE = 20

type Row =
  | { kind: 'run'; id: string; createdAt: string; run: AgentRun }
  | { kind: 'execution'; id: string; createdAt: string; exec: AgentExecution }

/** Each item once, the first seen kept: a page read after new runs arrived repeats some. */
function once<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>()
  return items.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)))
}

function oldest(items: Array<{ createdAt: string }>): number {
  return items.reduce((min, x) => Math.min(min, Date.parse(x.createdAt)), Infinity)
}

/**
 * The rows to show, newest first. Workflow runs and autonomous runs come
 * in pages of their own; while a list has more pages to read, nothing
 * older than its oldest row read is shown, so a run from the other list
 * never jumps ahead of one not read yet.
 */
export function visibleRows(
  runs: AgentRun[],
  executions: AgentExecution[],
  more: { runs: boolean; executions: boolean },
): Row[] {
  const rows: Row[] = [
    ...runs.map((run) => ({ kind: 'run' as const, id: run.id, createdAt: run.createdAt, run })),
    ...executions.map((exec) => ({ kind: 'execution' as const, id: exec.id, createdAt: exec.createdAt, exec })),
  ].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  const cutoff = Math.max(
    more.runs && runs.length ? oldest(runs) : -Infinity,
    more.executions && executions.length ? oldest(executions) : -Infinity,
  )
  return rows.filter((r) => Date.parse(r.createdAt) >= cutoff)
}

export function RunsTab({ runs, executions = [], agentId, openRunId, ownerUserId, viewerCanManage, total, runsTotal, executionsTotal }: RunsTabProps) {
  const canManage = useCanManageAgent(ownerUserId, viewerCanManage)
  const [expandedRunId, setExpandedRunId] = useState<string | null>(openRunId ?? null)
  // A link to another run while this tab is showing opens that one.
  useEffect(() => {
    if (openRunId) setExpandedRunId(openRunId)
  }, [openRunId])
  // Pages read past the first, by "Show more".
  const [later, setLater] = useState<{ runs: AgentRun[]; executions: AgentExecution[]; runPages: number; executionPages: number }>({
    runs: [],
    executions: [],
    runPages: 1,
    executionPages: 1,
  })
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState(false)
  useEffect(() => {
    setLater({ runs: [], executions: [], runPages: 1, executionPages: 1 })
  }, [agentId])
  const allRuns = useMemo(() => once([...runs, ...later.runs]), [runs, later.runs])
  const allExecutions = useMemo(() => once([...executions, ...later.executions]), [executions, later.executions])
  const moreRuns = typeof runsTotal === 'number' && allRuns.length < runsTotal
  const moreExecutions = typeof executionsTotal === 'number' && allExecutions.length < executionsTotal
  // Workflow runs and autonomous runs, newest first: both are this agent's runs.
  const rows = useMemo(
    () => visibleRows(allRuns, allExecutions, { runs: moreRuns, executions: moreExecutions }),
    [allRuns, allExecutions, moreRuns, moreExecutions],
  )
  const toggle = (id: string) => setExpandedRunId(expandedRunId === id ? null : id)
  // Every run of the agent, not the page listed below it.
  const count = typeof total === 'number' && total >= rows.length ? total : rows.length
  // An opened run takes the whole width in place of the list. Inside a
  // table row it was squeezed into a scrolled cell, and on a phone the
  // list above and below it made the page several screens long.
  const opened = expandedRunId ? rows.find((r) => r.id === expandedRunId) : undefined

  // The next page of each list that has more, read on "Show more".
  const showMore = async () => {
    if (!agentId || loadingMore) return
    setLoadingMore(true)
    setMoreError(false)
    try {
      const [r, e] = await Promise.all([
        moreRuns ? agentsApi.listRunsPage(agentId, { page: later.runPages + 1, limit: RUNS_PAGE_SIZE }) : null,
        moreExecutions ? agentsApi.getExecutionsPage(agentId, { page: later.executionPages + 1, limit: RUNS_PAGE_SIZE }) : null,
      ])
      setLater((prev) => ({
        runs: r ? [...prev.runs, ...r.items] : prev.runs,
        executions: e ? [...prev.executions, ...e.items] : prev.executions,
        runPages: r ? prev.runPages + 1 : prev.runPages,
        executionPages: e ? prev.executionPages + 1 : prev.executionPages,
      }))
    } catch {
      setMoreError(true)
    } finally {
      setLoadingMore(false)
    }
  }

  if (opened) {
    return opened.kind === 'run' ? (
      <OpenedRun
        key={`run-${opened.id}`}
        run={opened.run}
        agentId={agentId}
        onClose={() => setExpandedRunId(null)}
        canDelete={canManage}
        onDeleted={(deletedId) => {
          // Back to the list, without the run on any page read so far.
          setLater((prev) => ({ ...prev, runs: prev.runs.filter((r) => r.id !== deletedId) }))
          setExpandedRunId(null)
        }}
      />
    ) : (
      <OpenedExecution key={`execution-${opened.id}`} exec={opened.exec} agentId={agentId} onClose={() => setExpandedRunId(null)} />
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Runs</CardTitle>
          <Badge variant="outline">{pluralized(count, 'run')}</Badge>
        </div>
        <CardDescription className="text-xs">
          Every run of this agent, step by step. Open one to see what each step did.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            icon={Bot}
            title="No runs yet"
            description="Every time this agent runs (from Try it, the Run button, a webhook, a schedule or a chat) the run is listed here."
          />
        ) : (
          <div className="overflow-x-auto">
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
                {rows.map((row) =>
                  row.kind === 'run' ? (
                    <RunRow key={`run-${row.id}`} run={row.run} onOpen={() => toggle(row.id)} />
                  ) : (
                    <ExecutionRow key={`execution-${row.id}`} exec={row.exec} onOpen={() => toggle(row.id)} />
                  ),
                )}
              </TableBody>
            </Table>
          </div>
        )}
        {(moreRuns || moreExecutions) && rows.length > 0 && (
          <div className="mt-3 flex items-center justify-between gap-2 text-xs text-muted-foreground" data-testid="runs-show-more">
            <span>
              Showing {rows.length} of {pluralized(count, 'run')}
              {moreError ? '. The next runs could not be loaded.' : ''}
            </span>
            <Button variant="outline" size="sm" onClick={() => void showMore()} disabled={loadingMore || !agentId}>
              {loadingMore && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
              {moreError ? 'Try again' : 'Show more'}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** A row of the list: opens its run. */
function ListRow({ onOpen, testId, children }: { onOpen: () => void; testId?: string; children: React.ReactNode }) {
  return (
    <TableRow
      className="cursor-pointer hover:bg-muted/50"
      role="button"
      tabIndex={0}
      aria-expanded={false}
      data-testid={testId}
      onClick={() => onOpen()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
    >
      <TableCell className="px-2">
        <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
      </TableCell>
      {children}
    </TableRow>
  )
}

/** An autonomous run in the list. */
function RunRow({ run, onOpen }: { run: AgentRun; onOpen: () => void }) {
  return (
    <ListRow onOpen={onOpen}>
      <TableCell>
        <RunStatusBadge status={run.status} />
        <UnverifiedNote run={run} compact />
        <DeliveryNote outcome={run.metadata?.channelDelivery} />
      </TableCell>
      <TableCell className="text-sm max-w-[200px] truncate">
        {runInputPreview(run.input)}
      </TableCell>
      <TableCell className="text-sm">
        {run.currentStep}/{run.maxSteps}
      </TableCell>
      <TableCell className="text-sm" title={costTitle(run.totalCost)}>
        {formatCost(run.totalCost)}
      </TableCell>
      <TableCell className="text-sm">
        {run.totalTokens > 0 ? run.totalTokens.toLocaleString() : '--'}
      </TableCell>
      <TableCell className="text-sm">
        {formatDuration(run.executionTime)}
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {formatDateTime(run.createdAt)}
      </TableCell>
    </ListRow>
  )
}

/** A workflow run in the list: the same columns. */
function ExecutionRow({ exec, onOpen }: { exec: AgentExecution; onOpen: () => void }) {
  const steps = Object.keys(exec.nodeResults || {})
  return (
    <ListRow onOpen={onOpen} testId={`execution-row-${exec.id}`}>
      <TableCell>
        <RunStatusBadge status={exec.status} />
        <UnverifiedNote run={exec} compact />
        <DeliveryNote outcome={exec.metadata?.channelDelivery} />
      </TableCell>
      <TableCell className="text-sm max-w-[200px] truncate">
        {runInputPreview(exec.input)}
      </TableCell>
      <TableCell className="text-sm">{steps.length}</TableCell>
      <TableCell className="text-sm" title={costTitle(exec.totalCost)}>
        {formatCost(exec.totalCost)}
      </TableCell>
      <TableCell className="text-sm">
        {exec.totalTokens > 0 ? exec.totalTokens.toLocaleString() : '--'}
      </TableCell>
      <TableCell className="text-sm">
        {formatDuration(exec.executionTime)}
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {formatDateTime(exec.createdAt)}
      </TableCell>
    </ListRow>
  )
}

/**
 * The head of an opened run: the way back to the list, the run's status
 * and when it ran, and its totals as a short list that wraps on a phone.
 */
function OpenedRunHeader({
  status,
  createdAt,
  facts,
  onClose,
  notes,
  actions,
}: {
  status: string
  createdAt: string
  facts: Array<[label: string, value: string, title?: string]>
  onClose: () => void
  notes?: React.ReactNode
  /** Controls for the run, beside "All runs" (Delete run). */
  actions?: React.ReactNode
}) {
  return (
    <CardHeader className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" className="-ml-2 gap-1.5 text-muted-foreground" aria-expanded onClick={onClose}>
          <ArrowLeft className="h-4 w-4" aria-hidden />
          All runs
        </Button>
        {actions}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <CardTitle className="text-base">Run of {formatDateTime(createdAt)}</CardTitle>
        <RunStatusBadge status={status} />
        {notes}
      </div>
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm" data-testid="opened-run-facts">
        {facts.map(([label, value, title]) => (
          <div key={label} className="flex gap-1.5">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-medium tabular-nums" title={title}>{value}</dd>
          </div>
        ))}
      </dl>
    </CardHeader>
  )
}

/**
 * An opened autonomous run, the full width of the tab. Opened while it is
 * still going, it stays live: its steps, status and totals follow the
 * run's event log, and a connection that drops picks up after the last
 * event it showed (useLiveRun).
 */
function OpenedRun({
  run: listed,
  agentId,
  onClose,
  canDelete = false,
  onDeleted,
}: {
  run: AgentRun
  agentId?: string
  onClose: () => void
  /** Whether to offer "Delete run" (the person may manage the agent). */
  canDelete?: boolean
  onDeleted?: (runId: string) => void
}) {
  const queryClient = useQueryClient()
  const { run, connection } = useLiveRun(agentId, listed, true, {
    // Finished: read the list again for what the log does not carry.
    onFinished: () => {
      if (agentId) queryClient.invalidateQueries({ queryKey: ['agent-runs', agentId] })
    },
  })

  return (
    <Card data-testid={`opened-run-${run.id}`}>
      <OpenedRunHeader
        status={run.status}
        createdAt={run.createdAt}
        onClose={onClose}
        actions={
          canDelete && agentId && onDeleted ? (
            <DeleteRunButton agentId={agentId} runId={run.id} status={run.status} onDeleted={onDeleted} />
          ) : undefined
        }
        notes={
          <>
            <UnverifiedNote run={run} compact />
            <DeliveryNote outcome={run.metadata?.channelDelivery} />
          </>
        }
        facts={[
          ['Steps', `${run.currentStep}/${run.maxSteps}`],
          ['Cost', formatCost(run.totalCost), costTitle(run.totalCost)],
          ['Tokens', run.totalTokens > 0 ? run.totalTokens.toLocaleString() : '--'],
          ['Duration', formatDuration(run.executionTime)],
        ]}
      />
      <CardContent className="flow-root space-y-4">
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
                    <StepNumber n={idx + 1} />
                    <Badge variant="outline">{STEP_NAMES[step.type] ?? step.type}</Badge>
                  </div>
                  <div className="order-last min-w-0 flex-1 basis-full space-y-0.5 sm:order-none sm:basis-auto">
                    <StepRoleLine step={step} />
                    {summary && <div className="text-sm">{summary}</div>}
                    {step.input && !hasStepSummary(step) && (
                      <div className="text-xs text-muted-foreground truncate">
                        In: {stepInputPreview(step.input)}
                      </div>
                    )}
                    {step.output && !hasStepSummary(step) && !machineError && (
                      <div className="text-xs truncate">
                        Out: {typeof step.output === 'string' ? step.output : JSON.stringify(step.output)}
                      </div>
                    )}
                    <RecalledMemories step={step} index={idx} />
                    {machineError ? (
                      <MachineProblem problem={machineError} testId={`run-step-${idx}-machine`} />
                    ) : step.error && (
                      <div className="text-xs text-destructive truncate">
                        Error: {step.error}
                      </div>
                    )}
                  </div>
                  <div className="ml-auto text-xs tabular-nums text-muted-foreground shrink-0 text-right sm:ml-0">
                    {step.duration ? formatDuration(step.duration) : ''}
                    {step.cost ? <span title={costTitle(step.cost)}>{` / ${formatCost(step.cost)}`}</span> : ''}
                  </div>
                </div>
                )
              })}
            </div>
          </div>
        )}
        {/* Thread */}
        {run.thread && run.thread.length > 0 && (
          <Disclosure title={`Thread (${pluralized(run.thread.length, 'message')})`}>
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
          </Disclosure>
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
            <RunOutput output={run.output} />
          </div>
        )}
        {/* Promote a completed run to a reusable skill, in place */}
        {run.status === 'completed' && <PromoteRunSection runId={run.id} />}
      </CardContent>
    </Card>
  )
}

/** A step's number, the same in autonomous and workflow runs. */
function StepNumber({ n }: { n: number }) {
  return (
    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-selection text-xs font-semibold tabular-nums text-selection-foreground" aria-label={`Step ${n}`}>
      {n}
    </span>
  )
}

/** An opened workflow run, the full width of the tab: its steps, one per step of the workflow. */
function OpenedExecution({ exec, agentId, onClose }: { exec: AgentExecution; agentId?: string; onClose: () => void }) {
  const steps = Object.entries(exec.nodeResults || {})
  const routed = steps.some(([, r]) => !!r?.routing)
  const models = executionModels(exec.nodeResults)
  return (
    <Card data-testid={`opened-run-${exec.id}`}>
      <OpenedRunHeader
        status={exec.status}
        createdAt={exec.createdAt}
        onClose={onClose}
        notes={
          <>
            <UnverifiedNote run={exec} compact />
            <DeliveryNote outcome={exec.metadata?.channelDelivery} />
          </>
        }
        facts={[
          ['Steps', String(steps.length)],
          ['Cost', formatCost(exec.totalCost), costTitle(exec.totalCost)],
          ['Tokens', exec.totalTokens > 0 ? exec.totalTokens.toLocaleString() : '--'],
          ['Duration', formatDuration(exec.executionTime)],
        ]}
      />
      <CardContent className="space-y-4" data-testid={`execution-detail-${exec.id}`}>
        {models.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {models.length === 1 ? 'Model' : 'Models'}: <span className="text-foreground">{models.join(', ')}</span>
          </p>
        )}
        {agentId && routed && (
          <div>
            <h4 className="mb-2 text-sm font-medium">Route</h4>
            <RouteTraceTimeline agentId={agentId} executionId={exec.id} />
          </div>
        )}
        {steps.length > 0 && (
          <div>
            <h4 className="text-sm font-semibold mb-2">Steps</h4>
            <div className="space-y-3">
              {steps.map(([nodeId, r], idx) => (
                <div
                  key={nodeId}
                  className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border bg-card p-3 text-sm sm:flex-nowrap"
                  data-testid={`execution-step-${idx}`}
                >
                  <div className="flex items-center gap-2 shrink-0">
                    <StepNumber n={idx + 1} />
                    <Badge variant="outline" title={nodeId}>{stepNameOf(r?.nodeType, nodeId)}</Badge>
                  </div>
                  <div className="order-last min-w-0 flex-1 basis-full space-y-0.5 sm:order-none sm:basis-auto">
                    {(r as any)?.model && <div className="text-xs text-muted-foreground">{(r as any).model}</div>}
                    {r?.output !== undefined && r?.output !== null && (
                      <div className="text-xs truncate">
                        Out: {typeof r.output === 'string' ? r.output : JSON.stringify(r.output)}
                      </div>
                    )}
                    {r?.error && <div className="text-xs text-destructive truncate">Error: {r.error}</div>}
                  </div>
                  <div className="ml-auto text-xs tabular-nums text-muted-foreground shrink-0 text-right sm:ml-0">
                    {r?.executionTime ? formatDuration(r.executionTime) : ''}
                    {r?.cost ? <span title={costTitle(r.cost)}>{` / ${formatCost(r.cost)}`}</span> : ''}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {exec.error && (
          <div className="rounded-lg border border-danger-border bg-danger-subtle p-3 text-sm text-danger">{exec.error}</div>
        )}
        {exec.output !== undefined && exec.output !== null && (
          <div>
            <h4 className="text-sm font-semibold mb-1.5">Output</h4>
            <RunOutput output={exec.output} />
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** Whether an open run's view is following it live, or catching up after a dropped connection. */
export function LiveRunNote({ connection }: { connection: LiveRunConnection }) {
  if (connection === 'live') {
    return (
      <Badge variant="outline" className="gap-1.5 text-xs font-normal" data-testid="run-live">
        <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
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
