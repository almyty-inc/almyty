import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Check, X, Clock, AlertCircle, Bot } from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/layout/page-header'
import { Field, InlineFormActions } from '@/components/layout/form-page'
import { useLeaveGuard } from '@/hooks/use-leave-guard'

import { approvalsApi } from '@/lib/api'
import { formatRelativeTime, pluralized } from '@/lib/utils'
import { useNotifications } from '@/store/app'
import { getApiErrorMessage } from '@/lib/api-error'
import { ChangeSetView } from '@/components/approvals/change-set-view'
import type { ChangeSetEntry } from '@/types'

interface ApprovalRequest {
  id: string
  organizationId: string
  teamId: string | null
  visibility: 'org' | 'team' | 'private'
  /** Null for a held tool call from a caller that could not wait (a workflow, a gateway, the Test button). */
  runId: string | null
  agentId: string | null
  /** The agent's name; null once the agent has been deleted. */
  agentName?: string | null
  toolCallId: string | null
  reason: string
  payload: Record<string, any> | null
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  decidedBy: string | null
  decidedAt: string | null
  decisionReason: string | null
  expiresAt: string | null
  createdAt: string
}

const POLL_MS = 10_000

/** A script's change set (code mode): several calls approved or rejected as a whole. */
export function isChangeSet(row: Pick<ApprovalRequest, 'payload'>): boolean {
  return row.payload?.kind === 'change_set' && Array.isArray(row.payload?.changeSet)
}

/** What a decision does, in one sentence, before a person confirms it. */
export function decisionMessage(row: Pick<ApprovalRequest, 'payload'>, intent: 'approve' | 'reject'): string {
  if (isChangeSet(row)) {
    const n = (row.payload!.changeSet as unknown[]).length
    return intent === 'approve'
      ? `All ${pluralized(n, 'change')} run, in this order. If one fails, the ones after it do not run; nothing is undone.`
      : 'None of the changes run. The agent is told, and carries on without them.'
  }
  return intent === 'approve'
    ? 'The run resumes where it paused, with this approval as the answer to its request.'
    : 'The run is cancelled for good; it cannot be resumed.'
}

