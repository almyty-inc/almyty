import { cn } from '@/lib/utils'
import type { ModelDeploymentState } from '@/types/deployments'

/** One colour per state, readable in both themes. Moving states pulse. */
const STATE_STYLES: Record<ModelDeploymentState, { className: string; label: string; moving?: boolean }> = {
  pending: { className: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300', label: 'pending', moving: true },
  deploying: { className: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300', label: 'deploying', moving: true },
  ready: { className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400', label: 'ready' },
  degraded: { className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400', label: 'degraded' },
  scaling: { className: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300', label: 'scaling', moving: true },
  tearing_down: { className: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300', label: 'tearing down', moving: true },
  orphaned: { className: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300', label: 'orphaned' },
  torn_down: { className: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400', label: 'torn down' },
  failed: { className: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300', label: 'failed' },
}

export function deploymentStateLabel(state: ModelDeploymentState): string {
  return STATE_STYLES[state]?.label ?? state
}

export function DeploymentStateBadge({ state, className }: { state: ModelDeploymentState; className?: string }) {
  const style = STATE_STYLES[state] ?? STATE_STYLES.pending
  return (
    <span
      data-state={state}
      className={cn('inline-flex items-center gap-1.5 rounded-full border border-transparent px-2 py-0.5 text-xs font-medium', style.className, className)}
    >
      {style.moving && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden="true" />}
      {style.label}
    </span>
  )
}
