/* Consistent empty state across list pages + detail panels.
 *
 * One component, same shape everywhere: circled icon, short
 * headline, one-sentence description, optional primary CTA
 * + optional secondary action.
 *
 * Two placements, one look:
 *
 * - `variant="panel"` is the page-level empty state. It draws its own
 *   card surface, so a page never wraps it in <Card> by hand and never
 *   leaves it floating on the page background. The Apps page did the
 *   latter while Agents did the former, and on the page background the
 *   icon badge (muted on muted) vanished -- the same component looked
 *   like two different designs side by side.
 * - `variant="inline"` (the default) sits inside a container that
 *   already has a surface: a CardContent, a table body, a popover.
 *
 * Headline wording: "No <things> yet" for a first-use empty list,
 * "No matching <things>" when filters hide rows. Action labels are
 * sentence case ("Create agent"), the same label the page header uses
 * for the same action.
 */
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

export type EmptyStateVariant = 'inline' | 'panel'

interface EmptyStateProps {
  icon?: LucideIcon
  title: string
  description?: ReactNode
  action?: ReactNode
  secondaryAction?: ReactNode
  /** `panel` for a page-level empty state; `inline` inside an existing surface. */
  variant?: EmptyStateVariant
  className?: string
}

/** The card surface a panel empty state draws; identical to <Card>. */
export const EMPTY_STATE_PANEL_CLASSES =
  'rounded-xl border bg-card text-card-foreground shadow-[0_1px_3px_0_rgb(0_0_0_/_0.04)]'

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  secondaryAction,
  variant = 'inline',
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center px-6',
        variant === 'panel' ? cn(EMPTY_STATE_PANEL_CLASSES, 'py-16') : 'py-12',
        className,
      )}
      role="status"
      data-variant={variant}
    >
      {Icon && (
        <div
          className="mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-border bg-muted"
          data-testid="empty-state-icon"
        >
          <Icon className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
        </div>
      )}
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      {description && (
        <p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p>
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
