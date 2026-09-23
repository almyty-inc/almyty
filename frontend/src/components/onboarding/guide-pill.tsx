import { useEffect, useRef } from 'react'
import { NavLink } from 'react-router-dom'
import { Compass } from 'lucide-react'

import { cn } from '@/lib/utils'
import { captureEvent } from '@/lib/analytics'
import type { OnboardingState } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'
import { ALL_STEPS, stepsDone } from './guide-steps'
import { useOnboarding } from './use-onboarding'

interface GuidePillProps {
  collapsed?: boolean
}

/**
 * Fires PostHog events for state transitions observed between polls. A
 * step that read incomplete last time and complete now emits
 * `onboarding_step_completed` with `via: 'observed'`, so completions done
 * entirely from the CLI are still captured. Mounted with the sidebar
 * entry, which is on every page.
 */
function useOnboardingAnalytics(state: OnboardingState | undefined) {
  const prev = useRef<OnboardingState | null>(null)
  useEffect(() => {
    if (!state) return
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

/**
 * The sidebar's way to the guide. Always there -- dismissing the
 * dashboard card never hides the guide -- and shows how many steps are
 * done until they all are.
 */
export function GuidePill({ collapsed }: GuidePillProps) {
  const { currentOrganization } = useOrganizationStore()
  const { data } = useOnboarding(currentOrganization?.id)
  useOnboardingAnalytics(data)

  const total = ALL_STEPS.length
  const done = data ? stepsDone(data) : 0
  const showProgress = !!data && done < total
  const label = showProgress ? `Guide, ${done} of ${total} steps done` : 'Guide'

  return (
    <NavLink
      to="/guide"
      title={collapsed ? label : undefined}
      aria-label={label}
      data-testid="guide-link"
      className={({ isActive }) =>
        cn(
          'group flex w-full items-center rounded-md transition-colors',
          collapsed ? 'justify-center px-2 py-2' : 'gap-3 px-3 py-1.5 text-[13px]',
          isActive
            ? 'bg-primary/10 font-medium text-primary'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        )
      }
    >
      <Compass className="h-5 w-5 shrink-0 text-cyan-600 dark:text-cyan-400" aria-hidden="true" />
      {!collapsed && (
        <span className="flex min-w-0 flex-1 flex-col gap-1 text-left">
          <span className="flex items-center justify-between">
            <span>Guide</span>
            {showProgress && (
              <span className="text-xs tabular-nums">
                {done}/{total}
              </span>
            )}
          </span>
          {showProgress && (
            <span className="h-1 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
              <span
                className="block h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400"
                style={{ width: `${Math.round((done / total) * 100)}%` }}
              />
            </span>
          )}
        </span>
      )}
    </NavLink>
  )
}
