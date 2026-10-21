/* The bordered remove box a detail page ends with (a provider connection's
 * "Remove this connection", a credential's "Delete this credential"):
 * what goes, what it costs, and the button. The button asks its one-line
 * "Delete X?" confirm itself; this only lays it out.
 */
import type { ReactNode } from 'react'

export interface DangerZoneProps {
  title: ReactNode
  description?: ReactNode
  /** The destructive button (outline, red text). */
  action: ReactNode
  testId?: string
}

export function DangerZone({ title, description, action, testId = 'danger-zone' }: DangerZoneProps) {
  return (
    <section data-testid={testId} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/30 p-4">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {action}
    </section>
  )
}

/** The look of the destructive button in a DangerZone. */
export const DANGER_BUTTON_CLASSES = 'text-destructive hover:text-destructive'
