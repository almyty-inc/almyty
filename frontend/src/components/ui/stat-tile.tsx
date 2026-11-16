/**
 * One number (or one short value) with its label, as the agent page's stat
 * row shows them: icon and label on top, the value large under it, an
 * optional action or hint below. A row of these replaces the old
 * label/value cards on the API and tool pages.
 */
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'

interface StatTileProps {
  icon: LucideIcon
  label: string
  /** The value; a number is shown large, anything else as given. */
  value: ReactNode
  /** A link or a short line under the value. */
  footer?: ReactNode
  testId?: string
  className?: string
}

export function StatTile({ icon: Icon, label, value, footer, testId, className }: StatTileProps) {
  return (
    <Card className={cn('min-w-0', className)} data-testid={testId}>
      <CardContent className="pb-4 pt-4">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
          <span className="text-sm text-muted-foreground">{label}</span>
        </div>
        <div className="mt-1 min-w-0 text-2xl font-bold tabular-nums [overflow-wrap:anywhere]">{value}</div>
        {footer && <div className="mt-1 text-xs text-muted-foreground">{footer}</div>}
      </CardContent>
    </Card>
  )
}
