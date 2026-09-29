/**
 * Settings is five sections, not thirteen tabs, and no page got lost.
 *
 * Every page keeps the URL it always had (the plan badge links to
 * /settings/billing, the audit tab too), a section URL opens its first
 * page, and the plan-gated pages still gate themselves wherever they sit.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { screen, within } from '@testing-library/react'

import { render } from '../../test/setup'

const nav = vi.hoisted(() => ({ pathname: '/settings', navigate: vi.fn() }))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useNavigate: () => nav.navigate,
    useLocation: () => ({ pathname: nav.pathname, search: '', hash: '', state: null }),
  }
})

const { stub } = vi.hoisted(() => ({
  stub: (name: string) => () => React.createElement('div', { 'data-testid': 'page-' + name }),
}))
vi.mock('@/components/MembersAndTeamsTab', () => ({ MembersAndTeamsTab: stub('members') }))
vi.mock('@/components/SecurityTab', () => ({ SecurityTab: stub('security') }))
vi.mock('@/components/settings/sso-settings', () => ({ SsoSettings: stub('sso') }))
vi.mock('@/components/settings/rbac-settings', () => ({ RbacSettings: stub('rbac') }))
vi.mock('@/components/settings/approval-policies-settings', () => ({ ApprovalPoliciesSettings: stub('approvals') }))
vi.mock('@/components/settings/compliance-settings', () => ({ ComplianceSettings: stub('compliance') }))
vi.mock('@/components/settings/audit-streams-settings', () => ({ AuditStreamsSettings: stub('audit-streams') }))
vi.mock('@/components/settings/kms-settings', () => ({ KmsSettings: stub('encryption') }))
vi.mock('@/components/settings/referrals-tab', () => ({ ReferralsTab: stub('referrals') }))
vi.mock('@/components/settings/notification-preferences', () => ({ NotificationPreferences: stub('notifications') }))
vi.mock('@/components/BillingTab', () => ({ BillingTab: stub('billing') }))
vi.mock('@/components/plan-indicator', () => ({ PlanBadge: () => null }))
vi.mock('@/lib/api', () => ({
  authApi: { getProfile: vi.fn().mockResolvedValue({}) },
  organizationsApi: { getById: vi.fn().mockResolvedValue({}) },
}))

import { SettingsPage, SETTINGS_SECTIONS, SETTINGS_TABS, getSettingsTab } from '../settings'

/** Every tab Settings had when it was one flat row. */
const LEGACY_TABS = [
  'organization', 'members', 'billing', 'referrals', 'profile', 'notifications', 'security',
  'sso', 'rbac', 'approvals', 'compliance', 'audit-streams', 'encryption',
]

describe('settings sections', () => {
  beforeEach(() => {
    nav.pathname = '/settings'
    nav.navigate.mockReset()
  })

  it('are a handful of sections holding every page Settings ever had', () => {
    expect(SETTINGS_SECTIONS.length).toBeLessThanOrEqual(5)
    expect([...SETTINGS_TABS].sort()).toEqual([...LEGACY_TABS].sort())
    expect(SETTINGS_SECTIONS.map((s) => s.label)).toEqual([
      'Organization', 'Your account', 'People and access', 'Billing', 'Advanced',
    ])
  })

  it('keep every old page URL pointing at its page', () => {
    for (const tab of LEGACY_TABS) {
      const url = tab === 'organization' ? '/settings' : `/settings/${tab}`
      expect(getSettingsTab(url), url).toBe(tab)
    }
    expect(getSettingsTab('/settings/advanced')).toBe('approvals')
    expect(getSettingsTab('/settings/people')).toBe('members')
    expect(getSettingsTab('/settings/nonsense')).toBe('organization')
  })

  it('put the rarely used pages under Advanced', () => {
    const advanced = SETTINGS_SECTIONS.find((s) => s.key === 'advanced')!
    expect(advanced.pages.map((p) => p.key)).toEqual(['approvals', 'compliance', 'audit-streams', 'encryption'])
  })

  it('open an old deep link inside its section, with the section pages listed', () => {
    nav.pathname = '/settings/encryption'
    render(<SettingsPage />)
    expect(screen.getByRole('tab', { name: /Advanced/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getAllByRole('tab')).toHaveLength(5)
    const pages = screen.getByRole('navigation', { name: 'Advanced pages' })
    expect(within(pages).getAllByRole('link').map((a) => a.textContent)).toEqual([
      'Approvals', 'Compliance', 'Audit streaming', 'Encryption',
    ])
    expect(within(pages).getByRole('link', { name: 'Encryption' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByTestId('page-encryption')).toBeInTheDocument()
  })

  it('send a section URL to its first page', () => {
    nav.pathname = '/settings/advanced'
    render(<SettingsPage />)
    expect(screen.getByTestId('page-approvals')).toBeInTheDocument()
    expect(nav.navigate).toHaveBeenCalledWith('/settings/approvals', { replace: true })
  })

  it('show no page list for a one-page section', () => {
    nav.pathname = '/settings'
    render(<SettingsPage />)
    expect(screen.queryByRole('navigation', { name: /pages$/ })).not.toBeInTheDocument()
  })

  it('leave the plan gate inside each paid page', () => {
    const dir = join(__dirname, '..', '..', 'components', 'settings')
    for (const file of ['sso-settings.tsx', 'rbac-settings.tsx', 'approval-policies-settings.tsx', 'compliance-settings.tsx', 'audit-streams-settings.tsx', 'kms-settings.tsx']) {
      expect(readFileSync(join(dir, file), 'utf8'), file).toMatch(/<EntitlementGate\b/)
    }
  })
})
