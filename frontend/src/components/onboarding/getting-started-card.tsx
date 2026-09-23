import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Bot, Check, Circle, ChevronRight, Compass, Sparkles, X } from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { onboardingApi, type OnboardingState } from '@/lib/api'
import { captureEvent } from '@/lib/analytics'
import { getApiErrorMessage } from '@/lib/api-error'

/**
 * The three steps that make up the progress ring, in fixed order — the
 * hero path: turn an API into tools, publish a gateway, use it from an AI
 * client. None of these require an almyty-side model (the model is the
 * client's, e.g. Claude Code), so connecting one is intentionally NOT a
 * ring step. It is surfaced as a contextual on-ramp (see MODEL_STEP) for
 * the agent / LLM-tool / memory path, which does need a model.
 *
 * `external_client` is likewise excluded from the ring — it is an optional
 * bonus surfaced once first_call lands (per the spec).
 */
/**
 * The steps the ring counts. `provider` is deliberately NOT one of them
 * -- it is offered separately as a contextual on-ramp, because the
 * tool/gateway path does not need a model. Exported so the sidebar pill
 * counts the same steps: it kept its own list with `provider` added, so
 * the same org read "0 of 3 complete" on the card and "Setup 0/4" in the
 * sidebar at the same time.
 */
export const CORE_STEPS: {
  key: keyof OnboardingState['steps']
  label: string
  description: string
  cta: string
  to: string
}[] = [
  {
    key: 'api',
    label: 'Turn an API into tools',
    description: 'Paste a schema and get ready-to-use tools. No code.',
    cta: 'Add an API',
    to: '/apis/new',
  },
  {
    key: 'gateway',
    label: 'Make it usable by AI',
    description: 'Get one link Claude and other agents can call.',
    cta: 'Create a gateway',
    to: '/gateways/new',
  },
  {
    key: 'first_call',
    label: 'Put an agent in front of it',
    description: 'One agent, your tools, reachable from chat, a channel, or a coding harness.',
    cta: 'Build an agent',
    to: '/agents',
  },
]

/**
 * Contextual on-ramp, shown outside the ring once a model is missing. It
 * targets the second family of journeys (agents, model-backed tools, memory)
 * that genuinely need an almyty-configured model — without forcing it on
 * the tool/gateway hero path that doesn't.
 */
const MODEL_STEP = {
  label: 'Building agents on almyty?',
  description: 'Connect a model to power agents, model-backed tools, and memory.',
  cta: 'Connect a model',
  to: '/llm-providers/new',
}

export interface GettingStartedCardProps {
  state: OnboardingState
  onDismiss?: () => void
  /** When provided, renders a 'Take a tour' button that starts the coach-mark tour on demand. */
  onStartTour?: () => void
}

/**
 * Fires PostHog events for state transitions observed between polls. A
 * step that read incomplete last render and complete now emits
 * `onboarding_step_completed` with `via: 'observed'` — so completions
 * driven entirely from the CLI are still captured on the next visit.
 */
function useOnboardingAnalytics(state: OnboardingState) {
  const prev = useRef<OnboardingState | null>(null)
  useEffect(() => {
    const before = prev.current
    if (before) {
      for (const key of Object.keys(state.steps) as (keyof OnboardingState['steps'])[]) {
        if (!before.steps[key] && state.steps[key]) {
          captureEvent('onboarding_step_completed', { step: key, via: 'observed' })
        }
      }
      if (!before.activatedRealAt && state.activatedRealAt) {
        captureEvent('activation', { kind: 'real' })
      }
    }
    prev.current = state
  }, [state])
}

