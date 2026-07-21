/* useBillingPlan — read the org's real subscription tier from the billing
 * status endpoint.
 *
 * The billing plan (free / pro / business / enterprise) is the *authoritative*
 * source for a customer's tier LABEL. Entitlements only distinguish the EE
 * feature tiers (Business/Enterprise grant gated entitlements; Free and Pro
 * both grant none), so they cannot tell a paying Pro org apart from a Free one.
 * Anything that shows the plan name — the sidebar badge, the Settings header —
 * must read it from here, not infer it from entitlements.
 *
 * Shares the same query key as <BillingTab/> so both surfaces read one cached
 * response.
 */
import { useQuery } from '@tanstack/react-query'

import { billingApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'
import { toPlanKey, type PlanKey } from '@/lib/plan-catalog'

export interface BillingStatus {
  plan: string
  seats: number
  status: string | null
  hasSubscription: boolean
  dunning: boolean
  graceUntil: string | null
  planExpiresAt: string | null
  hasLicenseToken: boolean
  stripeConfigured: boolean
}

export interface BillingPlan {
  /** Normalized tier for the current org, once loaded. */
  plan: PlanKey | undefined
  /** Raw status payload, for callers that need seats / dunning / etc. */
  status: BillingStatus | undefined
  isLoading: boolean
}

/**
 * Resolve the current org's plan tier from the billing status endpoint. Returns
 * `plan: undefined` while the request is in flight or no org is selected so
 * callers can render a skeleton instead of flashing a wrong "Free".
 *
 * Pass `{ enabled: false }` to skip the request entirely — e.g. when the caller
 * already has an explicit plan and does not need to fetch.
 */
export function useBillingPlan(options?: { enabled?: boolean }): BillingPlan {
  const organizationId = useOrganizationStore((s) => s.currentOrganization?.id)
  const enabled = (options?.enabled ?? true) && !!organizationId

  const { data, isLoading } = useQuery<BillingStatus>({
    queryKey: ['billing-status', organizationId],
    queryFn: () => billingApi.getStatus(organizationId!) as Promise<BillingStatus>,
    enabled,
    staleTime: 60 * 1000,
    retry: false,
  })

  return {
    plan: data ? toPlanKey(data.plan) : undefined,
    status: data,
    // Only "loading" when we actually issued the request.
    isLoading: enabled && isLoading,
  }
}
