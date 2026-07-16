import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, fireEvent } from '@testing-library/react'

import { render } from '../../../test/setup'
import { ComplianceSettings } from '../compliance-settings'
import type { EntitlementSnapshot } from '../../../hooks/use-entitlement'

// The entitlements query and the compliance queries both go through the api
// module, so mock both entry points.
vi.mock('../../../lib/api', () => ({
  apiGet: vi.fn(),
  complianceApi: {
    getPolicy: vi.fn(),
    updatePolicy: vi.fn(),
    getReport: vi.fn(),
  },
}))

vi.mock('../../../store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}))

import { apiGet, complianceApi } from '../../../lib/api'

const mockedApiGet = apiGet as unknown as ReturnType<typeof vi.fn>
const mockedGetPolicy = complianceApi.getPolicy as unknown as ReturnType<typeof vi.fn>
const mockedUpdatePolicy = complianceApi.updatePolicy as unknown as ReturnType<typeof vi.fn>
const mockedGetReport = complianceApi.getReport as unknown as ReturnType<typeof vi.fn>

const withEntitlements = (entitlements: string[]): EntitlementSnapshot => ({
  edition: entitlements.includes('compliance_pack') ? 'enterprise' : 'community',
  entitlements,
  limits: {},
  expiresAt: null,
})

const policy = {
  organizationId: 'org-1',
  configured: true,
  enforcedPlugins: ['pii-filter', 'security-scanner'] as const,
  securityThreshold: 'medium' as const,
  blockOnViolation: true,
  piiCategories: ['email'],
}

const report = {
  organizationId: 'org-1',
  window: { from: '2026-06-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' },
  policy,
  enforcedControls: [
    { plugin: 'pii-filter' as const, enforced: true, settings: { categories: ['email'] } },
    {
      plugin: 'security-scanner' as const,
      enforced: true,
      settings: { severityThreshold: 'medium', blockOnThreat: true },
    },
  ],
  activity: {
    totalEvents: 42,
    byAction: { execute: 30, credential_use: 12 },
    scannableEvents: 30,
    credentialAccessEvents: 12,
  },
  postureScore: 100,
}

describe('ComplianceSettings entitlement gating', () => {
  beforeEach(() => {
    mockedApiGet.mockReset()
    mockedGetPolicy.mockReset()
    mockedUpdatePolicy.mockReset()
    mockedGetReport.mockReset()
    mockedGetPolicy.mockResolvedValue(policy)
    mockedGetReport.mockResolvedValue(report)
    mockedUpdatePolicy.mockResolvedValue(policy)
  })

  it('shows the upgrade prompt (not the policy form) when compliance_pack is not granted', async () => {
    mockedApiGet.mockResolvedValue(withEntitlements(['agents', 'tools']))

    render(<ComplianceSettings />)

    await waitFor(() =>
      expect(screen.getByText(/upgrade to unlock it/i)).toBeInTheDocument(),
    )
    expect(
      screen.getByRole('link', { name: /upgrade to business|view plans/i }),
    ).toHaveAttribute('href', '/settings/billing')

    // No policy form control renders, and no /compliance/* call is made.
    expect(
      screen.queryByRole('button', { name: /save compliance policy/i }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/severity threshold/i)).not.toBeInTheDocument()
    expect(mockedGetPolicy).not.toHaveBeenCalled()
    expect(mockedGetReport).not.toHaveBeenCalled()
  })

  it('loads and renders the policy form when compliance_pack is granted', async () => {
    mockedApiGet.mockResolvedValue(withEntitlements(['agents', 'compliance_pack']))

    render(<ComplianceSettings />)

    await waitFor(() => expect(screen.getByText(/enforce pii filter/i)).toBeInTheDocument())
    expect(
      screen.getByRole('button', { name: /save compliance policy/i }),
    ).toBeInTheDocument()
    expect(screen.queryByText(/upgrade to unlock it/i)).not.toBeInTheDocument()
    expect(mockedGetPolicy).toHaveBeenCalled()
  })

  it('saving the policy calls updatePolicy with enforced plugins', async () => {
    mockedApiGet.mockResolvedValue(withEntitlements(['compliance_pack']))

    render(<ComplianceSettings />)

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /save compliance policy/i })).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole('button', { name: /save compliance policy/i }))

    await waitFor(() => expect(mockedUpdatePolicy).toHaveBeenCalledTimes(1))
    const payload = mockedUpdatePolicy.mock.calls[0][0]
    expect(payload.enforcedPlugins).toEqual(
      expect.arrayContaining(['pii-filter', 'security-scanner']),
    )
    expect(payload.securityThreshold).toBe('medium')
    expect(payload.blockOnViolation).toBe(true)
  })

  it('renders the report view from getReport', async () => {
    mockedApiGet.mockResolvedValue(withEntitlements(['compliance_pack']))

    render(<ComplianceSettings />)

    await waitFor(() => expect(mockedGetReport).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText(/posture score/i)).toBeInTheDocument())

    // Score and an activity stat render from the mocked report.
    expect(screen.getByText('100')).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
    // Enforced-controls table lists both controls (exact cell text).
    expect(screen.getByRole('cell', { name: 'PII filter' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'Security scanner' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /download json/i })).toBeInTheDocument()
  })
})