export function ApprovalsPage() {
  const queryClient = useQueryClient()
  const { success, error: errNotif } = useNotifications()
  const [decisionFor, setDecisionFor] = useState<{ row: ApprovalRequest; intent: 'approve' | 'reject' } | null>(null)
  const [decisionReason, setDecisionReason] = useState('')
  // A written note asks before a navigation throws it away. Cancel and a
  // recorded decision both clear it, so neither asks.
  const guard = useLeaveGuard(decisionFor !== null && decisionReason !== '')

  useEffect(() => {
    document.title = 'Approvals | almyty'
    return () => { document.title = 'almyty' }
  }, [])

  // approvalsApi.list() goes through apiGet which extracts the
  // { success, data } envelope, so the resolved value IS the array.
  // The earlier type declared { data: ApprovalRequest[] } and the
  // page read query.data?.data — that extra hop was always
  // undefined, so the dashboard rendered "No pending approvals"
  // even when /approvals returned rows.
  const query = useQuery<ApprovalRequest[]>({
    queryKey: ['approvals'],
    queryFn: () => approvalsApi.list(),
    refetchInterval: POLL_MS,
  })

  const approveMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) => approvalsApi.approve(id, reason),
    onSuccess: () => {
      success('Approved', 'The agent run will resume.')
      queryClient.invalidateQueries({ queryKey: ['approvals'] })
      setDecisionFor(null)
      setDecisionReason('')
    },
    onError: (err: any) => errNotif('Approve failed', getApiErrorMessage(err, 'Unknown')),
  })

  const rejectMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) => approvalsApi.reject(id, reason),
    onSuccess: () => {
      success('Rejected', 'The agent run was cancelled.')
      queryClient.invalidateQueries({ queryKey: ['approvals'] })
      setDecisionFor(null)
      setDecisionReason('')
    },
    onError: (err: any) => errNotif('Reject failed', getApiErrorMessage(err, 'Unknown')),
  })

  const rows = (query.data ?? []) as ApprovalRequest[]

  return (
    <div className="space-y-6">
      <PageHeader
        title="Approvals"
        description={query.isLoading ? 'Agent runs and tool calls waiting for a person.' : `${rows.length} pending · agent runs and tool calls waiting for a person`}
      />

      {query.isLoading ? (
        <div className="flex justify-center py-16"><LoadingSpinner size="lg" /></div>
      ) : query.isError ? (
        <QueryError error={query.error} onRetry={() => query.refetch()} title="Couldn't load approvals" />
      ) : rows.length === 0 ? (
        <EmptyState
          variant="panel"
          icon={Check}
          title="No pending approvals"
          description={
            <>
              When an agent calls the <code className="px-1 py-0.5 bg-muted rounded">request_approval</code> tool, it appears here for review.
            </>
          }
        />
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <Card key={row.id} className="border-amber-200 dark:border-amber-900">
              <CardHeader>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Bot className="h-4 w-4 text-muted-foreground" />
                      {!row.agentId ? (
                        // A held tool call no agent made.
                        <span className="truncate">{row.payload?.tool ? `Tool call: ${row.payload.tool}` : 'Tool call'}</span>
                      ) : row.agentName ? (
                        <Link to={`/agents/${row.agentId}`} className="hover:underline truncate">
                          {row.agentName}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground truncate">Deleted agent</span>
                      )}
                      <Badge variant="outline" className="text-amber-600 border-amber-300 dark:border-amber-800 dark:text-amber-400">
                        <Clock className="h-3 w-3 mr-1" />
                        pending
                      </Badge>
                      <Badge variant="outline">{row.visibility === 'private' ? 'private' : row.visibility === 'team' ? 'team' : 'org'}</Badge>
                    </CardTitle>
                    <CardDescription className="mt-2 text-foreground">{row.reason}</CardDescription>
                    {isChangeSet(row) && (
                      <div className="mt-3">
                        <ChangeSetView entries={row.payload!.changeSet as ChangeSetEntry[]} />
                      </div>
                    )}
                  </div>
                  {decisionFor?.row.id !== row.id && (
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-emerald-700 dark:text-emerald-400 border-emerald-300 dark:border-emerald-800"
                      onClick={() => { setDecisionFor({ row, intent: 'approve' }); setDecisionReason('') }}
                    >
                      <Check className="h-4 w-4 mr-1" /> Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-red-700 dark:text-red-400 border-red-300 dark:border-red-800"
                      onClick={() => { setDecisionFor({ row, intent: 'reject' }); setDecisionReason('') }}
                    >
                      <X className="h-4 w-4 mr-1" /> Reject
                    </Button>
                  </div>
                  )}
                </div>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground space-y-1">
                <div>
                  {row.runId ? (
                    <>
                      Run:{' '}
                      <Link to={`/agents/${row.agentId}/runs/${row.runId}`} className="font-mono hover:underline">
                        {row.runId.slice(0, 12)}
                      </Link>
                      {' · '}
                    </>
                  ) : (
                    // A held tool call: it runs, exactly as asked, once approved.
                    <>The call runs once approved · </>
                  )}
                  requested {formatRelativeTime(row.createdAt)}
                  {row.expiresAt && (
                    <> · expires {formatRelativeTime(row.expiresAt)}</>
                  )}
                </div>
                {row.payload && Object.keys(row.payload).length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-foreground/80">Action details</summary>
                    <pre className="mt-2 p-3 bg-muted rounded text-xs overflow-auto max-h-64">
                      {JSON.stringify(row.payload, null, 2)}
                    </pre>
                  </details>
                )}
                {decisionFor?.row.id === row.id && (
                  <form
                    className="mt-3 space-y-3 rounded-lg border bg-background p-3 text-sm text-foreground"
                    aria-label={decisionFor.intent === 'approve' ? 'Approve this action' : 'Reject this action'}
                    onSubmit={(e) => {
                      e.preventDefault()
                      const args = { id: row.id, reason: decisionReason.trim() || undefined }
                      if (decisionFor.intent === 'approve') approveMutation.mutate(args)
                      else rejectMutation.mutate(args)
                    }}
                  >
                    <p className="flex items-start gap-2">
                      {decisionFor.intent === 'approve' ? (
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" aria-hidden="true" />
                      ) : (
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" aria-hidden="true" />
                      )}
                      {decisionMessage(row, decisionFor.intent)}
                    </p>
                    <Field id={`decision-reason-${row.id}`} label="Note (optional)" hint="Saved with the decision.">
                      <Textarea
                        rows={2}
                        autoFocus
                        value={decisionReason}
                        onChange={(e) => setDecisionReason(e.target.value)}
                        placeholder={decisionFor.intent === 'approve' ? 'Why this is OK to proceed' : 'Why this should not proceed'}
                      />
                    </Field>
                    <InlineFormActions
                      onCancel={() => { setDecisionFor(null); setDecisionReason('') }}
                      submitLabel={decisionFor.intent === 'approve' ? 'Approve' : 'Reject'}
                      submitVariant={decisionFor.intent === 'approve' ? 'default' : 'destructive'}
                      submitting={approveMutation.isPending || rejectMutation.isPending}
                    />
                  </form>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {guard.element}
    </div>
  )
}
