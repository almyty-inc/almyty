import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'

import { render } from '../../../test/setup'
import { AuditTab } from '../audit-tab'
import type { EntitlementSnapshot } from '../../../hooks/use-entitlement'

vi.mock('../../../lib/api', () => ({
  apiGet: vi.fn(),
  analyticsApi: {
    getAuditSummary: vi.fn(),
  },
  auditLogsApi: {
    getAll: vi.fn(),
  },
  auditExportApi: {
    download: vi.fn(),
  },
}))

vi.mock('../../../store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org-1', name: 'Acme' } }),
}))

vi.mock('../../../store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}))

import { apiGet, analyticsApi, auditLogsApi } from '../../../lib/api'

const mockedApiGet = apiGet as unknown as ReturnType<typeof vi.fn>
const mockedSummary = analyticsApi.getAuditSummary as unknown as ReturnType<typeof vi.fn>
const mockedLogs = auditLogsApi.getAll as unknown as ReturnType<typeof vi.fn>

const withEntitlements = (entitlements: string[]): EntitlementSnapshot => ({
  edition: entitlements.includes('audit_export') ? 'enterprise' : 'community',
  entitlements,
  limits: {},
  expiresAt: null,
})

describe('AuditTab export entitlement gating', () => {
  beforeEach(() => {
    mockedApiGet.mockReset()
    mockedSummary.mockReset()
    mockedLogs.mockReset()
    mockedSummary.mockResolvedValue({
      totals: { today: 0, thisWeek: 0, thisMonth: 0 },
      topUsers: [],
      byResourceType: [],
    })
    mockedLogs.mockResolvedValue({ data: [], pagination: { page: 1, totalPages: 1, total: 0 } })
  })

  it('shows a locked export affordance (not the export buttons) without audit_export', async () => {
    mockedApiGet.mockResolvedValue(withEntitlements(['agents', 'tools']))

    render(<AuditTab />)

    // The locked affordance names the unlocking tier and links to billing.
    const locked = await screen.findByRole('link', { name: /export \(business\)/i })
    expect(locked).toHaveAttribute('href', '/settings/billing')
    // The real CSV/JSON export buttons must not render.
    expect(screen.queryByRole('button', { name: /^csv$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^json$/i })).not.toBeInTheDocument()
  })

  it('renders the CSV / JSON export buttons when audit_export is granted', async () => {
    mockedApiGet.mockResolvedValue(withEntitlements(['agents', 'tools', 'audit_export']))

    render(<AuditTab />)

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^csv$/i })).toBeInTheDocument(),
    )
    expect(screen.getByRole('button', { name: /^json$/i })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /export \(business\)/i })).not.toBeInTheDocument()
  })
})

/**
 * A zero you can trust.
 *
 * Every branch of the audit summary had its own `.catch(() => 0)`, so a
 * database problem rendered "0 events today / this week / this month" --
 * indistinguishable from a genuinely quiet organization, on the one
 * surface where that distinction is the entire point. The API now says
 * which figures it could not read.
 */
describe('the audit summary says when a figure is missing rather than zero', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedLogs.mockResolvedValue({ data: [], total: 0 })
    mockedApiGet.mockResolvedValue(withEntitlements([]))
  })

  it('shows a dash and a banner for the figures that failed', async () => {
    mockedSummary.mockResolvedValue({
      partial: true,
      unavailable: ['today', 'thisWeek'],
      totals: { today: 0, thisWeek: 0, thisMonth: 42 },
      topUsers: [],
      byAction: [],
      byResourceType: [],
      timeline: [],
    })

    render(<AuditTab />)

    expect(await screen.findByTestId('audit-summary-partial')).toBeInTheDocument()
    await waitFor(() => expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2))
    // The figure that DID come back is still shown as itself.
    expect(screen.getByText('42')).toBeInTheDocument()
  })

  it('shows no banner when every figure was read', async () => {
    mockedSummary.mockResolvedValue({
      partial: false,
      unavailable: [],
      totals: { today: 0, thisWeek: 3, thisMonth: 9 },
      topUsers: [],
      byAction: [],
      byResourceType: [],
      timeline: [],
    })

    render(<AuditTab />)

    await waitFor(() => expect(screen.getByText('9')).toBeInTheDocument())
    expect(screen.queryByTestId('audit-summary-partial')).not.toBeInTheDocument()
    // A real zero still reads as zero, not as a dash.
    expect(screen.getAllByText('0').length).toBeGreaterThan(0)
    expect(screen.queryByText('—')).not.toBeInTheDocument()
  })
})
