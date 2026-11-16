import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { OnboardingState } from '@/lib/api'
import type { GuideStep, Journey } from './guide-steps'

interface NextStepProps {
  journey: Journey
  step: GuideStep
  state: OnboardingState
  className?: string
}

/**
 * "Do this next": the step, what it does, where the button goes, and
 * the button. Used at the top of the guide and on the dashboard card, so
 * both say the same thing about the same step. The button is the page's
 * one solid primary action; design system v1 keeps gradients off buttons.
 */
export function NextStep({ journey, step, state, className }: NextStepProps) {
  const target = step.target(state)
  return (
    <div
      className={cn('flex flex-col gap-3 sm:flex-row sm:items-center', className)}
      data-testid="next-step"
    >
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-selection-foreground">
          Next · {journey.title}
        </p>
        <p className="mt-0.5 font-medium">{step.title}</p>
        <p className="text-sm text-muted-foreground">{step.description(state)}</p>
        <p className="mt-1 text-xs text-muted-foreground" data-testid="next-step-place">
          Opens {target.place}
        </p>
      </div>
      <Button asChild className="shrink-0 self-start sm:self-center">
        <Link to={target.to} data-testid="next-step-link">
          {step.cta}
          <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
        </Link>
      </Button>
    </div>
  )
}
