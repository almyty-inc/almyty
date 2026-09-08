import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'

import { render } from '../../../test/setup'
import { ConnectionsTab } from '../connections-tab'
import { connectionSettingsApi, connectionsApi, connectorsApi } from '../../../lib/connections-api'
import { organizationsApi } from '../../../lib/api'
import type { Connection, Connector } from '@/types/connections'

vi.mock('../../../lib/connections-api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/connections-api')>('../../../lib/connections-api')
  return {
    ...actual,
    connectorsApi: { list: vi.fn(), create: vi.fn() },
    connectionsApi: {
      list: vi.fn(),
      get: vi.fn(),
      connect: vi.fn(),
      complete: vi.fn(),
      validate: vi.fn(),
      rotate: vi.fn(),
      remove: vi.fn(),
      listGrants: vi.fn().mockResolvedValue([]),
      addGrant: vi.fn(),
      removeGrant: vi.fn(),
    },
    connectionSettingsApi: { setAllowUserScopedConnections: vi.fn() },
  }
})

vi.mock('../../../lib/api', () => ({
  organizationsApi: { getById: vi.fn(), getMembers: vi.fn().mockResolvedValue([]), getTeams: vi.fn().mockResolvedValue([]) },
  agentsApi: { getAll: vi.fn().mockResolvedValue([]) },
  workspacesApi: { getAll: vi.fn().mockResolvedValue([]) },
}))

const notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('../../../store/app', () => ({
  useNotifications: () => notify,
}))

vi.mock('../../../store/organization', () => ({
  useOrganizationStore: (selector?: (s: any) => any) => {
    const state = { currentOrganization: { id: 'test-org-id', name: 'Test Org' } }
    return selector ? selector(state) : state
  },
}))

// The governance section at the bottom reads the entitlement; locked by default here.
const entitlementState = { granted: false }
vi.mock('../../../hooks/use-entitlement', async () => {
  const actual = await vi.importActual<any>('../../../hooks/use-entitlement')
  const list = () => (entitlementState.granted ? ['connections_governance'] : [])
  return {
    ...actual,
    useEntitlement: (feature?: string) => {
      const entitlements = list()
      const has = (f: string) => entitlements.includes(f)
      if (feature === undefined) return { entitlements, has, isLoading: false, edition: 'enterprise', limit: () => -1 }
      return { enabled: has(feature), isLoading: false, edition: 'enterprise' }
    },
    useEntitlements: () => ({ entitlements: list(), has: (f: string) => list().includes(f), isLoading: false, edition: 'enterprise', limit: () => -1 }),
  }
})

vi.mock('../../../lib/connections-governance-api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/connections-governance-api')>('../../../lib/connections-governance-api')
  return {
    ...actual,
    connectionPoliciesApi: { list: vi.fn().mockResolvedValue([]), get: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
    connectionsReviewApi: { list: vi.fn().mockResolvedValue([]), revokeGrants: vi.fn() },
    connectionsExpiryApi: { list: vi.fn(), enforce: vi.fn() },
    connectionsRotationApi: { candidates: vi.fn(), rotateDue: vi.fn() },
    connectionsAuditExportApi: { download: vi.fn() },
  }
})

const openai: Connector = { key: 'openai', kind: 'inference', displayName: 'OpenAI', description: 'GPT models', connect: [{ type: 'api_key', label: 'API key', schema: { type: 'object', properties: { apiKey: { type: 'string', 'x-secret': true } }, required: ['apiKey'] } }] }
const slack: Connector = { key: 'slack', kind: 'channel', displayName: 'Slack', connect: [{ type: 'oauth2_code', label: 'Add to Slack' }] }
const vllm: Connector = { key: 'office-vllm', kind: 'inference', displayName: 'Office vLLM', connect: [{ type: 'api_key' }], organizationId: 'test-org-id' }

