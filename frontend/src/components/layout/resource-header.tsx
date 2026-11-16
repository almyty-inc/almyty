/**
 * The header of a page about one thing in the workspace (an API, a tool),
 * laid out like the agent page's: a breadcrumb with the way back, then the
 * name with its state beside it, one line under it, and the page's actions
 * on the right. Actions wrap under the name on a phone.
 *
 * DetailHeader is the connection/credential variant (logo tile, facts
 * line); this one is for the things a person builds.
 */
import type { ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, ChevronRight } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { DETAIL_TITLE_CLASSES } from '@/components/layout/page-header'

export interface ResourceHeaderProps {
  /** The list it belongs to: the breadcrumb's first step and the back button. */
  back: { to: string; label: string }
  title: string
  /** Badges beside the name: its state first, then what kind of thing it is. */
  badges?: ReactNode
  /** One line under the name (an address, a description). */
  subtitle?: ReactNode
  /** Buttons on the right; outline, at most one primary. */
  actions?: ReactNode
  /** Names the actions group for assistive tech ("API actions"). */
  actionsLabel?: string
}

export function ResourceHeader({ back, title, badges, subtitle, actions, actionsLabel }: ResourceHeaderProps) {
  const navigate = useNavigate()
  return (
    <>
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
        <Button
          variant="ghost"
          size="icon"
          className="-ml-2 h-8 w-8 shrink-0"
          aria-label={`Back to ${back.label}`}
          onClick={() => navigate(back.to)}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Link to={back.to} className="shrink-0 hover:text-foreground">
          {back.label}
        </Link>
        <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 text-foreground [overflow-wrap:anywhere]">{title}</span>
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1 basis-80">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className={`${DETAIL_TITLE_CLASSES} [overflow-wrap:anywhere]`}>{title}</h1>
            {badges}
          </div>
          {subtitle && <div className="mt-1.5 max-w-[65ch] text-base text-muted-foreground [overflow-wrap:anywhere]">{subtitle}</div>}
        </div>
        {actions && (
          <div role="group" aria-label={actionsLabel} className="flex max-w-full flex-wrap items-center gap-2">
            {actions}
          </div>
        )}
      </header>
    </>
  )
}
