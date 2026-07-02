/* EntitlementGate — hide or lock UI that requires a license entitlement.
 *
 * The backend `EntitlementGuard` (402) is the real boundary; this component is
 * a UX affordance. By default an ungranted feature renders nothing (hidden);
 * pass `mode="lock"` with a `fallback` to render a disabled/upsell state
 * instead.
 *
 * Usage:
 *   <EntitlementGate feature="sso">
 *     <SsoSettings />
 *   </EntitlementGate>
 *
 *   <EntitlementGate feature="sso" mode="lock" fallback={<UpgradeCard />}>
 *     <SsoSettings />
 *   </EntitlementGate>
 */
import { ReactNode } from 'react'
import { useEntitlement } from '../hooks/use-entitlement'

interface EntitlementGateProps {
  feature: string
  children: ReactNode
  /** 'hide' (default) renders nothing when ungranted; 'lock' renders `fallback`. */
  mode?: 'hide' | 'lock'
  /** Shown when the feature is not granted and mode is 'lock'. */
  fallback?: ReactNode
  /** Optional element shown while entitlements are still loading. */
  loading?: ReactNode
}

export function EntitlementGate({
  feature,
  children,
  mode = 'hide',
  fallback = null,
  loading = null,
}: EntitlementGateProps) {
  const { enabled, isLoading } = useEntitlement(feature)

  if (isLoading) return <>{loading}</>
  if (enabled) return <>{children}</>
  return mode === 'lock' ? <>{fallback}</> : null
}
