/* The header every top-level dashboard page opens with.
 *
 * Title, one line under it, and the page's actions on the right. Sixteen
 * pages hand-wrote this block and drifted: `items-center` on some and
 * `items-start` on others, a `text-sm` subtitle on one, no wrapping on
 * most -- so at phone width the actions either squeezed the title into
 * three lines or ran off the edge of the screen.
 *
 * Here the actions stack under the title below `sm` and sit to its
 * right above it, and wrap instead of overflowing.
 *
 * `description` is either a count line ("3 agents · 1 active": list
 * pages) or one sentence saying what the page is for (pages with no
 * single list). The primary action is the last one and is the only
 * solid primary button in the header; the others are `outline`.
 */
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

interface PageHeaderProps {
  title: ReactNode
  description?: ReactNode
  /** Buttons for the page; secondary first, the primary action last. */
  actions?: ReactNode
  className?: string
}

/**
 * The app page title: 28px/36px bold with tight tracking (design system
 * "App page title"), solid text. Gradients are accents, never a heading.
 */
export const PAGE_TITLE_CLASSES =
  'text-2xl sm:text-[1.75rem] sm:leading-9 font-heading font-bold tracking-[-0.03em] text-foreground [overflow-wrap:anywhere]'

/**
 * The title of a detail page (one API, tool, gateway, agent, app, workspace).
 * The same scale as a page title, one size step down on phones, and
 * wrapping long names instead of pushing the page sideways.
 */
export const DETAIL_TITLE_CLASSES =
  'min-w-0 text-2xl sm:text-[1.75rem] sm:leading-9 font-heading font-bold tracking-[-0.03em] [overflow-wrap:anywhere]'
export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <div
      className={cn(
        'flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between',
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className={PAGE_TITLE_CLASSES}>{title}</h1>
        {description && <p className="mt-1.5 text-sm text-muted-foreground sm:text-base">{description}</p>}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">
          {actions}
        </div>
      )}
    </div>
  )
}
