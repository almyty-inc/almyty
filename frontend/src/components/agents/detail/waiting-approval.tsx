/**
 * A run that waits for a person in Approvals: a workflow Code step whose
 * changes need approving, or an autonomous run that asked. Not a failure,
 * so it is said in amber, in plain words, with the way to Approvals.
 * The run carries on (or ends, if they reject) once somebody decides.
 */
import { Link } from 'react-router-dom'
import { Clock } from 'lucide-react'

import { waitingLine } from '@/lib/agent-run'

export { waitingLine }

export const WAITING_APPROVAL = 'waiting_approval'

/** At the top of the agent's page when its latest run waits for a person. */
export function WaitingApprovalBanner({ run }: { run: { error?: string | null } }) {
  return (
    <div role="status" className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-subtle p-3 text-sm text-foreground">
      <Clock className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      <p>
        <span className="font-medium">{waitingLine(run)}</span>{' '}
        <Link className="underline" to="/approvals">
          Open approvals
        </Link>
      </p>
    </div>
  )
}

/**
 * Under a run's status in Recent runs: that it waits for a person, or,
 * once they said no, the plain outcome ("Rejected. None of the 3 changes ran.").
 */
export function WaitingApprovalNote({ run }: { run: { status: string; error?: string | null } }) {
  const said = typeof run.error === 'string' ? run.error.trim() : ''
  if (run.status === 'cancelled' && /^(Rejected|Nobody approved in time)\b/.test(said)) {
    return <p className="mt-1 max-w-[260px] text-xs text-muted-foreground">{said}</p>
  }
  if (run.status !== WAITING_APPROVAL) return null
  return (
    <p className="mt-1 max-w-[260px] text-xs text-warning">
      {waitingLine(run)}{' '}
      <Link className="underline" to="/approvals">
        Open approvals
      </Link>
    </p>
  )
}