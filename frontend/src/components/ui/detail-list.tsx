/* Facts about one thing, one per row: a label, its value, and the one
 * thing you can do about it ("Replace key", "Change") right after it.
 *
 * A definition list, so a screen reader reads each label with its value.
 * Rows are divided by a hairline inside whatever section holds them
 * (FormSection on a detail page). A row's `children` open under it, full
 * width, when its action expands in place (a key being replaced) -- never
 * in a dialog.
 */
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

export function DetailList({ children, className, testId }: { children: ReactNode; className?: string; testId?: string }) {
  return (
    <dl className={cn('divide-y text-sm', className)} data-testid={testId}>
      {children}
    </dl>
  )
}

export interface DetailItemProps {
  label: ReactNode
  /** The value. Long values (a URL) wrap rather than widen the page. */
  value: ReactNode
  /** One action for this row (a text button or link), after the value: "Stored encrypted · Replace key", as "Who can use it" reads everywhere. */
  action?: ReactNode
  /** What opens under the row when its action expands in place. */
  children?: ReactNode
  testId?: string
}

export function DetailItem({ label, value, action, children, testId }: DetailItemProps) {
  return (
    <div className="py-3 first:pt-0 last:pb-0" data-testid={testId}>
      <div className="grid gap-1 sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-baseline sm:gap-4">
        <dt className="text-muted-foreground">{label}</dt>
        <dd className="min-w-0 [overflow-wrap:anywhere]">
          {value}
          {action && (
            <>
              {' · '}
              {action}
            </>
          )}
        </dd>
      </div>
      {children && <div className="mt-3">{children}</div>}
    </div>
  )
}