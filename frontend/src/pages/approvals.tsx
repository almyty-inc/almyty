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
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'

import { approvalsApi } from '@/lib/api'
import { formatRelativeTime } from '@/lib/utils'
import { useNotifications } from '@/store/app'

interface ApprovalRequest {
  id: string
  organizationId: string
  teamId: string | null
  visibility: 'org' | 'team'
  runId: string
  agentId: string
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

export function ApprovalsPage() {
  const queryClient = useQueryClient()
  const { success, error: errNotif } = useNotifications()
  const [decisionFor, setDecisionFor] = useState<{ row: ApprovalRequest; intent: 'approve' | 'reject' } | null>(null)
  const [decisionReason, setDecisionReason] = useState('')

  useEffect(() => {
    document.title = 'Approvals | almyty'
    return () => { document.title = 'almyty' }
  }, [])

  const query = useQuery<{ data: ApprovalRequest[] }>({
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
    onError: (err: any) => errNotif('Approve failed', err?.response?.data?.message ?? err?.message ?? 'Unknown'),
  })

  const rejectMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) => approvalsApi.reject(id, reason),
    onSuccess: () => {
      success('Rejected', 'The agent run was cancelled.')
      queryClient.invalidateQueries({ queryKey: ['approvals'] })
      setDecisionFor(null)
      setDecisionReason('')
    },
    onError: (err: any) => errNotif('Reject failed', err?.response?.data?.message ?? err?.message ?? 'Unknown'),
  })

  if (query.isLoading) {
    return <div className="flex justify-center py-16"><LoadingSpinner size="lg" /></div>
  }

  if (query.isError) {
    return <QueryError error={query.error} onRetry={() => query.refetch()} title="Couldn't load approvals" />
  }

  const rows = (query.data?.data ?? []) as ApprovalRequest[]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-4xl font-heading font-extrabold tracking-tight bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
          Approvals
        </h1>
        <p className="text-muted-foreground">
          Agent runs paused for human approval. {rows.length} pending.
        </p>
      </div>

      {rows.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <div className="w-16 h-16 bg-emerald-500/10 rounded-full flex items-center justify-center mb-4">
              <Check className="h-8 w-8 text-emerald-500" />
            </div>
            <h3 className="text-xl font-semibold mb-2">No pending approvals</h3>
            <p className="text-muted-foreground text-center max-w-md">
              When an agent calls the <code className="px-1 py-0.5 bg-muted rounded">request_approval</code> tool, it appears here for review.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <Card key={row.id} className="border-amber-200 dark:border-amber-900">
              <CardHeader>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Bot className="h-4 w-4 text-muted-foreground" />
                      <Link to={`/agents/${row.agentId}`} className="font-mono hover:underline truncate">
                        agent {row.agentId.slice(0, 8)}
                      </Link>
                      <Badge variant="outline" className="text-amber-600 border-amber-300 dark:border-amber-800 dark:text-amber-400">
                        <Clock className="h-3 w-3 mr-1" />
                        pending
                      </Badge>
                      {row.visibility === 'team' ? (
                        <Badge variant="outline">team</Badge>
                      ) : (
                        <Badge variant="outline">org</Badge>
                      )}
                    </CardTitle>
                    <CardDescription className="mt-2 text-foreground">{row.reason}</CardDescription>
                  </div>
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
                </div>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground space-y-1">
                <div>
                  Run: <Link to={`/agents/${row.agentId}/runs/${row.runId}`} className="font-mono hover:underline">{row.runId.slice(0, 12)}</Link>
                  {' · '}
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
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!decisionFor} onOpenChange={(o) => { if (!o) { setDecisionFor(null); setDecisionReason('') } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {decisionFor?.intent === 'approve' ? (
                <><Check className="h-5 w-5 text-emerald-500" /> Approve this action?</>
              ) : (
                <><AlertCircle className="h-5 w-5 text-red-500" /> Reject this action?</>
              )}
            </DialogTitle>
            <DialogDescription>
              {decisionFor?.intent === 'approve'
                ? 'The agent run will resume from where it paused, with this approval as the result of the request_approval tool call.'
                : 'The agent run will be cancelled. This is a terminal state — the run cannot be resumed.'}
            </DialogDescription>
          </DialogHeader>
          {decisionFor && (
            <div className="space-y-3">
              <div className="text-sm bg-muted rounded p-3">{decisionFor.row.reason}</div>
              <div>
                <label className="text-sm font-medium mb-1 block">Reason (optional)</label>
                <Textarea
                  rows={3}
                  value={decisionReason}
                  onChange={(e) => setDecisionReason(e.target.value)}
                  placeholder={decisionFor.intent === 'approve' ? 'Why this is OK to proceed' : 'Why this should not proceed'}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setDecisionFor(null); setDecisionReason('') }}>Cancel</Button>
            {decisionFor?.intent === 'approve' ? (
              <Button
                onClick={() => approveMutation.mutate({ id: decisionFor!.row.id, reason: decisionReason || undefined })}
                disabled={approveMutation.isPending}
              >
                {approveMutation.isPending ? <LoadingSpinner size="sm" className="mr-2" /> : <Check className="h-4 w-4 mr-1" />}
                Approve
              </Button>
            ) : (
              <Button
                variant="destructive"
                onClick={() => rejectMutation.mutate({ id: decisionFor!.row.id, reason: decisionReason || undefined })}
                disabled={rejectMutation.isPending}
              >
                {rejectMutation.isPending ? <LoadingSpinner size="sm" className="mr-2" /> : <X className="h-4 w-4 mr-1" />}
                Reject
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
