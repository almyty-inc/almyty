import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'

import { render } from '../../test/setup'
import { PlanBadge, UpgradePrompt, planFromEntitlements } from '../plan-indicator'
import type { EntitlementSnapshot } from '../../hooks/use-entitlement'

vi.mock('../../lib/api', () => ({
  apiGet: vi.fn(),
}))

import { apiGet } from '../../lib/api'

const mockedApiGet = apiGet as unknown as ReturnType<typeof vi.fn>

const community: EntitlementSnapshot = {
  edition: 'community',
  entitlements: ['agents', 'tools'],
  limits: {},
  expiresAt: null,
}

const businessEnts = ['agents', 'sso', 'advanced_rbac', 'approval_policy', 'compliance_pack', 'audit_export']

const business: EntitlementSnapshot = {
  edition: 'enterprise',
  entitlements: businessEnts,
  limits: {},
  expiresAt: null,
}

describe('planFromEntitlements', () => {
  it('returns free when no EE entitlements are granted', () => {
    expect(planFromEntitlements(community.entitlements)).toBe('free')
  })

  it('returns business when the full business entitlement set is present', () => {
    expect(planFromEntitlements(businessEnts)).toBe('business')
  })

  it('returns enterprise when byo_kms + chargeback are also present', () => {
    expect(planFromEntitlements([...businessEnts, 'byo_kms', 'chargeback'])).toBe('enterprise')
  })
})

describe('PlanBadge', () => {
  beforeEach(() => mockedApiGet.mockReset())

  it('renders the Free tier for a community license', async () => {
    mockedApiGet.mockResolvedValue(community)
    render(<PlanBadge />)
    await waitFor(() => expect(screen.getByText('Free')).toBeInTheDocument())
  })

  it('renders the Business tier derived from entitlements', async () => {
    mockedApiGet.mockResolvedValue(business)
    render(<PlanBadge />)
    await waitFor(() => expect(screen.getByText('Business')).toBeInTheDocument())
  })

  it('honors an explicit plan prop over the entitlement snapshot', async () => {
    mockedApiGet.mockResolvedValue(community)
    render(<PlanBadge plan="pro" />)
    await waitFor(() => expect(screen.getByText('Pro')).toBeInTheDocument())
  })

  it('links to Settings -> Billing by default', async () => {
    mockedApiGet.mockResolvedValue(community)
    render(<PlanBadge />)
    const link = await screen.findByRole('link')
    expect(link).toHaveAttribute('href', '/settings/billing')
  })
})

describe('UpgradePrompt', () => {
  beforeEach(() => mockedApiGet.mockReset())

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
