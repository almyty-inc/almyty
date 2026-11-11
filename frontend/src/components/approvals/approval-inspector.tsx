/**
 * One approval request, inspected: who asks, what exactly would run and
 * with which arguments, and the decision, made inline (never in a dialog).
 * The Approvals page shows it beside its queue; a run waiting for approval
 * shows the same inspector beside its steps. Both decide through the same
 * approvalsApi handlers, and a decision is only reported once the server
 * confirms it.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Check, X, Clock, AlertCircle, Bot, ShieldCheck } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Field, InlineFormActions } from '@/components/layout/form-page'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { approvalsApi } from '@/lib/api'
import { cn, formatDateTime, formatRelativeTime, pluralized } from '@/lib/utils'
import { useNotifications } from '@/store/app'
import { getApiErrorMessage } from '@/lib/api-error'
import { emailPreviewOf } from '@/lib/email-preview'
import { actionDetailsOf, policyStepOf, withoutInternalFields } from '@/lib/approval-summary'
import { ChangeSetView } from '@/components/approvals/change-set-view'
import type { ChangeSetEntry } from '@/types'

export interface ApprovalRequest {
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
  /** The held tool's parameter schema, for its own parameter titles; absent when there is no tool. */
  parameterSchema?: Record<string, any> | null
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  decidedBy: string | null
  decidedAt: string | null
  decisionReason: string | null
  expiresAt: string | null
  createdAt: string
}

/** A script's change set (code mode): several calls approved or rejected as a whole. */
export function isChangeSet(row: Pick<ApprovalRequest, 'payload'>): boolean {
  return row.payload?.kind === 'change_set' && Array.isArray(row.payload?.changeSet)
}

/**
 * A call that was cut off when the worker running it stopped, so it may
 * already have happened, and was tried again (durable runs, unknown-writes).
 * Either way the run carries on; only what the agent is told differs.
 */
export function isUnknownOutcome(row: Pick<ApprovalRequest, 'payload'>): boolean {
  return row.payload?.kind === 'unknown_outcome'
}

/** What a decision does, in one sentence, before a person confirms it. */
export function decisionMessage(row: Pick<ApprovalRequest, 'payload'>, intent: 'approve' | 'reject'): string {
  if (isChangeSet(row)) {
    const n = (row.payload!.changeSet as unknown[]).length
    return intent === 'approve'
      ? `All ${pluralized(n, 'change')} run, in this order. If one fails, the ones after it do not run; nothing is undone.`
      : 'None of the changes run. The agent is told, and carries on without them.'
  }
  if (isUnknownOutcome(row)) {
    return intent === 'approve'
      ? 'The run carries on. Nothing is sent again; the agent is told you checked it.'
      : 'Nothing is sent again or undone. The agent is told to treat this action as not done, and carries on without it.'
  }
  return intent === 'approve'
    ? 'The run resumes where it paused, with this approval as the answer to its request.'
    : 'The run is cancelled for good; it cannot be resumed.'
}

interface ApprovalInspectorProps {
  row: ApprovalRequest
  /** Beside a run's steps: a narrower panel, and no link back to the run it sits in. */
  compact?: boolean
  className?: string
}

