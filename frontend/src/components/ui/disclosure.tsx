import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

import { cn } from '@/lib/utils'

/**
 * A bordered section that opens on a click: "Advanced" on a provider's
 * page, "More ways" under an agent's strategies. Closed unless
 * `defaultOpen`; what is inside is not rendered while closed.
 */
export function Disclosure({
  title,
  children,
  defaultOpen = false,
  className,
  bodyClassName,
}: {
  title: string
  children: ReactNode
  defaultOpen?: boolean
  className?: string
  bodyClassName?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className={cn('rounded-lg border', className)}>
      <button type="button" className="flex w-full items-center gap-1.5 px-4 py-3 text-left font-medium" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
        {title}
      </button>
      {open && <div className={cn('space-y-6 border-t px-4 py-4', bodyClassName)}>{children}</div>}
    </section>
  )
}
