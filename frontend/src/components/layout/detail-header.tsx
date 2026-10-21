/* The header a detail page (one connection, one credential) opens with.
 *
 * Back link, the thing's logo, its name, one line of facts under the name
 * (what it is, whether it works, a short detail), the page's actions on
 * the right, and -- only when something is wrong -- one short line saying
 * what. It is the provider connection page's header, lifted out so a
 * credential reads the same: same back link, same logo tile, same title
 * size, same status label.
 *
 * The title is solid (DETAIL_TITLE_CLASSES), never the gradient that marks
 * a top-level section. Actions stack under the title on phones.
 */
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'

import { ServiceIcon } from '@/components/connect/service-tiles'
import { DETAIL_TITLE_CLASSES } from '@/components/layout/page-header'
import { cn } from '@/lib/utils'

export interface DetailHeaderProps {
  /** Where "back" goes and what it is called ("Credentials"). */
  back: { to: string; label: string }
  /** The logo, drawn in the shared service tile. */
  icon?: ReactNode
  /** The name; a string becomes the page's h1, anything else (an editable name) renders as given. */
  title: ReactNode
  /** Facts under the name, in order: what it is, its status label, a short detail. Empty ones are skipped. */
  meta?: ReactNode[]
  /** Buttons on the right; outline, at most one primary. */
  actions?: ReactNode
  /** One short line under the name when something is wrong; nothing otherwise. */
  problem?: ReactNode
  /** Test id of the problem line. */
  problemTestId?: string
}

/** The back link alone, for a page's loading, error and not-found states. */
export function DetailBackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-4 w-4" aria-hidden />
      {label}
    </Link>
  )
}

export function DetailHeader({ back, icon, title, meta, actions, problem, problemTestId = 'detail-problem' }: DetailHeaderProps) {
  const facts = (meta ?? []).filter((m) => m !== null && m !== undefined && m !== false && m !== '')
  return (
    <>
      <DetailBackLink {...back} />
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          {icon && <ServiceIcon size="lg">{icon}</ServiceIcon>}
          <div className="min-w-0 space-y-1">
            {typeof title === 'string' ? <h1 className={cn(DETAIL_TITLE_CLASSES, 'truncate')}>{title}</h1> : title}
            {facts.length > 0 && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                {facts.map((fact, i) => (
                  <span key={i} className="inline-flex items-center">
                    {fact}
                  </span>
                ))}
              </div>
            )}
            {problem && (
              <p className="break-words text-sm text-destructive" data-testid={problemTestId}>
                {problem}
              </p>
            )}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2 sm:shrink-0">{actions}</div>}
      </header>
    </>
  )
}
