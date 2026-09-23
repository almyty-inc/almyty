import { Link } from 'react-router-dom'
import { Check, X } from 'lucide-react'

import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { OnboardingState } from '@/lib/api'
import { ALL_STEPS, journeyProgress, nextStep, stepsDone } from './guide-steps'
import { NextStep } from './next-step'

export interface GuideCardProps {
  state: OnboardingState
  onDismiss?: () => void
}

/**
 * The dashboard's way into the guide: the one step to do next, how far
 * each job has got, and a link to the whole guide. It is not the guide
 * itself -- that lives at /guide and stays reachable after this card is
 * dismissed.
 */
export function GuideCard({ state, onDismiss }: GuideCardProps) {
  const next = nextStep(state)
  const done = stepsDone(state)
  const total = ALL_STEPS.length

  return (
    <Card className="border-t-2 border-t-violet-500/20" data-testid="guide-card">
      <CardContent className="space-y-4 pt-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-heading text-lg font-semibold">Guide</h2>
            <p className="text-sm text-muted-foreground">
              {done} of {total} steps done across the platform.{' '}
              <Link
                to="/guide"
                className="font-medium text-violet-600 hover:underline dark:text-violet-400"
                data-testid="guide-card-open"
              >
                Open the guide
              </Link>
            </p>
          </div>
          {onDismiss && (
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0"
              aria-label="Hide the guide from the dashboard"
              onClick={onDismiss}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>

        {next && <NextStep journey={next.journey} step={next.step} state={state} />}

        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4" aria-label="Progress by job">
          {journeyProgress(state).map(({ journey, done: d, total: t, complete }) => (
            <li key={journey.id}>
              <Link
                to="/guide"
                className={cn(
                  'flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm transition-colors hover:border-primary hover:bg-primary/5',
                  complete && 'text-muted-foreground',
                )}
              >
                <span className="min-w-0 truncate">{journey.title}</span>
                {complete ? (
                  <Check className="h-4 w-4 shrink-0 text-green-600 dark:text-green-400" aria-label="Done" />
                ) : (
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {d}/{t}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
