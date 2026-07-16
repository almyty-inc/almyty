/* plan-catalog — single source of truth for how almyty's plans map to
 * entitlements and which notable features each tier includes.
 *
 * This mirrors the backend `PLAN_ENTITLEMENTS` in
 * `backend/ee/modules/billing/billing.constants.ts` and the public pricing at
 * almyty.com/pricing (Free / Pro $20/seat / Business $60/seat / Enterprise
 * contact-sales). Keep the two in sync: the entitlement strings here are the
 * same the backend `EntitlementGuard` checks (`sso`, `advanced_rbac`, ...).
 *
 * It powers the plan badge, the plan comparison matrix in BillingTab, and the
 * per-feature upgrade prompts, so a logged-in user can always see their tier
 * and exactly what each tier unlocks.
 */

export type PlanKey = 'free' | 'pro' | 'business' | 'enterprise'

export const PLAN_ORDER: PlanKey[] = ['free', 'pro', 'business', 'enterprise']

export interface PlanMeta {
  key: PlanKey
  label: string
  /** Short price line as shown on almyty.com/pricing. */
  price: string
  /** One-line positioning. */
  blurb: string
  /** True for plans a customer can buy via Stripe checkout (Enterprise is sales-led). */
  selfServe: boolean
}

export const PLANS: Record<PlanKey, PlanMeta> = {
  free: {
    key: 'free',
    label: 'Free',
    price: '$0',
    blurb: 'Build and run agents, tools, and gateways.',
    selfServe: false,
  },
  pro: {
    key: 'pro',
    label: 'Pro',
    price: '$20/seat',
    blurb: 'Unlimited resources, managed credits, email support.',
    selfServe: true,
  },
  business: {
    key: 'business',
    label: 'Business',
    price: '$60/seat',
    blurb: 'Governance: SSO, advanced RBAC, approvals, compliance.',
    selfServe: true,
  },
  enterprise: {
    key: 'enterprise',
    label: 'Enterprise',
    price: 'Custom',
    blurb: 'Customer-managed keys, cost attribution, SLAs.',
    selfServe: false,
  },
}

/**
 * Plan -> the EE entitlement strings it grants. Mirrors backend
 * PLAN_ENTITLEMENTS. Free and Pro grant no gated EE entitlements (Pro is a
 * hosted tier, not a feature tier — its website bullets are community
 * features). Used to derive whether a given tier unlocks a matrix row.
 */
export const PLAN_ENTITLEMENTS: Record<PlanKey, string[]> = {
  free: [],
  pro: [],
  business: ['sso', 'advanced_rbac', 'approval_policy', 'compliance_pack', 'audit_export'],
  enterprise: [
    'sso',
    'advanced_rbac',
    'approval_policy',
    'compliance_pack',
    'audit_export',
    'byo_kms',
    'chargeback',
  ],
}

export interface FeatureRow {
  /** Human label for the comparison matrix. */
  label: string
  /**
   * The entitlement that unlocks this row when it is gated by a single
   * entitlement token the backend `EntitlementGuard` checks.
   */
  entitlement?: string
  /** Plans that include this feature when it is not entitlement-gated. */
  includedIn?: PlanKey[]
}

/**
 * The notable features shown in the plan comparison matrix, in the order the
 * user sees them. Entitlement-gated rows resolve per tier from
 * PLAN_ENTITLEMENTS; non-gated rows list the tiers that include them.
 */
export const FEATURE_MATRIX: FeatureRow[] = [
  { label: 'Agents, tools, gateways, MCP', includedIn: ['free', 'pro', 'business', 'enterprise'] },
  { label: 'Scheduling, webhooks, analytics', includedIn: ['free', 'pro', 'business', 'enterprise'] },
  { label: 'Unlimited resources', includedIn: ['pro', 'business', 'enterprise'] },
  { label: 'SSO / SAML + SCIM', entitlement: 'sso' },
  { label: 'Advanced RBAC', entitlement: 'advanced_rbac' },
  { label: 'Approval policies', entitlement: 'approval_policy' },
  { label: 'PII filtering / compliance pack', entitlement: 'compliance_pack' },
  { label: 'Audit export', entitlement: 'audit_export' },
  { label: 'BYO-KMS (customer-managed keys)', entitlement: 'byo_kms' },
  { label: 'Cost attribution / chargeback', entitlement: 'chargeback' },
  { label: 'Priority support / SLAs', includedIn: ['enterprise'] },
]

/** Does a given plan tier include a feature row? */
export function planHasFeature(plan: PlanKey, row: FeatureRow): boolean {
  if (row.entitlement) {
    return PLAN_ENTITLEMENTS[plan].includes(row.entitlement)
  }
  return !!row.includedIn?.includes(plan)
}

/** Normalize an arbitrary plan string from the API into a known PlanKey. */
export function toPlanKey(plan: string | undefined | null): PlanKey {
  const p = (plan || 'free').toLowerCase()
  return (PLAN_ORDER as string[]).includes(p) ? (p as PlanKey) : 'free'
}

/** The lowest tier that unlocks a given entitlement, for upgrade prompts. */
export function tierForEntitlement(entitlement: string): PlanMeta {
  for (const key of PLAN_ORDER) {
    if (PLAN_ENTITLEMENTS[key].includes(entitlement)) return PLANS[key]
  }
  return PLANS.enterprise
}
