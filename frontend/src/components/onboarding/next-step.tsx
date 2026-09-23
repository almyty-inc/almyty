import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { OnboardingState } from '@/lib/api'
import type { GuideStep, Journey } from './guide-steps'

/** The page's one gradient CTA (brand rule: at most one per page). */
export const GRADIENT_CTA_CLASSES =
  'bg-gradient-to-r from-violet-600 to-cyan-600 text-white hover:opacity-90 dark:from-violet-500 dark:to-cyan-500'

interface NextStepProps {
  journey: Journey
  step: GuideStep
  state: OnboardingState
  className?: string
}

/**
 * "Do this next": the step, what it does, where the button goes, and
 * the button. Used at the top of the guide and on the dashboard card, so
 * both say the same thing about the same step.
 */
export function NextStep({ journey, step, state, className }: NextStepProps) {
  const target = step.target(state)
  return (
    <div
      className={cn('flex flex-col gap-3 sm:flex-row sm:items-center', className)}
      data-testid="next-step"
    >
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium uppercase tracking-wide text-violet-600 dark:text-violet-400">
          Next · {journey.title}
        </p>
        <p className="mt-0.5 font-medium">{step.title}</p>
        <p className="text-sm text-muted-foreground">{step.description(state)}</p>
        <p className="mt-1 text-xs text-muted-foreground" data-testid="next-step-place">
          Opens {target.place}
        </p>
      </div>
      <Button asChild className={cn('shrink-0 self-start sm:self-center', GRADIENT_CTA_CLASSES)}>
        <Link to={target.to} data-testid="next-step-link">
          {step.cta}
          <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
        </Link>
      </Button>
    </div>
  )
}
