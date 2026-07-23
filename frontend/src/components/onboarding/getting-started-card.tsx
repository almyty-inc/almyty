import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, Circle, ChevronRight, Sparkles, X } from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { onboardingApi, type OnboardingState } from '@/lib/api'
import { captureEvent } from '@/lib/analytics'

/**
 * The four steps that make up the progress ring, in fixed order.
 * `external_client` is intentionally excluded from the ring — it is an
 * optional bonus surfaced once first_call lands (per the spec).
 */
const CORE_STEPS: {
  key: keyof OnboardingState['steps']
  label: string
  description: string
  cta: string
  to: string
}[] = [
  {
    key: 'provider',
    label: 'Connect an LLM provider',
    description: 'Power agents and tool generation. Keys stay encrypted at rest.',
    cta: 'Add provider',
    to: '/llm-providers?new=1',
  },
  {
    key: 'api',
    label: 'Import your first API',
    description: 'Every operation in an OpenAPI, GraphQL, SOAP, or Protobuf schema becomes a typed tool.',
    cta: 'Import API',
    to: '/apis?new=1',
  },
  {
    key: 'gateway',
    label: 'Create a gateway with tools',
    description: 'One endpoint that serves your tools over MCP, A2A, UTCP, and Agent Skills.',
    cta: 'Create gateway',
    to: '/gateways?new=1',
  },
  {
    key: 'first_call',
    label: 'Make your first call',
    description: 'Run an agent or hit a gateway to see the pipeline end to end.',
    cta: 'Try it',
    to: '/agents',
  },
]

export interface GettingStartedCardProps {
  state: OnboardingState
  onSeedSample?: () => void
  seeding?: boolean
  onDismiss?: () => void
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
      if (!before.activatedSampleAt && state.activatedSampleAt) {
        captureEvent('activation', { kind: 'sample' })
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
  onSeedSample,
  seeding,
  onDismiss,
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
              Four steps from an API schema to a live, AI-ready gateway. Open any step and we&apos;ll walk you through.
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
                onClick={() => navigate(step.to)}
                className={`flex items-center gap-3 w-full text-left p-3 rounded-lg border transition-colors ${
                  done
                    ? 'bg-muted border-muted opacity-60'
                    : 'hover:border-primary hover:bg-primary/5 cursor-pointer'
                }`}
              >
                {done ? (
                  <div className="flex items-center justify-center h-6 w-6 rounded-full bg-green-100 text-green-600 shrink-0">
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
                <div className="flex items-center justify-center h-6 w-6 rounded-full bg-green-100 text-green-600 shrink-0">
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
        </div>

        {!state.sampleWorkspace && onSeedSample && (
          <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-dashed border-cyan-400/40 p-3">
            <div className="text-sm text-muted-foreground">
              Prefer to explore first? Load a ready-made Petstore workspace.
            </div>
            <Button
              variant="outline"
              className="border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10 shrink-0"
              onClick={onSeedSample}
              disabled={seeding}
            >
              {seeding ? 'Loading…' : 'Load sample workspace'}
            </Button>
          </div>
        )}
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

/**
 * Shared mutation for the one-click "Load the Petstore sample" action.
 * Fires `sample_workspace_loaded` and refreshes the module list caches
 * so the seeded API/tools/gateway/agent appear immediately.
 */
export function useSeedSampleWorkspace(orgId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => onboardingApi.seedSample(orgId as string),
    onSuccess: () => {
      captureEvent('sample_workspace_loaded')
      queryClient.invalidateQueries({ queryKey: ['onboarding', orgId] })
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      queryClient.invalidateQueries({ queryKey: ['tools', orgId] })
      queryClient.invalidateQueries({ queryKey: ['gateways', orgId] })
      queryClient.invalidateQueries({ queryKey: ['agents', orgId] })
    },
  })
}
