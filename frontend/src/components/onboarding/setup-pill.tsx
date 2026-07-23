import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Sparkles } from 'lucide-react'

import { cn } from '@/lib/utils'
import { onboardingApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'
import { useOnboarding } from './getting-started-card'

const CORE_KEYS = ['provider', 'api', 'gateway', 'first_call'] as const

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
  const orgId = currentOrganization?.id
  const { data: onboarding } = useOnboarding(orgId)

  const restore = useMutation({
    mutationFn: () => onboardingApi.setDismissed(orgId as string, false),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['onboarding', orgId] })
      navigate('/')
    },
  })

  // Hidden once the org is really activated (criterion #6) or before data loads.
  if (!onboarding || onboarding.activatedRealAt) return null

  const done = CORE_KEYS.filter((k) => onboarding.steps[k]).length
  const label = `Setup ${done}/${CORE_KEYS.length}`

  return (
    <button
      type="button"
      onClick={() => restore.mutate()}
      title={label}
      aria-label={`${label} — open getting started`}
      className={cn(
        'flex items-center rounded-md border border-cyan-400/30 bg-cyan-400/5 text-cyan-500 hover:bg-cyan-400/10 transition-colors',
        collapsed ? 'justify-center h-8 w-8 mx-auto' : 'w-full gap-2 px-3 py-1.5 text-xs font-medium',
      )}
    >
      <Sparkles className="h-3.5 w-3.5 shrink-0" />
      {!collapsed && <span className="tabular-nums">{label}</span>}
    </button>
  )
}
