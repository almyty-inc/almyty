/* What a render error looks like instead of a white page.
 *
 * Two mounts, one view:
 *
 * - RouteErrorView is the router's errorElement. The dashboard mounts it on
 *   a pathless route INSIDE the layout, so a page that throws is replaced by
 *   this view while the sidebar and header stay up and every other page is
 *   one click away. The router resets it on the next navigation. The root
 *   route carries a full-page copy for errors in the layout itself and in
 *   the routes outside it (auth, invite, CLI login).
 * - AppErrorFallback is for the rare error outside routing (the router or a
 *   provider above it). It cannot use router hooks, so it links with a
 *   plain anchor.
 *
 * Both report to Sentry via captureError, which is a no-op without a DSN.
 * Only the error itself is sent: no user, no org, no page state.
 */
import { useEffect, useState } from 'react'
import { Link, isRouteErrorResponse, useRouteError } from 'react-router-dom'
import { AlertTriangle, ChevronDown, ChevronRight, Home, RotateCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { captureError } from '@/lib/sentry'
import { isChunkLoadError, reloadAfterChunkError } from '@/lib/lazy-with-retry'
import { cn } from '@/lib/utils'

function describeError(error: unknown): string {
  if (isRouteErrorResponse(error)) {
    return `${error.status} ${error.statusText}`.trim()
  }
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`
  }
  try {
    return typeof error === 'string' ? error : JSON.stringify(error)
  } catch {
    return String(error)
  }
}

interface ErrorViewProps {
  error: unknown
  /** Fill the viewport (no shell around it) instead of the content area. */
  fullPage?: boolean
  /** "Go to dashboard" as a router link (soft) or a plain anchor (hard). */
  homeLink?: 'router' | 'anchor'
  /** Send the error to Sentry. Off where a boundary above already did. */
  report?: boolean
}

export function ErrorView({ error, fullPage = false, homeLink = 'router', report = true }: ErrorViewProps) {
  const [showDetails, setShowDetails] = useState(false)
  const staleChunk = isChunkLoadError(error)

  useEffect(() => {
    // A 404 from the router is not a bug worth a Sentry event.
    if (!report || isRouteErrorResponse(error)) return
    captureError(error)
  }, [error, report])

  const title = staleChunk ? 'A new version of almyty is out' : 'Something went wrong'
  const body = staleChunk
    ? 'It was released after this tab was opened, so part of this page could not load. Reload to get the new version.'
    : fullPage
      ? 'This page ran into an error and could not be shown. Reloading usually fixes it.'
      : 'This page ran into an error and could not be shown. The rest of almyty still works. Reload to try again, or pick another page.'

  const reload = () => {
    if (staleChunk) reloadAfterChunkError()
    else window.location.reload()
  }

  return (
    <div
      role="alert"
      data-testid="route-error"
      className={cn(
        'flex flex-col items-center justify-center text-center px-4',
        fullPage ? 'min-h-screen bg-background py-16' : 'py-16',
      )}
    >
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <AlertTriangle className="h-5 w-5" aria-hidden="true" />
      </div>
      <h1 className="text-lg font-semibold text-foreground">{title}</h1>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">{body}</p>

      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        <Button onClick={reload} className="gap-2">
          <RotateCw className="h-4 w-4" aria-hidden="true" />
          Reload
        </Button>
        <Button variant="outline" asChild className="gap-2">
          {homeLink === 'router' ? (
            <Link to="/dashboard">
              <Home className="h-4 w-4" aria-hidden="true" />
              Go to dashboard
            </Link>
          ) : (
            <a href="/dashboard">
              <Home className="h-4 w-4" aria-hidden="true" />
              Go to dashboard
            </a>
          )}
        </Button>
      </div>

      <div className="mt-6 w-full max-w-2xl">
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          aria-expanded={showDetails}
          onClick={() => setShowDetails((v) => !v)}
        >
          {showDetails ? (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {showDetails ? 'Hide technical details' : 'Show technical details'}
        </button>
        {showDetails && (
          <pre
            data-testid="route-error-details"
            className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted p-3 text-left font-mono text-xs text-muted-foreground"
          >
            {describeError(error)}
          </pre>
        )}
      </div>
    </div>
  )
}

/** The router's errorElement: the error thrown while rendering this route. */
export function RouteErrorView({ fullPage = false }: { fullPage?: boolean }) {
  const error = useRouteError()
  return <ErrorView error={error} fullPage={fullPage} homeLink={fullPage ? 'anchor' : 'router'} />
}

/**
 * Fallback for errors above the router, where router hooks are unavailable.
 * ErrorBoundary.componentDidCatch already reported the error to Sentry.
 */
export function AppErrorFallback({ error }: { error: unknown }) {
  return <ErrorView error={error} fullPage homeLink="anchor" report={false} />
}