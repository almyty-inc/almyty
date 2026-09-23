import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, CheckCircle2 } from 'lucide-react'

import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'
import { PageHeader } from '@/components/layout/page-header'
import { GuideJourney } from '@/components/onboarding/guide-journey'
import { NextStep } from '@/components/onboarding/next-step'
import {
  ALL_STEPS,
  JOURNEYS,
  SUPPORTING,
  nextStep,
  stepsDone,
} from '@/components/onboarding/guide-steps'
import { useOnboarding, useOnboardingPreferences } from '@/components/onboarding/use-onboarding'
import { useOrganizationStore } from '@/store/organization'
import { orgSlugOf } from '@/lib/gateway-connect'

/**
 * The guide to the whole platform, organised by the jobs people come to
 * do. Every tick on this page is the server's reading of what exists in
 * the org (see guide-steps.ts), so work done from the CLI or the API
 * checks itself off here too.
 *
 * Always reachable (sidebar, command palette, dashboard, every page's
 * intro line), whether or not the dashboard card was dismissed.
 */
export function GuidePage() {
  useEffect(() => {
    document.title = 'Guide | almyty'
    return () => { document.title = 'almyty' }
  }, [])

  const { currentOrganization } = useOrganizationStore()
  const { data: state, isLoading, isError, error, refetch } = useOnboarding(currentOrganization?.id)
  const { setCardDismissed, resetIntros } = useOnboardingPreferences()

  if (isError) {
    return <QueryError error={error} title="We couldn't load the guide" onRetry={() => refetch()} />
  }
  if (isLoading || !state) {
    return (
      <div className="flex h-96 items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  const done = stepsDone(state)
  const total = ALL_STEPS.length
  const next = nextStep(state)
  const orgSlug = orgSlugOf(currentOrganization)
  const closedTips = state.dismissedIntros?.length ?? 0

  return (
    <div className="space-y-6">
      <PageHeader
        title="Guide"
        description={`What you can do with almyty, and how far you are: ${done} of ${total} steps done. Steps tick themselves off when the thing exists, however you made it.`}
        actions={
          <Button
            variant="outline"
            onClick={() => setCardDismissed.mutate(!state.dismissed)}
            disabled={setCardDismissed.isPending}
          >
            {state.dismissed ? 'Show on dashboard' : 'Hide from dashboard'}
          </Button>
        }
      />

      <Card>
        <CardContent className="pt-6">
          {next ? (
            <NextStep journey={next.journey} step={next.step} state={state} />
          ) : (
            <div className="flex items-center gap-3" data-testid="guide-complete">
              <CheckCircle2 className="h-6 w-6 text-violet-600 dark:text-violet-400" aria-hidden="true" />
              <p className="text-sm">
                You have done every step. Your agents are reachable, and the rest of the platform is below
                whenever you need it.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {JOURNEYS.map((journey) => (
          <GuideJourney
            key={journey.id}
            journey={journey}
            state={state}
            orgSlug={orgSlug}
            nextKey={next?.step.key}
          />
        ))}
      </div>

      <section aria-labelledby="guide-also" className="space-y-3">
        <h2 id="guide-also" className="font-heading text-lg font-semibold">
          Also in almyty
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {SUPPORTING.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              className="group rounded-xl border bg-card p-4 transition-colors hover:border-primary hover:bg-primary/5"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{link.title}</span>
                <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground" aria-hidden="true" />
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{link.description}</p>
            </Link>
          ))}
        </div>
      </section>

      {closedTips > 0 && (
        <p className="text-sm text-muted-foreground">
          You closed the tip line on {closedTips === 1 ? 'one page' : `${closedTips} pages`}.{' '}
          <button
            type="button"
            className="font-medium text-violet-600 hover:underline disabled:opacity-50 dark:text-violet-400"
            onClick={() => resetIntros.mutate()}
            disabled={resetIntros.isPending}
          >
            Show page tips again
          </button>
        </p>
      )}
    </div>
  )
}

export default GuidePage