function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'conn-1',
    name: 'OpenAI prod',
    connectorKey: 'openai',
    kind: 'inference',
    owner: 'org',
    accountLabel: 'org-acme',
    health: { status: 'valid', checkedAt: '2026-09-08T10:00:00.000Z' },
    scopesGranted: ['models.read', 'chat'],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('ConnectionsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(connectorsApi.list).mockResolvedValue([slack, openai, vllm])
    vi.mocked(connectionsApi.list).mockResolvedValue([
      connection(),
      connection({ id: 'conn-2', name: 'My Slack', connectorKey: 'slack', kind: 'channel', owner: 'user', ownerUserId: 'u1', accountLabel: 'acme.slack.com', health: { status: 'expired', error: 'token expired' }, scopesGranted: [] }),
    ])
    vi.mocked(organizationsApi.getById).mockResolvedValue({ id: 'test-org-id', plan: 'pro', settings: { allowUserScopedConnections: true } })
  })

  it('groups connectors by kind in gallery order with their connections, health, owner and scopes', async () => {
    render(<ConnectionsTab />)

    const inference = await screen.findByRole('region', { name: 'Inference' })
    const channels = await screen.findByRole('region', { name: 'Channels' })
    const sections = screen.getAllByRole('region')
    expect(sections.indexOf(inference)).toBeLessThan(sections.indexOf(channels))

    const openaiCard = within(inference).getByTestId('connector-card-openai')
    expect(openaiCard).toHaveTextContent('OpenAI prod')
    expect(openaiCard).toHaveTextContent('org-acme')
    expect(openaiCard).toHaveTextContent('2 scopes')
    expect(within(openaiCard).getByTestId('connection-health')).toHaveAttribute('data-status', 'valid')
    expect(within(openaiCard).getByRole('button', { name: 'Connect OpenAI' })).toHaveTextContent('API key')

    const vllmCard = within(inference).getByTestId('connector-card-office-vllm')
    expect(vllmCard).toHaveTextContent('custom')
    expect(vllmCard).toHaveTextContent('Not connected')

    const slackCard = within(channels).getByTestId('connector-card-slack')
    expect(slackCard).toHaveTextContent('personal')
    expect(within(slackCard).getByTestId('connection-health')).toHaveAttribute('data-status', 'expired')
    expect(within(slackCard).getByRole('button', { name: 'Connect Slack' })).toHaveTextContent('Add to Slack')
  })

  it('filters the gallery by search across connectors and connection names', async () => {
    render(<ConnectionsTab />)
    await screen.findByTestId('connector-card-openai')

    fireEvent.change(screen.getByLabelText('Search connections'), { target: { value: 'my slack' } })
    await waitFor(() => expect(screen.queryByTestId('connector-card-openai')).not.toBeInTheDocument())
    expect(screen.getByTestId('connector-card-slack')).toBeInTheDocument()
  })

  it('opens the detail sheet with health, last error and actions', async () => {
    render(<ConnectionsTab />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open My Slack' }))

    expect(await screen.findByTestId('connection-last-error')).toHaveTextContent('token expired')
    expect(screen.getByRole('button', { name: 'Validate' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Rotate' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Who can use it' })).toBeInTheDocument()
  })

  it('disconnects after confirming and refreshes the list', async () => {
    vi.mocked(connectionsApi.remove).mockResolvedValue({ revoked: true })
    render(<ConnectionsTab />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open OpenAI prod' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }))
    expect(await screen.findByText('Disconnect OpenAI prod?')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Disconnect' }).at(-1)!)

    await waitFor(() => expect(connectionsApi.remove).toHaveBeenCalledWith('conn-1'))
    await waitFor(() => expect(notify.success).toHaveBeenCalledWith('Disconnected', expect.any(String)))
  })

  it('reads the org toggle from settings and patches it', async () => {
    vi.mocked(connectionSettingsApi.setAllowUserScopedConnections).mockResolvedValue({})
    render(<ConnectionsTab />)

    const toggle = await screen.findByRole('switch', { name: 'Allow user-scoped connections' })
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
    expect(screen.getByText(/Default on for personal orgs, off for production orgs/)).toBeInTheDocument()

    fireEvent.click(toggle)
    await waitFor(() => expect(connectionSettingsApi.setAllowUserScopedConnections).toHaveBeenCalledWith('test-org-id', false))
  })

  it('falls back to the plan default when the setting is unset', async () => {
    vi.mocked(organizationsApi.getById).mockResolvedValue({ id: 'test-org-id', plan: 'enterprise', settings: {} })
    render(<ConnectionsTab />)
    const toggle = await screen.findByRole('switch', { name: 'Allow user-scoped connections' })
    await waitFor(() => expect(organizationsApi.getById).toHaveBeenCalled())
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'))
  })

  it('shows the governance section locked without the entitlement', async () => {
    entitlementState.granted = false
    render(<ConnectionsTab />)
    await screen.findByTestId('connector-card-openai')
    const governance = screen.getByRole('region', { name: 'Governance' })
    expect(within(governance).getByTestId('governance-locked')).toHaveTextContent('Connections governance')
    expect(within(governance).queryByRole('tab', { name: 'Policies' })).not.toBeInTheDocument()
  })

  it('shows the governance sub-navigation with the entitlement', async () => {
    entitlementState.granted = true
    try {
      render(<ConnectionsTab />)
      await screen.findByTestId('connector-card-openai')
      const governance = screen.getByRole('region', { name: 'Governance' })
      expect(within(governance).getByRole('tab', { name: 'Policies' })).toHaveAttribute('aria-selected', 'true')
      expect(await within(governance).findByText('No policies yet')).toBeInTheDocument()
    } finally {
      entitlementState.granted = false
    }
  })
})
