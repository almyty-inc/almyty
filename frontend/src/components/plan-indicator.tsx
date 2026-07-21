/* Plan visibility primitives — reusable across the app so a logged-in user can
 * always see their tier and understand what a locked feature would unlock.
 *
 *   <PlanBadge />            — the org's current tier, links to Settings -> Billing
 *   <UpgradePrompt feature/> — a "this is a <tier> feature" lock state with a CTA
 *
 * The badge reads the org's *billing plan* (via `useBillingPlan`) because that
 * is the authoritative source for the tier LABEL: Free and Pro grant identical
 * (empty) EE-entitlement sets, so entitlements alone cannot tell a paying Pro
 * org apart from a Free one. Entitlements still drive per-feature gating, which
 * is what <UpgradePrompt/> and the feature matrix use.
 */
import { Link } from 'react-router-dom'
import { Lock, Sparkles } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { useBillingPlan } from '@/hooks/use-billing-plan'
import {
  PLANS,
  PLAN_ENTITLEMENTS,
  PLAN_ORDER,
  toPlanKey,
  tierForEntitlement,
  type PlanKey,
} from '@/lib/plan-catalog'

const BILLING_PATH = '/settings/billing'

/**
 * Derive the highest tier whose EE entitlement set a license fully covers.
 *
 * NOTE: this is NOT a reliable source for the plan LABEL — Free and Pro both
 * grant no EE entitlements, so this returns 'free' for a Pro org. The badge
 * therefore reads the billing plan instead (see <PlanBadge/>). This helper is
 * retained only for reasoning about which EE feature tier a license unlocks.
 */
export function planFromEntitlements(entitlements: string[]): PlanKey {
  // Walk highest -> lowest so byo_kms/chargeback map to enterprise before business.
  for (let i = PLAN_ORDER.length - 1; i >= 0; i--) {
    const key = PLAN_ORDER[i]
    const required = PLAN_ENTITLEMENTS[key]
    if (required.length > 0 && required.every((e) => entitlements.includes(e))) {
      return key
    }
  }
  return 'free'
}

const BADGE_TONE: Record<PlanKey, string> = {
  free: 'bg-muted text-muted-foreground border-transparent',
  pro: 'bg-primary/10 text-primary border-primary/30',
  business: 'bg-primary/15 text-primary border-primary/40',
  enterprise:
    'bg-gradient-to-r from-primary to-cyan-500 text-white border-transparent',
}

interface PlanBadgeProps {
  /** Override the inferred plan (e.g. from billing status). */
  plan?: string
  /** Render as a link to Settings -> Billing (default true). */
  asLink?: boolean
  className?: string
}

/** Small, persistent indicator of the org's current plan tier. */
export function PlanBadge({ plan, asLink = true, className }: PlanBadgeProps) {
  // An explicit `plan` prop is authoritative; skip the billing fetch then.
  const { plan: billingPlan, isLoading } = useBillingPlan({ enabled: plan === undefined })

  // Until the billing status resolves, render a skeleton rather than flashing a
  // wrong "Free". An explicit `plan` prop bypasses the fetch entirely.
  if (plan === undefined && (isLoading || billingPlan === undefined)) {
    return <span className={cn('inline-block h-5 w-14 rounded bg-muted animate-pulse', className)} />
  }

  const key: PlanKey = plan !== undefined ? toPlanKey(plan) : billingPlan!
  const meta = PLANS[key]

  const badge = (
    <Badge
      variant="outline"
      className={cn('gap-1 font-medium', BADGE_TONE[key], className)}
      aria-label={`Current plan: ${meta.label}`}
    >
      {key === 'enterprise' && <Sparkles className="h-3 w-3" />}
      {meta.label}
    </Badge>
  )

  if (!asLink) return badge

  return (
    <Link
      to={BILLING_PATH}
      className="inline-flex focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
      title="View plan and billing"
    >
      {badge}
    </Link>
  )
}

interface UpgradePromptProps {
  /** Entitlement the surface needs, e.g. "sso" — determines the unlocking tier. */
  feature: string
  /** What the locked control is, for the heading (e.g. "Single Sign-On"). */
  title: string
  /** Optional longer explanation of what the feature does. */
  description?: string
  className?: string
}

/**
 * A consistent lock state for an EE-gated surface: tells the user which tier
 * unlocks the feature and links to Settings -> Billing, instead of letting them
 * click through to a 402.
 */
export function UpgradePrompt({ feature, title, description, className }: UpgradePromptProps) {
  const tier = tierForEntitlement(feature)

  return (
    <Card className={cn('border-dashed', className)}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Lock className="h-5 w-5 text-primary" />
          {title}
          <Badge variant="outline" className="ml-1 border-primary/40 text-primary">
            {tier.label}
          </Badge>
        </CardTitle>
        <CardDescription>
          {description
            ? `${description} `
            : `${title} is part of the almyty ${tier.label} plan. `}
          Upgrade to unlock it for your organization.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild>
          <Link to={BILLING_PATH}>
            <Sparkles className="mr-1.5 h-4 w-4" />
            {tier.selfServe ? `Upgrade to ${tier.label}` : 'View plans'}
          </Link>
        </Button>
      </CardContent>
    </Card>
  )
}