export function ApprovalInspector({ row, compact = false, className }: ApprovalInspectorProps) {
  const queryClient = useQueryClient()
  const { success, error: errNotif } = useNotifications()
  const [intent, setIntent] = useState<'approve' | 'reject' | null>(null)
  const [decisionReason, setDecisionReason] = useState('')
  // A written note asks before a navigation throws it away. Cancel and a
  // recorded decision both clear it, so neither asks.
  const guard = useLeaveGuard(intent !== null && decisionReason !== '')

  const decided = () => {
    queryClient.invalidateQueries({ queryKey: ['approvals'] })
    if (row.agentId) queryClient.invalidateQueries({ queryKey: ['agent-runs', row.agentId] })
    setIntent(null)
    setDecisionReason('')
  }
  const approveMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) => approvalsApi.approve(id, reason),
    onSuccess: () => {
      success('Approved', 'The agent run will resume.')
      decided()
    },
    onError: (err: any) => errNotif('Approve failed', getApiErrorMessage(err, 'Unknown')),
  })
  const rejectMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) => approvalsApi.reject(id, reason),
    onSuccess: () => {
      success('Rejected', 'The agent run was cancelled.')
      decided()
    },
    onError: (err: any) => errNotif('Reject failed', getApiErrorMessage(err, 'Unknown')),
  })

  return (
    <section
      aria-label="Review the action"
      className={cn('relative overflow-hidden rounded-xl border bg-card shadow-panel', compact ? 'p-4' : 'p-5 sm:p-6', className)}
    >
      {/* A short accent strip: the one place the gradient appears here. */}
      <span aria-hidden className="absolute inset-x-5 top-0 h-[3px] rounded-b bg-accent-gradient" />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
            <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
            Review the action
          </p>
          {!compact && (
            <h2 className="flex min-w-0 items-center gap-2 font-heading text-xl font-semibold tracking-[-0.02em]">
              <Bot className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
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
            </h2>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="warning">
            <Clock className="h-3.5 w-3.5" aria-hidden="true" />
            Pending
          </Badge>
          <Badge variant="outline">{row.visibility === 'private' ? 'private' : row.visibility === 'team' ? 'team' : 'org'}</Badge>
        </div>
      </div>

      <p className={cn('mt-4 text-foreground', compact ? 'text-sm' : 'text-base')}>{row.reason}</p>
      {row.payload?.tool && (row.agentId || compact) && (
        <p className="mt-2 font-mono text-[0.8125rem] font-semibold text-selection-foreground [overflow-wrap:anywhere]">{row.payload.tool}</p>
      )}

      <div className="mt-4 space-y-3 text-sm">
        {isChangeSet(row) && <ChangeSetView entries={row.payload!.changeSet as ChangeSetEntry[]} />}
        {(() => {
          // A multi-step policy: which step it is on, said from the
          // server's score, never the raw `_policy` bookkeeping.
          const step = policyStepOf(row.payload)
          if (!step) return null
          return (
            <p className="text-sm font-medium text-foreground" data-testid="approval-policy-step">
              {step}
            </p>
          )
        })()}
        {(() => {
          const email = emailPreviewOf(row.payload)
          if (email) return (
            <div className="rounded-lg border bg-surround p-4 text-sm text-foreground" data-testid="approval-email-preview">
              <p className="text-xs font-semibold text-muted-foreground">The email it will send</p>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
                <dt className="text-muted-foreground">To</dt>
                <dd className="break-all">{email.to || '(nobody)'}</dd>
                {email.cc && (
                  <>
                    <dt className="text-muted-foreground">Cc</dt>
                    <dd className="break-all">{email.cc}</dd>
                  </>
                )}
                <dt className="text-muted-foreground">Subject</dt>
                <dd>{email.subject || '(no subject)'}</dd>
              </dl>
              <p className="mt-3 whitespace-pre-wrap">{email.body}</p>
            </div>
          )
          if (isChangeSet(row)) return null
          // Any other call: its arguments, in words, one per row.
          const details = actionDetailsOf(row.payload, row.parameterSchema)
          if (details.length === 0) return null
          return (
            <div className="text-sm text-foreground" data-testid="approval-action-preview">
              <p className="text-xs font-semibold text-muted-foreground">What it will do</p>
              <dl className="mt-1 divide-y border-y">
                {details.map((d) => (
                  <div key={d.label} className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-2.5">
                    <dt className="text-muted-foreground">{d.label}</dt>
                    <dd className="min-w-0 whitespace-pre-wrap break-words text-right font-mono text-[0.8125rem]">{d.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )
        })()}
        {(() => {
          // Internal fields (`_gate`: the rule, the fingerprint, who called) are the server's, never the approver's.
          const visible = withoutInternalFields(row.payload) as Record<string, unknown> | null
          if (!visible || Object.keys(visible).length === 0) return null
          return (
            <details>
              <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">Show details</summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-code p-3 font-mono text-[0.8125rem] leading-[1.375rem] text-code-foreground">
                {JSON.stringify(visible, null, 2)}
              </pre>
            </details>
          )
        })()}
      </div>

      {intent ? (
        <form
          className="mt-5 space-y-3 rounded-lg border bg-surround p-4 text-sm text-foreground"
          aria-label={intent === 'approve' ? 'Approve this action' : 'Reject this action'}
          onSubmit={(e) => {
            e.preventDefault()
            const args = { id: row.id, reason: decisionReason.trim() || undefined }
            if (intent === 'approve') approveMutation.mutate(args)
            else rejectMutation.mutate(args)
          }}
        >
          <p className="flex items-start gap-2">
            {intent === 'approve' ? (
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
            ) : (
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
            )}
            {decisionMessage(row, intent)}
          </p>
          <Field id={`decision-reason-${row.id}`} label="Note (optional)" hint="Saved with the decision.">
            <Textarea
              rows={2}
              autoFocus
              value={decisionReason}
              onChange={(e) => setDecisionReason(e.target.value)}
              placeholder={intent === 'approve' ? 'Why this is OK to proceed' : 'Why this should not proceed'}
            />
          </Field>
          <InlineFormActions
            onCancel={() => { setIntent(null); setDecisionReason('') }}
            submitLabel={intent === 'approve' ? 'Approve' : 'Reject'}
            submitVariant={intent === 'approve' ? 'default' : 'destructive'}
            submitting={approveMutation.isPending || rejectMutation.isPending}
          />
        </form>
      ) : (
        <div className="mt-5 flex flex-wrap gap-2">
          <Button className="flex-1 sm:flex-none" onClick={() => { setIntent('approve'); setDecisionReason('') }}>
            <Check className="h-4 w-4 mr-1.5" aria-hidden="true" /> Approve
          </Button>
          <Button
            variant="outline"
            className="flex-1 sm:flex-none text-danger"
            onClick={() => { setIntent('reject'); setDecisionReason('') }}
          >
            <X className="h-4 w-4 mr-1.5" aria-hidden="true" /> Reject
          </Button>
        </div>
      )}

      <p className="mt-4 border-t pt-3 text-xs text-muted-foreground">
        {row.runId && !compact ? (
          <>
            Run:{' '}
            <Link to={`/agents/${row.agentId}/runs/${row.runId}`} className="font-mono hover:underline">
              {row.runId.slice(0, 12)}
            </Link>
            {' · '}
          </>
        ) : !row.runId ? (
          // A held tool call: it runs, exactly as asked, once approved.
          <>The call runs once approved · </>
        ) : null}
        requested <time dateTime={row.createdAt} title={formatDateTime(row.createdAt)}>{formatRelativeTime(row.createdAt)}</time>
        {row.expiresAt && (
          <> · expires {formatRelativeTime(row.expiresAt)}</>
        )}
      </p>
      {guard.element}
    </section>
  )
}

/**
 * Beside a run that waits for a person: the pending request that holds it,
 * from the same approvals list the Approvals page reads. Nothing when the
 * run holds none (already decided, or not visible to this user).
 */
export function RunApproval({ runId, className }: { runId: string; className?: string }) {
  const query = useQuery<ApprovalRequest[]>({
    queryKey: ['approvals'],
    queryFn: () => approvalsApi.list(),
  })
  const row = (query.data ?? []).find((r) => r.runId === runId && r.status === 'pending')
  if (!row) return null
  return <ApprovalInspector row={row} compact className={className} />
}
