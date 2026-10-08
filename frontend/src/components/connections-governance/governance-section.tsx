/**
 * Settings > Advanced > Credential rules (EE, `credentials_governance`).
 * Locked without the entitlement; with it, a sub-navigation over the
 * policies table, the review dashboard, and expiry, rotation and export.
 */

import { EntitlementGate } from '@/components/entitlement-gate'
import { UpgradePrompt } from '@/components/plan-indicator'
import { Skeleton } from '@/components/ui/skeleton'
import { CONNECTIONS_GOVERNANCE_ENTITLEMENT } from '@/lib/connections-governance-api'
import { ExpiryPanel } from './expiry-panel'
import { PoliciesTable } from './policies-table'
import { ReviewDashboard } from './review-dashboard'

export type GovernanceView = 'policies' | 'review' | 'expiry'

export function ConnectionsGovernanceSection({ initialView = 'policies' }: { initialView?: GovernanceView }) {
  return (
    <section className="space-y-3" aria-label="Credential rules" data-testid="connections-governance">
      <div className="space-y-1">
        <h2 className="font-heading text-lg font-semibold">Credential rules</h2>
        <p className="text-sm text-muted-foreground">Which services may be used and by whom, a review of keys given to agents, and when keys expire or are replaced.</p>
      </div>
      <EntitlementGate
        feature={CONNECTIONS_GOVERNANCE_ENTITLEMENT}
        mode="lock"
        loading={<Skeleton className="h-32 rounded-xl" data-testid="governance-loading" />}
        fallback={
          <div data-testid="governance-locked">
            <UpgradePrompt
              feature={CONNECTIONS_GOVERNANCE_ENTITLEMENT}
              title="Credentials governance"
              description="Allow and deny lists, scope rules for production agents, secret expiry and scheduled rotation, a review of personal credentials granted to agents, and an audit export."
            />
          </div>
        }
      >
        <GovernanceSurface initialView={initialView} />
      </EntitlementGate>
    </section>
  )
}

function GovernanceSurface({ initialView }: { initialView: GovernanceView }) {
  return (
    <div className="space-y-6" data-testid="governance-unlocked">
      <details open={initialView === 'policies'}>
        <summary className="cursor-pointer text-sm font-medium">Policies</summary>
        <div className="pt-4"><PoliciesTable /></div>
      </details>
      <details open={initialView === 'review'}>
        <summary className="cursor-pointer text-sm font-medium">Review</summary>
        <div className="pt-4"><ReviewDashboard /></div>
      </details>
      <details open={initialView === 'expiry'}>
        <summary className="cursor-pointer text-sm font-medium">Expiry and rotation</summary>
        <div className="pt-4"><ExpiryPanel /></div>
      </details>
    </div>
  )
}
