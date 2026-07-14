/* useEntitlement — read the deployment's license entitlements from the backend
 * and gate EE-only UI on them.
 *
 * The backend `EntitlementGuard` is the real security boundary; this hook is a
 * UX affordance so the app can hide/lock features the current license does not
 * unlock, instead of letting the user click through to a 402.
 *
 * Usage:
 *   const { has, isLoading } = useEntitlement()
 *   if (has('sso')) { ...render SSO settings... }
 *
 *   // or check a single feature:
 *   const sso = useEntitlement('sso')
 *   if (sso.enabled) { ... }
 */
import { useQuery } from '@tanstack/react-query'
import { apiGet } from '../lib/api'

export interface EntitlementSnapshot {
  edition: string
  entitlements: string[]
  limits: Record<string, number>
  expiresAt: string | null
  issuedTo?: string
}

/** Sentinel matching the backend `UNLIMITED` constant. */
export const UNLIMITED = -1

const ENTITLEMENTS_QUERY_KEY = ['licensing', 'entitlements']

export function useEntitlements() {
  const query = useQuery({
    queryKey: ENTITLEMENTS_QUERY_KEY,
    queryFn: () => apiGet<EntitlementSnapshot>('/licensing/entitlements'),
    // Entitlements change rarely (only when the license token changes), so cache
    // them aggressively and avoid refetch churn.
    staleTime: 5 * 60 * 1000,
    retry: false,
  })

  const snapshot = query.data
  const entitlements = snapshot?.entitlements ?? []

  const has = (feature: string): boolean => entitlements.includes(feature)

  const limit = (key: string): number => {
    const value = snapshot?.limits?.[key]
    return typeof value === 'number' ? value : UNLIMITED
  }

  return {
    ...query,
    snapshot,
    edition: snapshot?.edition ?? 'community',
    isEnterprise: snapshot?.edition === 'enterprise',
    entitlements,
    has,
    limit,
  }
}

export interface SingleEntitlement {
  /** True once entitlements have loaded AND the feature is granted. */
  enabled: boolean
  isLoading: boolean
  edition: string
}

/**
 * Convenience overloads:
 *   useEntitlement()          -> the full entitlements API (see useEntitlements)
 *   useEntitlement('sso')     -> { enabled, isLoading, edition } for one feature
 */
export function useEntitlement(): ReturnType<typeof useEntitlements>
export function useEntitlement(feature: string): SingleEntitlement
export function useEntitlement(feature?: string) {
  const ent = useEntitlements()
  if (feature === undefined) return ent
  return {
    enabled: !ent.isLoading && ent.has(feature),
    isLoading: ent.isLoading,
    edition: ent.edition,
  }
}
