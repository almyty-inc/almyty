import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { BuilderIssue } from './validate-graph'

interface NextStepsBarProps {
  issues: BuilderIssue[]
  /** Once the user has touched a field or pressed Save, the steps are errors. */
  asErrors: boolean
  onGoTo: (issue: BuilderIssue) => void
}

/**
 * What is left before the agent can be saved, on one line under the toolbar.
 *
 * It used to be a block of its own (icon, heading, bulleted list) that pushed
 * the canvas down and read as a stray panel. One line, in the toolbar's own
 * padding: on an untouched draft it is a hint, once the user has been in a
 * field or pressed Save the same items are errors. Items that point at a
 * step select it on the canvas.
 */
export function NextStepsBar({ issues, asErrors, onGoTo }: NextStepsBarProps) {
  if (issues.length === 0) return null
  return (
    <div
      data-testid={asErrors ? 'builder-validation-errors' : 'builder-next-steps'}
      role={asErrors ? 'alert' : undefined}
      className={cn(
        'flex items-center gap-2 px-2 sm:px-4 py-1.5 border-b text-xs shrink-0 min-w-0',
        asErrors ? 'bg-destructive/10 border-destructive/20 text-destructive' : 'bg-background text-muted-foreground',
      )}
    >
      {asErrors && <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
      <span className={cn('font-medium shrink-0', asErrors ? 'text-destructive' : 'text-foreground')}>
        To finish:
      </span>
      <ul className="flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0 max-h-12 overflow-y-auto">
        {issues.map((issue, i) => (
          <li key={i} className="flex items-center gap-2">
            {i > 0 && <span aria-hidden="true">·</span>}
            {issue.nodeIds.length ? (
              <button
                type="button"
                onClick={() => onGoTo(issue)}
                className="text-left underline underline-offset-2 decoration-dotted hover:decoration-solid"
              >
                {issue.text}
              </button>
            ) : (
              <span>{issue.text}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
