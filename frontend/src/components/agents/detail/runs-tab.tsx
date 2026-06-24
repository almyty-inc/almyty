/**
 * Runs tab for the agent detail page. Lists autonomous agent runs
 * with expandable step-by-step detail, thread, output, and errors.
 */
import React, { useState } from 'react'
import {
  CheckCircle2,
  XCircle,
  Loader2,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'

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

import { formatDateTime } from '@/lib/utils'
import { runStatusVariant, formatDuration } from './constants'
import type { AgentRun } from '@/types'
import { VerifyStepCard, VerifySummary } from './verify-step'
import { PromoteRunDialog } from './promote-run-dialog'

interface RunsTabProps {
  runs: AgentRun[]
}

export function RunsTab({ runs }: RunsTabProps) {
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null)

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Autonomous Runs</CardTitle>
          <Badge variant="outline">{runs.length} run{runs.length !== 1 ? 's' : ''}</Badge>
        </div>
        <CardDescription className="text-xs">
          Autonomous agent runs with step-by-step execution details
        </CardDescription>
      </CardHeader>
      <CardContent>
        {runs.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            No runs yet. Start a run by invoking the agent in autonomous mode.
          </p>
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
                {runs.map((run) => (
                  <React.Fragment key={run.id}>
                    <TableRow
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => setExpandedRunId(expandedRunId === run.id ? null : run.id)}
                    >
                      <TableCell className="px-2">
                        {expandedRunId === run.id
                          ? <ChevronUp className="h-4 w-4 text-muted-foreground" />
                          : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                      </TableCell>
                      <TableCell>
                        <Badge variant={runStatusVariant[run.status] || 'secondary'}>
                          {run.status === 'completed' && <CheckCircle2 className="h-3 w-3 mr-1" />}
                          {run.status === 'failed' && <XCircle className="h-3 w-3 mr-1" />}
                          {run.status === 'running' && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                          {run.status.replace('_', ' ')}
                        </Badge>
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
                    {expandedRunId === run.id && (
                      <TableRow>
                        <TableCell colSpan={8} className="bg-muted/30 p-4">
                          <div className="space-y-4">
                            {/* Verification verdict (if the agent ran a verify gate) */}
                            <VerifySummary run={run} />
                            {/* Steps */}
                            {run.steps && run.steps.length > 0 && (
                              <div>
                                <h4 className="text-sm font-medium mb-2">Steps</h4>
                                <div className="space-y-2">
                                  {run.steps.map((step, idx) => (
                                    step.type === 'verify' ? (
                                      <VerifyStepCard key={idx} step={step} index={idx} />
                                    ) : (
                                    <div key={idx} className="flex items-start gap-3 p-2 rounded bg-background border text-sm">
                                      <div className="flex items-center gap-2 shrink-0">
                                        <span className="text-xs font-mono text-muted-foreground">#{idx + 1}</span>
                                        <Badge variant="outline" className="text-[10px]">{step.type}</Badge>
                                      </div>
                                      <div className="min-w-0 flex-1">
                                        {step.input && (
                                          <div className="text-xs text-muted-foreground truncate">
                                            In: {typeof step.input === 'string' ? step.input : JSON.stringify(step.input)}
                                          </div>
                                        )}
                                        {step.output && (
                                          <div className="text-xs truncate">
                                            Out: {typeof step.output === 'string' ? step.output : JSON.stringify(step.output)}
                                          </div>
                                        )}
                                        {step.error && (
                                          <div className="text-xs text-destructive truncate">
                                            Error: {step.error}
                                          </div>
                                        )}
                                      </div>
                                      <div className="text-[10px] text-muted-foreground shrink-0 text-right">
                                        {step.duration ? formatDuration(step.duration) : ''}
                                        {step.cost ? ` / $${step.cost.toFixed(4)}` : ''}
                                      </div>
                                    </div>
                                    )
                                  ))}
                                </div>
                              </div>
                            )}
                            {/* Thread */}
                            {run.thread && run.thread.length > 0 && (
                              <div>
                                <h4 className="text-sm font-medium mb-2">Thread</h4>
                                <div className="space-y-1 max-h-[300px] overflow-y-auto">
                                  {run.thread.map((msg, idx) => (
                                    <div key={idx} className={`p-2 rounded text-sm ${msg.role === 'assistant' ? 'bg-primary/5 border-l-2 border-primary' : 'bg-background border'}`}>
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
                              <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">
                                {run.error}
                              </div>
                            )}
                            {/* Output */}
                            {run.output && (
                              <div>
                                <h4 className="text-sm font-medium mb-1">Output</h4>
                                <div className="bg-muted rounded p-2 text-xs whitespace-pre-wrap max-h-[200px] overflow-auto">
                                  {typeof run.output === 'string' ? run.output : JSON.stringify(run.output, null, 2)}
                                </div>
                              </div>
                            )}
                            {/* Promote a completed run to a reusable skill */}
                            {run.status === 'completed' && (
                              <div className="flex justify-end pt-1">
                                <PromoteRunDialog runId={run.id} />
                              </div>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </React.Fragment>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
