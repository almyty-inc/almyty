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
import { AlertTriangle, RotateCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

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
  // Axios errors surface the backend message at `response.data.message`.
  // Native Errors have `.message`. Fall through to String coercion.
  if (typeof error === 'object' && error !== null) {
    const anyErr = error as Record<string, any>
    if (anyErr.response?.data?.message) return String(anyErr.response.data.message)
    if (anyErr.message) return String(anyErr.message)
  }
  return String(error)
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
