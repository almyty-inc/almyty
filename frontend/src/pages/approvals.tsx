import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check } from 'lucide-react'

import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/layout/page-header'
import {
  ApprovalInspector,
  isChangeSet,
  type ApprovalRequest,
} from '@/components/approvals/approval-inspector'

import { approvalsApi } from '@/lib/api'
import { cn, formatRelativeTime, pluralized } from '@/lib/utils'

export { decisionMessage, isChangeSet, isUnknownOutcome } from '@/components/approvals/approval-inspector'

const POLL_MS = 10_000

/** Who is asking, for the queue: the agent, a deleted agent, or a held tool call. */
function requesterName(row: Pick<ApprovalRequest, 'agentId' | 'agentName'>): string {
  if (!row.agentId) return 'Tool call'
  return row.agentName || 'Deleted agent'
}

/** What is asked, in a few words, for the queue. */
function queueLine(row: Pick<ApprovalRequest, 'payload'>): string {
  if (isChangeSet(row)) return pluralized((row.payload!.changeSet as unknown[]).length, 'change')
  return typeof row.payload?.tool === 'string' ? row.payload.tool : 'A tool call'
}

export function ApprovalsPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null)

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

  const rows = (query.data ?? []) as ApprovalRequest[]
  // The request in the inspector: the one picked in the queue, else the first listed.
  const selected = rows.find((r) => r.id === selectedId) ?? rows[0]

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
        // The queue on the left (only when there is more than one), one
        // focused inspector on the right; stacked on a phone.
        <div className={cn('grid gap-4', rows.length > 1 && 'lg:grid-cols-[18rem_minmax(0,1fr)] lg:items-start')}>
          {rows.length > 1 && (
            <nav aria-label="Pending approvals" className="rounded-xl border bg-card p-1.5">
              <ul className="space-y-0.5">
                {rows.map((row) => {
                  const active = row.id === selected?.id
                  return (
                    <li key={row.id}>
                      <button
                        type="button"
                        aria-current={active ? 'true' : undefined}
                        onClick={() => setSelectedId(row.id)}
                        className={cn(
                          'flex w-full min-h-11 flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left text-sm transition-colors duration-[120ms] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          active ? 'bg-selection text-selection-foreground' : 'hover:bg-[var(--am-surface-hover)]',
                        )}
                      >
                        <span className="w-full truncate font-semibold">{requesterName(row)}</span>
                        <span className={cn('w-full truncate text-xs', active ? 'text-selection-foreground' : 'text-muted-foreground')}>
                          {queueLine(row)} · {formatRelativeTime(row.createdAt)}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </nav>
          )}
          {selected && <ApprovalInspector key={selected.id} row={selected} />}
        </div>
      )}
    </div>
  )
}