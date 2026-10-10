/* The one destructive action of a detail page: what it is, what it costs,
 * and the button. The button asks its one-line "Delete X?" confirm
 * itself; this only lays it out.
 *
 * `card` stands on its own under the page's sections (a provider
 * connection's Settings). `inline` closes the section it sits in, under a
 * hairline, so a short page has its delete next to what it deletes rather
 * than floating far below it.
 */
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

export interface DangerZoneProps {
  title: ReactNode
  description?: ReactNode
  /** The destructive button (outline, red text). */
  action: ReactNode
  variant?: 'card' | 'inline'
  testId?: string
}

export function DangerZone({ title, description, action, variant = 'card', testId = 'danger-zone' }: DangerZoneProps) {
  return (
    <section
      data-testid={testId}
      className={cn(
        'flex flex-wrap items-center justify-between gap-3',
        variant === 'card' ? 'rounded-xl border border-destructive/30 p-4' : 'border-t pt-4',
      )}
    >
      <div className="min-w-0">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {action}
    </section>
  )
}

/** The look of the destructive button in a DangerZone. */
export const DANGER_BUTTON_CLASSES = 'text-destructive hover:text-destructive'
