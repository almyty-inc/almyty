/**
 * Settings > Connections > Governance (EE, `connections_governance`).
 * Locked without the entitlement; with it, a sub-navigation over the
 * policies table, the review dashboard, and expiry, rotation and export.
 */
import { useState } from 'react'
import { Eye, ShieldCheck, TimerReset } from 'lucide-react'

import { EntitlementGate } from '@/components/entitlement-gate'
import { UpgradePrompt } from '@/components/plan-indicator'
import { Skeleton } from '@/components/ui/skeleton'
import { CONNECTIONS_GOVERNANCE_ENTITLEMENT } from '@/lib/connections-governance-api'
import { cn } from '@/lib/utils'
import { ExpiryPanel } from './expiry-panel'
import { PoliciesTable } from './policies-table'
import { ReviewDashboard } from './review-dashboard'

export type GovernanceView = 'policies' | 'review' | 'expiry'

const VIEWS: Array<{ key: GovernanceView; label: string; icon: typeof ShieldCheck }> = [
  { key: 'policies', label: 'Policies', icon: ShieldCheck },
  { key: 'review', label: 'Review', icon: Eye },
  { key: 'expiry', label: 'Expiry and rotation', icon: TimerReset },
]

export function ConnectionsGovernanceSection({ initialView = 'policies' }: { initialView?: GovernanceView }) {
  return (
    <section className="space-y-3" aria-label="Governance" data-testid="connections-governance">
      <div className="flex items-baseline gap-2">
        <h2 className="font-heading text-lg font-semibold">Governance</h2>
        <span className="text-xs text-muted-foreground">org-wide rules, review, expiry and rotation</span>
      </div>
      <EntitlementGate
        feature={CONNECTIONS_GOVERNANCE_ENTITLEMENT}
        mode="lock"
        loading={<Skeleton className="h-32 rounded-xl" data-testid="governance-loading" />}
        fallback={
          <div data-testid="governance-locked">
            <UpgradePrompt
              feature={CONNECTIONS_GOVERNANCE_ENTITLEMENT}
              title="Connections governance"
              description="Allow and deny lists, scope rules for production agents, secret expiry and scheduled rotation, a review of personal connections granted to agents, and an audit export."
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
  const [view, setView] = useState<GovernanceView>(initialView)
  return (
    <div className="space-y-4" data-testid="governance-unlocked">
      <div className="flex items-center gap-1 border-b" role="tablist" aria-label="Governance views">
        {VIEWS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={view === key}
            aria-controls={`governance-${key}`}
            data-testid={`governance-tab-${key}`}
            onClick={() => setView(key)}
            className={cn(
              '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              view === key ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>
      <div id={`governance-${view}`} role="tabpanel">
        {view === 'policies' && <PoliciesTable />}
        {view === 'review' && <ReviewDashboard />}
        {view === 'expiry' && <ExpiryPanel />}
      </div>
    </div>
  )
}
