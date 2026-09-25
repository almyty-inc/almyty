import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

import { cn } from '@/lib/utils'

/**
 * A titled section that starts closed: "Advanced" everywhere. What a first
 * pass does not need waits in here, one click away.
 */
export function Disclosure({
  title,
  children,
  defaultOpen = false,
  className,
  testId,
}: {
  title: string
  children: ReactNode
  defaultOpen?: boolean
  className?: string
  testId?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className={cn('rounded-lg border', className)} data-testid={testId}>
      <button type="button" className="flex w-full items-center gap-1.5 px-4 py-3 text-left font-medium" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
        {title}
      </button>
      {open && <div className="space-y-6 border-t px-4 py-4">{children}</div>}
    </section>
  )
}
