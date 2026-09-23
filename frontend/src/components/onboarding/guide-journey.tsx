import { Link } from 'react-router-dom'
import { ArrowRight, Check, Copy } from 'lucide-react'

import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useCopy } from '@/lib/clipboard'
import { connectCommandFor } from '@/lib/gateway-connect'
import type { OnboardingState } from '@/lib/api'
import type { GuideStep, Journey } from './guide-steps'

interface GuideJourneyProps {
  journey: Journey
  state: OnboardingState
  orgSlug: string
  /** The step the guide suggests next, highlighted wherever it appears. */
  nextKey?: string
}

/**
 * One job on the guide page: its steps in order, each with what to do,
 * whether it is done (from the server's reading of the org), and a
 * button that says where it goes.
 */
export function GuideJourney({ journey, state, orgSlug, nextKey }: GuideJourneyProps) {
  const done = journey.steps.filter((s) => state.steps[s.key]).length
  const total = journey.steps.length
  const Icon = journey.icon
  const more = journey.more?.(state) ?? []

  return (
    <Card data-testid={`journey-${journey.id}`} className="border-t-2 border-t-violet-500/20">
      <CardHeader className="pb-3">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
            <Icon className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <h2 className="font-heading text-lg font-semibold">{journey.title}</h2>
              <span className="text-xs tabular-nums text-muted-foreground">
                {done === total ? 'Done' : `${done} of ${total} done`}
              </span>
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">{journey.summary}</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <ol className="space-y-2">
          {journey.steps.map((step, i) => (
            <GuideStepRow
              key={step.key}
              step={step}
              index={i + 1}
              state={state}
              orgSlug={orgSlug}
              isNext={step.key === nextKey}
            />
          ))}
        </ol>
        {more.length > 0 && (
          <div className="border-t pt-3">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              When you want more
            </p>
            <ul className="space-y-2">
              {more.map((link) => (
                <li key={link.title}>
                  <Link
                    to={link.to}
                    className="group flex items-start gap-2 rounded-md p-2 text-sm hover:bg-accent"
                  >
                    <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden="true" />
                    <span className="min-w-0">
                      <span className="font-medium">{link.title}</span>
                      <span className="block text-muted-foreground">{link.description}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">Opens {link.place}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

interface GuideStepRowProps {
  step: GuideStep
  index: number
  state: OnboardingState
  orgSlug: string
  isNext: boolean
}

function GuideStepRow({ step, index, state, orgSlug, isNext }: GuideStepRowProps) {
  const done = state.steps[step.key]
  const target = step.target(state)
  // The "connect a client" step shows the real command for this org's
  // gateway right here, not just a link to it.
  const command =
    step.key === 'external_client' && state.links.gateway
      ? connectCommandFor(state.links.gateway, orgSlug)
      : null

  return (
    <li
      data-testid={`step-${step.key}`}
      data-done={done ? 'true' : 'false'}
      className={cn(
        'rounded-lg border p-3',
        isNext && !done && 'border-violet-500/40 bg-violet-500/5',
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {done ? (
            <span
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-green-100 text-green-600 dark:bg-green-500/20 dark:text-green-300"
              aria-label="Done"
            >
              <Check className="h-4 w-4" />
            </span>
          ) : (
            <span
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs tabular-nums text-muted-foreground"
              aria-label="Not done yet"
            >
              {index}
            </span>
          )}
          <div className="min-w-0">
            <div className={cn('text-sm font-medium', done && 'text-muted-foreground')}>{step.title}</div>
            <p className="text-sm text-muted-foreground">{step.description(state)}</p>
            <p className="mt-1 text-xs text-muted-foreground" data-testid={`step-${step.key}-place`}>
              Opens {target.place}
            </p>
          </div>
        </div>
        <Button
          asChild
          size="sm"
          variant={done ? 'ghost' : 'outline'}
          className="shrink-0 self-start sm:ml-auto"
        >
          <Link to={target.to} data-testid={`step-${step.key}-link`}>
            {done ? 'Open' : step.cta}
          </Link>
        </Button>
      </div>
      {command && <CommandLine command={command} />}
    </li>
  )
}

function CommandLine({ command }: { command: string }) {
  const copy = useCopy()
  return (
    <div className="mt-3 flex items-center gap-2 sm:ml-9">
      <code
        className="min-w-0 flex-1 break-all rounded bg-muted px-3 py-2 font-mono text-xs"
        data-testid="connect-command"
      >
        {command}
      </code>
      <Button
        size="icon"
        variant="outline"
        className="h-8 w-8 shrink-0"
        aria-label="Copy the command"
        onClick={() => void copy(command, 'Command')}
      >
        <Copy className="h-4 w-4" />
      </Button>
    </div>
  )
}
