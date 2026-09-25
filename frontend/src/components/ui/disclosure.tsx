import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

/**
 * A section that stays closed until someone wants it: "Advanced" on a
 * provider's page and on connecting an API. Everything a first try does
 * not need goes in here.
 */
export function Disclosure({ title, children, defaultOpen = false }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="rounded-lg border">
      <button type="button" className="flex w-full items-center gap-1.5 px-4 py-3 text-left font-medium" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
        {title}
      </button>
      {open && <div className="space-y-6 border-t px-4 py-4">{children}</div>}
    </section>
  )
}
