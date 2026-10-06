import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { QueryClient } from '@tanstack/react-query'

import { render } from '../../test/setup'
import { PlanBadge, PlanLine, UpgradePrompt, hasPlanToShow, planFromEntitlements } from '../plan-indicator'

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

const BILLING_KEY = ['billing-status', 'org-1']

/**
 * What an install without the billing module leaves behind: the status
 * query failed with a 404. The failure is seeded into the cache rather
 * than thrown from the mock, because vitest counts a mock's rejected
 * result as a test failure even when the query handled it.
 */
function failingBillingClient() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, refetchOnMount: false } } })
  queryClient.getQueryCache().build(queryClient, { queryKey: BILLING_KEY }).setState({
    status: 'error',
    error: Object.assign(new Error('Not Found'), { response: { status: 404 } }),
    errorUpdatedAt: Date.now(),
    fetchStatus: 'idle',
  })
  // Nothing should ask again; a second request would show a plan and fail the test.
  mockedGetStatus.mockResolvedValue(statusFor('pro'))
  return queryClient
}
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
    const businessEnts = ['sso', 'advanced_rbac', 'approval_policy', 'compliance_pack', 'audit_export', 'credentials_governance', 'agent_identity']
    expect(planFromEntitlements(businessEnts)).toBe('business')
  })

  it('returns enterprise when byo_kms + chargeback are also present', () => {
    const enterpriseEnts = [
      'sso',
      'advanced_rbac',
      'approval_policy',
      'compliance_pack',
      'audit_export',
      'credentials_governance',
      'agent_identity',
      'byo_kms',
      'chargeback',
      'white_label',
    ]
    expect(planFromEntitlements(enterpriseEnts)).toBe('enterprise')
  })
})

describe('PlanBadge', () => {
  // mockClear, not mockReset: after a reset, vitest reports a rejected
  // implementation as a test failure even when the query handled it.
  beforeEach(() => mockedGetStatus.mockClear())

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

  it('renders nothing, not a placeholder, when billing status fails (no billing module)', async () => {
    const queryClient = failingBillingClient()
    const { container } = render(<PlanBadge />, { queryClient })
    await waitFor(() => expect(queryClient.getQueryState(BILLING_KEY)?.status).toBe('error'))
    expect(mockedGetStatus).not.toHaveBeenCalled()
    expect(container.querySelector('.animate-pulse')).not.toBeInTheDocument()
    expect(container).toBeEmptyDOMElement()
  })
})

// The sidebar line under the organization switcher. It used to be a "Plan"
// label next to a skeleton that never filled in when billing was absent.
describe('PlanLine', () => {
  // mockClear, not mockReset: after a reset, vitest reports a rejected
  // implementation as a test failure even when the query handled it.
  beforeEach(() => mockedGetStatus.mockClear())

  it('shows nothing while the plan loads: no lone label, no skeleton', async () => {
    let resolve!: (v: unknown) => void
    mockedGetStatus.mockReturnValue(new Promise((r) => (resolve = r)))
    const { container } = render(<PlanLine />)
    expect(screen.queryByText(/Plan/)).not.toBeInTheDocument()
    expect(container).toBeEmptyDOMElement()
    resolve(statusFor('pro'))
    await waitFor(() => expect(screen.getByTestId('plan-line')).toBeInTheDocument())
  })

  it('shows nothing when the billing request fails (self-hosted without billing)', async () => {
    const queryClient = failingBillingClient()
    const { container } = render(<PlanLine />, { queryClient })
    await waitFor(() => expect(queryClient.getQueryState(BILLING_KEY)?.status).toBe('error'))
    expect(mockedGetStatus).not.toHaveBeenCalled()
    expect(container).toBeEmptyDOMElement()
  })

  it('shows nothing when billing is off and the org is on the default plan', async () => {
    mockedGetStatus.mockResolvedValue({ ...statusFor('free'), status: null, stripeConfigured: false })
    const { container } = render(<PlanLine />)
    await waitFor(() => expect(mockedGetStatus).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 0))
    expect(container).toBeEmptyDOMElement()
  })

  it('shows "Plan: <name>" once when there is a plan', async () => {
    mockedGetStatus.mockResolvedValue(statusFor('pro'))
    render(<PlanLine />)
    const line = await screen.findByTestId('plan-line')
    expect(line).toHaveTextContent(/^Plan:\s*Pro$/)
    expect(screen.getAllByText('Pro')).toHaveLength(1)
    expect(screen.getAllByText(/Plan/)).toHaveLength(1)
  })

  it('shows a licensed plan on an install without hosted billing', async () => {
    mockedGetStatus.mockResolvedValue({ ...statusFor('enterprise'), stripeConfigured: false, hasLicenseToken: true })
    render(<PlanLine />)
    expect(await screen.findByTestId('plan-line')).toHaveTextContent('Enterprise')
  })
})

describe('hasPlanToShow', () => {
  it('is false without a status and for a default Free plan with billing off', () => {
    expect(hasPlanToShow(undefined)).toBe(false)
    expect(hasPlanToShow({ ...statusFor('free'), stripeConfigured: false })).toBe(false)
  })

  it('is true for Free with hosted billing on, so people can see they can upgrade', () => {
    expect(hasPlanToShow(statusFor('free'))).toBe(true)
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
