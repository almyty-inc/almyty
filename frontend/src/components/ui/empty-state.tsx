/* Consistent empty state across list pages + detail panels.
 *
 * One component, same shape everywhere: circled icon, short
 * headline, one-sentence description, optional primary CTA
 * + optional secondary action. Replaces the grab-bag of
 * "No results.", "No X found", ad-hoc dashed-border boxes,
 * and <LoadingSpinner> that a few pages were using when empty.
 */
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

interface EmptyStateProps {
  icon?: LucideIcon
  title: string
  description?: ReactNode
  action?: ReactNode
  secondaryAction?: ReactNode
  className?: string
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  secondaryAction,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center px-6 py-12',
        className,
      )}
      role="status"
    >
      {Icon && (
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-border/60 bg-muted/40">
          <Icon className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
        </div>
      )}
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      {description && (
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      )}
      {(action || secondaryAction) && (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  )
}
