/* Consistent error state for React Query `isError` branches.
 *
 * Before this component, half the list pages rendered a toast
 * in `onError` but then left the page body empty — the user
 * would see the toast for 10 seconds and then have no idea
 * whether they could retry or whether the whole page was
 * broken. QueryError is what the page body renders in the
 * `isError` branch: an icon, a short message, and a retry
 * button wired to React Query's `refetch`.
 */
import { AlertTriangle, ArrowLeft, RotateCw, SearchX } from 'lucide-react'
import { Link } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { cn } from '@/lib/utils'
import { getApiErrorMessage } from '@/lib/api-error'

interface NotFoundStateProps {
  /** What was asked for, lower case: "agent", "API", "tool". */
  thing: string
  /** Where "back" goes, and what it is called: "/agents", "Back to agents". */
  backTo: string
  backLabel: string
  className?: string
}

/**
 * A detail page whose object does not exist, or is not in this org. Not an
 * error with "Try again": asking again gets the same answer. It says so and
 * offers the way back to the list.
 */
export function NotFoundState({ thing, backTo, backLabel, className }: NotFoundStateProps) {
  const title = `${thing.charAt(0).toUpperCase()}${thing.slice(1)} not found`
  return (
    <EmptyState
      variant="panel"
      icon={SearchX}
      title={title}
      description={`This ${thing} does not exist, was deleted, or belongs to another organization.`}
      className={className}
      action={
        <Button variant="outline" asChild>
          <Link to={backTo}>
            <ArrowLeft className="h-4 w-4 mr-2" aria-hidden="true" />
            {backLabel}
          </Link>
        </Button>
      }
    />
  )
}

interface QueryErrorProps {
  /** Usually `query.error` from React Query. */
  error: unknown
  /** Usually `query.refetch` from React Query. */
  onRetry?: () => void
  /** Optional custom title. */
  title?: string
  /** Shown below the title. Overrides the parsed error message if set. */
  description?: string
  className?: string
}

function parseErrorMessage(error: unknown): string {
  if (!error) return 'An unexpected error occurred.'
  // The backend wraps every error as { error: { code, message, ... } };
  // this used to read the flat `response.data.message`, which that shape
  // never carries, so every page's error state showed axios's own
  // "Request failed with status code 4xx" instead of the reason.
  return getApiErrorMessage(error, 'An unexpected error occurred.')
}

export function QueryError({
  error,
  onRetry,
  title = "We couldn't load this",
  description,
  className,
}: QueryErrorProps) {
  const body = description ?? parseErrorMessage(error)
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center text-center px-6 py-12 rounded-md border border-destructive/30 bg-destructive/5',
        className,
      )}
    >
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <AlertTriangle className="h-5 w-5" aria-hidden="true" />
      </div>
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">{body}</p>
      {onRetry && (
        <Button variant="outline" size="sm" className="mt-4 gap-2" onClick={onRetry}>
          <RotateCw className="h-4 w-4" aria-hidden="true" />
          Try again
        </Button>
      )}
    </div>
  )
}
