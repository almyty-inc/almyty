import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { onboardingApi, type OnboardingState } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'
import { useNotifications } from '@/store/app'
import { getApiErrorMessage } from '@/lib/api-error'

export const onboardingKey = (orgId: string | undefined) => ['onboarding', orgId] as const

/**
 * The org's guide state, computed server-side from what exists. Shared by
 * the dashboard card, the sidebar entry, the guide page and the page
 * intros through one query key.
 */
export function useOnboarding(orgId: string | undefined) {
  return useQuery({
    queryKey: onboardingKey(orgId),
    queryFn: () => onboardingApi.get(orgId as string),
    enabled: !!orgId,
    staleTime: 15_000,
  })
}

/**
 * Per-user preference writes (card dismissal, page intros). Each PATCH
 * answers with the fresh state, which replaces the cached one, so the
 * change shows without a refetch.
 */
export function useOnboardingPreferences() {
  const queryClient = useQueryClient()
  const { currentOrganization } = useOrganizationStore()
  const { error } = useNotifications()
  const orgId = currentOrganization?.id

  const onSuccess = (next: OnboardingState) => {
    if (next) queryClient.setQueryData(onboardingKey(orgId), next)
    else queryClient.invalidateQueries({ queryKey: onboardingKey(orgId) })
  }
  const onError = (title: string) => (err: unknown) =>
    error(title, getApiErrorMessage(err, 'Please try again.'))

  const setCardDismissed = useMutation({
    mutationFn: (dismissed: boolean) => onboardingApi.setDismissed(orgId as string, dismissed),
    onSuccess,
    onError: onError('Could not update the guide card'),
  })
  const dismissIntro = useMutation({
    mutationFn: (topic: string) => onboardingApi.dismissIntro(orgId as string, topic),
    onSuccess,
    onError: onError('Could not hide this tip'),
  })
  const resetIntros = useMutation({
    mutationFn: () => onboardingApi.resetIntros(orgId as string),
    onSuccess,
    onError: onError('Could not bring the page tips back'),
  })

  return { orgId, setCardDismissed, dismissIntro, resetIntros }
}
