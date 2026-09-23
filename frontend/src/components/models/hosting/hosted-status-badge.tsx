import { cn } from '@/lib/utils'
import { hostedStatus, type HostedStatusTone } from '@/lib/model-hosting'
import type { ModelDeployment } from '@/types/deployments'

/** One colour per tone, readable in both themes. Moving states pulse. */
const TONE_CLASS: Record<HostedStatusTone, string> = {
  starting: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300',
  running: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  idle: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300',
  stopped: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
  attention: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  failed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
}

/** The running state of a model hosted on your cloud, in plain words. */
export function HostedStatusBadge({ deployment, className }: { deployment: Pick<ModelDeployment, 'state' | 'desired' | 'actual'>; className?: string }) {
  const status = hostedStatus(deployment)
  return (
    <span
      data-state={deployment.state}
      title={status.hint}
      className={cn('inline-flex items-center gap-1.5 rounded-full border border-transparent px-2 py-0.5 text-xs font-medium', TONE_CLASS[status.tone], className)}
    >
      {status.moving && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden="true" />}
      {status.label}
    </span>
  )
}
