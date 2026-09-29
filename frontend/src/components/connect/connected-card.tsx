import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { Skeleton } from '@/components/ui/skeleton'
import { ServiceIcon } from './service-tiles'

/**
 * What is connected, as cards: a logo, the name, and one line under it
 * (whether the key works, and whatever else the page counts). Each card
 * opens the thing's own page. Models lists providers this way, Connections
 * lists services.
 */
export function ConnectedCardGrid({ children, loading, label }: { children?: ReactNode; loading?: boolean; label?: string }) {
  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    )
  }
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label={label}>
      {children}
    </ul>
  )
}

export function ConnectedCard({ to, icon, name, testId, children }: { to: string; icon: ReactNode; name: string; testId?: string; children?: ReactNode }) {
  return (
    <li>
      <Link to={to} data-testid={testId} className="flex items-center gap-3 rounded-xl border bg-card p-4 transition-colors hover:border-primary/50 hover:bg-muted/40">
        <ServiceIcon size="md">{icon}</ServiceIcon>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{name}</span>
          <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">{children}</span>
        </span>
      </Link>
    </li>
  )
}
