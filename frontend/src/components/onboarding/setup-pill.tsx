import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Sparkles } from 'lucide-react'

import { cn } from '@/lib/utils'
import { onboardingApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'
import { useNotifications } from '@/store/app'
import { getApiErrorMessage } from '@/lib/api-error'
import { CORE_STEPS, useOnboarding } from './getting-started-card'

const CORE_KEYS = CORE_STEPS.map((s) => s.key)

interface SetupPillProps {
  collapsed?: boolean
}

/**
 * A compact "Setup n/4" pill for the sidebar footer. It lingers until
 * the org reaches real activation, so a user who dismissed the
 * dashboard card can still find their way back. Clicking restores the
 * card (clears the per-user dismissal) and returns to the dashboard.
 */
export function SetupPill({ collapsed }: SetupPillProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { currentOrganization } = useOrganizationStore()
  const { error } = useNotifications()
  const orgId = currentOrganization?.id
  const { data: onboarding } = useOnboarding(orgId)

  const restore = useMutation({
    mutationFn: () => onboardingApi.setDismissed(orgId as string, false),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['onboarding', orgId] })
      navigate('/')
    },
    // Without this the pill was a button that did nothing at all when
    // the call was refused: no navigation, no card, no message.
    onError: (err: unknown) =>
      error(
        'Could not reopen getting started',
        getApiErrorMessage(err, 'Please try again.'),
      ),
  })

  // Hidden once the org is really activated (criterion #6) or before data loads.
  if (!onboarding || onboarding.activatedRealAt) return null

  const done = CORE_KEYS.filter((k) => onboarding.steps[k]).length
  const total = CORE_KEYS.length
  const label = `Setup ${done}/${total}`

  // Styled as one more sidebar row -- same padding, type size and hover
  // as the nav links above it -- rather than a bordered cyan box, so it
  // reads as part of the sidebar instead of something floating in it.
  // The cyan lives only in the icon and the thin progress track.
  return (
    <button
      type="button"
      onClick={() => restore.mutate()}
      title={label}
      aria-label={`${label} — open getting started`}
      data-testid="setup-progress"
      className={cn(
        'group flex w-full items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
        collapsed ? 'justify-center px-2 py-2' : 'gap-3 px-3 py-1.5 text-[13px]',
      )}
    >
      <Sparkles className="h-5 w-5 shrink-0 text-cyan-600 dark:text-cyan-400" aria-hidden="true" />
      {!collapsed && (
        <span className="flex min-w-0 flex-1 flex-col gap-1 text-left">
          <span className="flex items-center justify-between">
            <span>Finish setup</span>
            <span className="text-xs tabular-nums">{done}/{total}</span>
          </span>
          <span className="h-1 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <span
              className="block h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400"
              style={{ width: `${Math.round((done / total) * 100)}%` }}
            />
          </span>
        </span>
      )}
    </button>
  )
}