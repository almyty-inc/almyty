import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

import { cn } from '@/lib/utils'

/**
 * A bordered section that opens on a click: "Advanced" on a provider's
 * page, "More ways" under an agent's strategies. Closed unless
 * `defaultOpen`; what is inside is not rendered while closed. `summary`
 * is one line of what the defaults are, shown while it is closed, so
 * nobody has to open it to know what they would find.
 */
export function Disclosure({
  title,
  summary,
  children,
  defaultOpen = false,
  className,
  bodyClassName,
}: {
  title: string
  summary?: ReactNode
  children: ReactNode
  defaultOpen?: boolean
  className?: string
  bodyClassName?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className={cn('rounded-lg border', className)}>
      <button type="button" className="flex w-full items-center gap-1.5 px-4 py-3 text-left font-medium" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown className="h-4 w-4 shrink-0" aria-hidden /> : <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />}
        {title}
        {summary && !open && <span className="ml-2 min-w-0 truncate text-sm font-normal text-muted-foreground">{summary}</span>}
      </button>
      {open && <div className={cn('space-y-6 border-t px-4 py-4', bodyClassName)}>{children}</div>}
    </section>
  )
}