export function GettingStartedCard({
  state,
  onDismiss,
  onStartTour,
}: GettingStartedCardProps) {
  const navigate = useNavigate()
  useOnboardingAnalytics(state)

  const doneCount = CORE_STEPS.filter((s) => state.steps[s.key]).length
  const pct = Math.round((doneCount / CORE_STEPS.length) * 100)
  const firstCallDone = state.steps.first_call

  return (
    <Card className="border-t-2 border-t-violet-500/20">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <CardTitle className="text-lg">Getting started</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Three steps from an API schema to an agent your users can reach. Open any step and we&apos;ll walk you through.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex flex-col items-end gap-1 min-w-[140px]">
              <span className="text-xs text-muted-foreground tabular-nums">
                {doneCount} of {CORE_STEPS.length} complete
              </span>
              <div
                role="progressbar"
                aria-label="Onboarding progress"
                aria-valuenow={doneCount}
                aria-valuemin={0}
                aria-valuemax={CORE_STEPS.length}
                className="h-1.5 w-full rounded-full bg-muted overflow-hidden"
              >
                <div
                  className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400 transition-all duration-500 ease-out"
                  style={{ width: `${pct}%` }}
                />
              </div>
            {onStartTour && (
              <Button
                variant="outline"
                size="sm"
                className="border-violet-500/30 text-violet-500 hover:bg-violet-500/10 shrink-0"
                onClick={onStartTour}
              >
                <Compass className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">Take a tour</span>
              </Button>
            )}
            </div>
            {onDismiss && (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Dismiss getting started"
                onClick={onDismiss}
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {CORE_STEPS.map((step) => {
            const done = state.steps[step.key]
            return (
              <button
                key={step.key}
                data-tour={step.key === 'first_call' ? 'getting-started-first-call' : undefined}
                onClick={() => navigate(step.to)}
                className={`flex items-center gap-3 w-full text-left p-3 rounded-lg border transition-colors ${
                  done
                    ? 'bg-muted border-muted opacity-60'
                    : 'hover:border-primary hover:bg-primary/5 cursor-pointer'
                }`}
              >
                {done ? (
                  <div className="flex items-center justify-center h-6 w-6 rounded-full bg-green-100 text-green-600 dark:bg-green-500/20 dark:text-green-300 shrink-0">
                    <Check className="h-4 w-4" />
                  </div>
                ) : (
                  <Circle className="h-6 w-6 text-muted-foreground shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className={`text-sm font-medium ${done ? 'line-through text-muted-foreground' : ''}`}>
                    {step.label}
                  </div>
                  <div className="text-xs text-muted-foreground">{step.description}</div>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
              </button>
            )
          })}

          {/* External-client bonus row: only shown once first_call lands. */}
          {firstCallDone && (
            <div
              className={`flex items-center gap-3 w-full p-3 rounded-lg border ${
                state.steps.external_client
                  ? 'bg-muted border-muted'
                  : 'border-dashed border-cyan-400/40'
              }`}
            >
              {state.steps.external_client ? (
                <div className="flex items-center justify-center h-6 w-6 rounded-full bg-green-100 text-green-600 dark:bg-green-500/20 dark:text-green-300 shrink-0">
                  <Check className="h-4 w-4" />
                </div>
              ) : (
                <Sparkles className="h-6 w-6 text-cyan-400 shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">
                  {state.steps.external_client
                    ? 'An external client called your gateway.'
                    : 'Connect an external client'}
                </div>
                <div className="text-xs text-muted-foreground">
                  {state.steps.external_client
                    ? 'This is the moment almyty exists for.'
                    : 'Point any MCP client (claude mcp add), an OpenAI-compat call, or curl at your gateway.'}
                </div>
              </div>
            </div>
          )}

          {/* Contextual on-ramp for the agent / LLM-tool / memory path.
              Not a ring step — the hero flow above needs no almyty model. */}
          {!state.steps.provider && (
            <button
              onClick={() => navigate(MODEL_STEP.to)}
              className="flex items-center gap-3 w-full text-left p-3 rounded-lg border border-dashed border-violet-500/30 hover:bg-violet-500/5 transition-colors"
            >
              <Bot className="h-6 w-6 text-violet-500 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">{MODEL_STEP.label}</div>
                <div className="text-xs text-muted-foreground">{MODEL_STEP.description}</div>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
            </button>
          )}
        </div>

      </CardContent>
    </Card>
  )
}

/**
 * Convenience hook: fetches onboarding state for the current org. Polls
 * on mount and whenever `orgId` changes; callers refetch after create
 * actions via the shared `['onboarding', orgId]` query key.
 */
export function useOnboarding(orgId: string | undefined) {
  return useQuery({
    queryKey: ['onboarding', orgId],
    queryFn: () => onboardingApi.get(orgId as string),
    enabled: !!orgId,
    staleTime: 15_000,
  })
}

