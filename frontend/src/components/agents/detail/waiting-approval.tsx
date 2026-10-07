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
/** A run's status as a person reads it: "waiting for approval", "waiting input", "completed". */
export function runStatusLabel(status: string): string {
  return status === WAITING_APPROVAL ? 'waiting for approval' : status.replace('_', ' ')
}

/** At the top of the agent's page when its latest run waits for a person. */
export function WaitingApprovalBanner({ run }: { run: { error?: string | null } }) {
  return (
    <div role="status" className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
      <Clock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <p>
        <span className="font-medium">{waitingLine(run)}</span>{' '}
        <Link className="underline" to="/approvals">
          Open approvals
        </Link>
      </p>
    </div>
  )
}

/** Under a run's status in Recent runs. */
export function WaitingApprovalNote({ run }: { run: { status: string; error?: string | null } }) {
  if (run.status !== WAITING_APPROVAL) return null
  return (
    <p className="mt-1 max-w-[260px] text-xs text-amber-600 dark:text-amber-400">
      {waitingLine(run)}{' '}
      <Link className="underline" to="/approvals">
        Open approvals
      </Link>
    </p>
  )
}
