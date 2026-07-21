import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'

import { render } from '../../test/setup'
import { PlanBadge, UpgradePrompt, planFromEntitlements } from '../plan-indicator'

// PlanBadge derives its LABEL from the billing plan (via useBillingPlan ->
// billingApi.getStatus + the current org), NOT from entitlements — Free and Pro
// grant identical (empty) entitlement sets, so entitlements can't tell them
// apart. Mock the billing source and the org store accordingly.
vi.mock('../../lib/api', () => ({
  apiGet: vi.fn(),
  billingApi: {
    getStatus: vi.fn(),
  },
}))

vi.mock('../../store/organization', () => ({
  useOrganizationStore: (selector: (s: any) => unknown) =>
    selector({ currentOrganization: { id: 'org-1' } }),
}))

import { billingApi } from '../../lib/api'

const mockedGetStatus = billingApi.getStatus as unknown as ReturnType<typeof vi.fn>

function statusFor(plan: string) {
  return {
    plan,
    seats: 1,
    status: 'active',
    hasSubscription: plan !== 'free',
    dunning: false,
    graceUntil: null,
    planExpiresAt: null,
    hasLicenseToken: false,
    stripeConfigured: true,
  }
}

describe('planFromEntitlements', () => {
  // Retained helper: infers the EE feature tier a license covers. It is NOT the
  // source for the plan label (Pro looks like Free here) — that is the point of
  // the PlanBadge fix below.
  it('returns free when no EE entitlements are granted', () => {
    expect(planFromEntitlements(['agents', 'tools'])).toBe('free')
  })

  it('cannot distinguish Pro from Free (both grant no EE entitlements)', () => {
    // This is exactly why the badge must read the billing plan, not this.
    expect(planFromEntitlements([])).toBe('free')
  })

  it('returns business when the full business entitlement set is present', () => {
    const businessEnts = ['sso', 'advanced_rbac', 'approval_policy', 'compliance_pack', 'audit_export']
    expect(planFromEntitlements(businessEnts)).toBe('business')
  })

  it('returns enterprise when byo_kms + chargeback are also present', () => {
    const enterpriseEnts = [
      'sso',
      'advanced_rbac',
      'approval_policy',
      'compliance_pack',
      'audit_export',
      'byo_kms',
      'chargeback',
    ]
    expect(planFromEntitlements(enterpriseEnts)).toBe('enterprise')
  })
})

describe('PlanBadge', () => {
  beforeEach(() => mockedGetStatus.mockReset())

  it('renders "Free" for a genuinely free org', async () => {
    mockedGetStatus.mockResolvedValue(statusFor('free'))
    render(<PlanBadge />)
    await waitFor(() => expect(screen.getByText('Free')).toBeInTheDocument())
  })

  it('renders "Pro" for a Pro org (the bug: entitlements would say Free)', async () => {
    mockedGetStatus.mockResolvedValue(statusFor('pro'))
    render(<PlanBadge />)
    await waitFor(() => expect(screen.getByText('Pro')).toBeInTheDocument())
    expect(screen.queryByText('Free')).not.toBeInTheDocument()
  })

  it('renders "Business" for a Business org', async () => {
    mockedGetStatus.mockResolvedValue(statusFor('business'))
    render(<PlanBadge />)
    await waitFor(() => expect(screen.getByText('Business')).toBeInTheDocument())
  })

  it('renders "Enterprise" for an Enterprise org', async () => {
    mockedGetStatus.mockResolvedValue(statusFor('enterprise'))
    render(<PlanBadge />)
    await waitFor(() => expect(screen.getByText('Enterprise')).toBeInTheDocument())
  })

  it('shows a skeleton (never a wrong "Free") while billing status is loading', async () => {
    // Hold the request pending, assert the skeleton, then let it settle so the
    // query does not leak into the next test.
    let resolve!: (v: unknown) => void
    mockedGetStatus.mockReturnValue(new Promise((r) => (resolve = r)))
    const { container } = render(<PlanBadge />)
    expect(screen.queryByText('Free')).not.toBeInTheDocument()
    expect(screen.queryByText('Pro')).not.toBeInTheDocument()
    // The skeleton is a pulsing placeholder span.
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument()
    resolve(statusFor('pro'))
    await waitFor(() => expect(screen.getByText('Pro')).toBeInTheDocument())
  })

  it('honors an explicit plan prop without fetching billing status', async () => {
    render(<PlanBadge plan="enterprise" />)
    await waitFor(() => expect(screen.getByText('Enterprise')).toBeInTheDocument())
    expect(mockedGetStatus).not.toHaveBeenCalled()
  })

  it('links to Settings -> Billing by default', async () => {
    mockedGetStatus.mockResolvedValue(statusFor('pro'))
    render(<PlanBadge />)
    const link = await screen.findByRole('link')
    expect(link).toHaveAttribute('href', '/settings/billing')
  })
})

describe('UpgradePrompt', () => {
  it('names the unlocking tier and links to billing for an entitlement', () => {
    render(<UpgradePrompt feature="sso" title="Single Sign-On" />)
    expect(screen.getByText('Single Sign-On')).toBeInTheDocument()
    // sso is a Business entitlement.
    expect(screen.getByText('Upgrade to Business')).toBeInTheDocument()
    expect(screen.getByRole('link')).toHaveAttribute('href', '/settings/billing')
  })

  it('shows "View plans" for an enterprise-only entitlement (contact sales)', () => {
    render(<UpgradePrompt feature="byo_kms" title="Customer-managed keys" />)
    expect(screen.getByText('View plans')).toBeInTheDocument()
  })
})
