import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'

import { render } from '../../../test/setup'
import { ConnectionsGovernanceSection } from '../governance-section'
import { connectionPoliciesApi, connectionsExpiryApi, connectionsReviewApi, connectionsRotationApi } from '../../../lib/connections-governance-api'

const entitlementState = { granted: false, loading: false }
vi.mock('../../../hooks/use-entitlement', async () => {
  const actual = await vi.importActual<any>('../../../hooks/use-entitlement')
  const list = () => (entitlementState.granted ? ['connections_governance'] : [])
  return {
    ...actual,
    useEntitlement: (feature?: string) => {
      const entitlements = list()
      const has = (f: string) => entitlements.includes(f)
      if (feature === undefined) return { entitlements, has, isLoading: entitlementState.loading, edition: 'enterprise', limit: () => -1 }
      return { enabled: !entitlementState.loading && has(feature), isLoading: entitlementState.loading, edition: 'enterprise' }
    },
    useEntitlements: () => ({ entitlements: list(), has: (f: string) => list().includes(f), isLoading: entitlementState.loading, edition: 'enterprise', limit: () => -1 }),
  }
})

vi.mock('../../../lib/connections-governance-api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/connections-governance-api')>('../../../lib/connections-governance-api')
  return {
    ...actual,
    connectionPoliciesApi: { list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
    connectionsReviewApi: { list: vi.fn(), revokeGrants: vi.fn() },
    connectionsExpiryApi: { list: vi.fn(), enforce: vi.fn() },
    connectionsRotationApi: { candidates: vi.fn(), rotateDue: vi.fn() },
    connectionsAuditExportApi: { download: vi.fn() },
  }
})

vi.mock('../../../lib/connections-api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/connections-api')>('../../../lib/connections-api')
  return {
    ...actual,
    connectorsApi: { list: vi.fn().mockResolvedValue([]), create: vi.fn() },
    connectionsApi: { ...actual.connectionsApi, list: vi.fn().mockResolvedValue([]) },
  }
})

const notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('../../../store/app', () => ({ useNotifications: () => notify }))

describe('ConnectionsGovernanceSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    entitlementState.granted = false
    entitlementState.loading = false
    vi.mocked(connectionPoliciesApi.list).mockResolvedValue([])
    vi.mocked(connectionsReviewApi.list).mockResolvedValue([])
    vi.mocked(connectionsExpiryApi.list).mockResolvedValue({ warn: [], expire: [], enforce: false })
    vi.mocked(connectionsRotationApi.candidates).mockResolvedValue({ due: [], manual: [] })
  })

  it('shows the locked card with upgrade copy when the entitlement is missing', () => {
    render(<ConnectionsGovernanceSection />)
    expect(screen.getByRole('region', { name: 'Governance' })).toBeInTheDocument()
    const locked = screen.getByTestId('governance-locked')
    expect(locked).toHaveTextContent('Connections governance')
    expect(locked).toHaveTextContent(/Upgrade to unlock it for your organization/)
    expect(screen.getByRole('link', { name: /upgrade|view plans/i })).toHaveAttribute('href', '/settings/billing')
    expect(screen.queryByTestId('governance-unlocked')).not.toBeInTheDocument()
    expect(connectionPoliciesApi.list).not.toHaveBeenCalled()
  })

  it('shows a skeleton while entitlements load', () => {
    entitlementState.loading = true
    render(<ConnectionsGovernanceSection />)
    expect(screen.getByTestId('governance-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('governance-locked')).not.toBeInTheDocument()
  })

  it('renders the sub-navigation and switches views when entitled', async () => {
    entitlementState.granted = true
    render(<ConnectionsGovernanceSection />)
    expect(screen.queryByTestId('governance-locked')).not.toBeInTheDocument()
    expect(await screen.findByTestId('policies-panel')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Policies' })).toHaveAttribute('aria-selected', 'true')

    fireEvent.click(screen.getByRole('tab', { name: 'Review' }))
    expect(await screen.findByTestId('review-panel')).toBeInTheDocument()
    expect(connectionsReviewApi.list).toHaveBeenCalledWith('production')

    fireEvent.click(screen.getByRole('tab', { name: 'Expiry and rotation' }))
    expect(await screen.findByTestId('expiry-panel')).toBeInTheDocument()
    expect(await screen.findByTestId('expiring-empty')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Rotate due now' })).toBeInTheDocument()
  })
})
