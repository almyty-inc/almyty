/**
 * The Connections pages under a real router: the list, connect a service
 * (tile, key, checked, listed), a connection's own page, the admins'
 * Advanced tab, and the redirects from Credentials and Settings >
 * Connections.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'

import { renderAtRoute } from '../../../test/render-at-route'
import { ConnectionsPage } from '../../../pages/connections'
import { ConnectServicePage } from '../../../pages/connections-connect'
import { ConnectionDetailRoutePage, CredentialsRedirect, SettingsConnectionsRedirect, credentialsTarget, settingsConnectionsTarget } from '../../../pages/connection-pages'
import { connectionsApi, connectorsApi } from '../../../lib/connections-api'
import { organizationsApi } from '../../../lib/api'
import type { Connection, Connector } from '@/types/connections'

vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

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
    connectionSettingsApi: { setAllowUserScopedConnections: vi.fn().mockResolvedValue({}) },
  }
})

vi.mock('../../../lib/api', () => ({
  organizationsApi: { getById: vi.fn(), getMembers: vi.fn().mockResolvedValue([]), getTeams: vi.fn().mockResolvedValue([]) },
  agentsApi: { getAll: vi.fn().mockResolvedValue([]) },
  workspacesApi: { getAll: vi.fn().mockResolvedValue([]) },
}))

// Governance is its own feature with its own tests; here it is a marker.
vi.mock('../../connections-governance/governance-section', () => ({ ConnectionsGovernanceSection: () => <div data-testid="governance-marker" /> }))
vi.mock('../../onboarding/page-intro', () => ({ PageIntro: () => null }))

const notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('../../../store/app', () => ({ useNotifications: () => notify }))
vi.mock('../../../store/organization', () => ({
  useOrganizationStore: (selector?: (s: any) => any) => {
    const state = { currentOrganization: { id: 'test-org-id', name: 'Test Org' } }
    return selector ? selector(state) : state
  },
}))

const role = { role: 'admin' as string | null, canManage: true, isOwner: false }
vi.mock('../../../hooks/use-organization-role', () => ({ useOrganizationRole: () => role }))

const github: Connector = {
  key: 'github',
  kind: 'tool_source',
  displayName: 'GitHub',
  keyPageUrl: 'https://github.com/settings/tokens',
  validation: { kind: 'http' },
  connect: [{ type: 'api_key', label: 'Token', schema: { type: 'object', properties: { apiKey: { type: 'string', title: 'Token', 'x-secret': true } }, required: ['apiKey'] } }],
}
const slack: Connector = { key: 'channel-slack', kind: 'channel', displayName: 'Slack', connect: [{ type: 'oauth2_code', label: 'Add to Slack' }] }
const openai: Connector = { key: 'openai', kind: 'inference', providerType: 'openai', displayName: 'OpenAI', connect: [{ type: 'api_key', schema: { type: 'object', properties: { apiKey: { type: 'string', title: 'API key', 'x-secret': true } }, required: ['apiKey'] } }] }
const other: Connector = {
  key: 'other',
  kind: 'tool_source',
  displayName: 'Other service',
  validation: { kind: 'format' },
  connect: [{ type: 'api_key', label: 'Key', schema: { type: 'object', properties: { apiKey: { type: 'string', title: 'Key', 'x-secret': true } }, required: ['apiKey'] } }],
}
const custom: Connector = { ...github, key: 'office-vllm', displayName: 'Office vLLM', organizationId: 'test-org-id' }

function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'conn-1',
    name: 'GitHub',
    connectorKey: 'github',
    kind: 'tool_source',
    owner: 'org',
    accountLabel: 'octocat',
    health: { status: 'valid' },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

const PATHS = ['/connections', '/connections/advanced', '/connections/connect', '/connections/:id', '/models/connect', '/guide', '/gateways']

let openSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(role, { role: 'admin', canManage: true })
  vi.mocked(organizationsApi.getById).mockResolvedValue({ id: 'test-org-id', plan: 'free', settings: {} })
  vi.mocked(connectorsApi.list).mockResolvedValue([github, slack, openai, other, custom])
  vi.mocked(connectionsApi.list).mockResolvedValue([connection(), connection({ id: 'conn-2', name: 'Acme CRM', connectorKey: 'other', owner: 'private', accountLabel: null, health: { status: 'failed', error: 'refused' } })])
  openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
})

afterEach(() => openSpy.mockRestore())

describe('/connections', () => {
  const at = (url = '/connections') => renderAtRoute(<ConnectionsPage />, { path: '/connections', url, paths: PATHS })

  it('lists each connected service with whether it works, the account and who can use it', async () => {
    at()
    const card = await screen.findByTestId('connection-card-conn-1')
    expect(card).toHaveAttribute('href', '/connections/conn-1')
    expect(within(card).getByText('GitHub')).toBeInTheDocument()
    expect(within(card).getByTestId('connection-status')).toHaveTextContent('Works')
    expect(within(card).getByText('octocat')).toBeInTheDocument()
    expect(within(card).getByTestId('connection-who')).toHaveTextContent('Everyone')

    const failing = screen.getByTestId('connection-card-conn-2')
    expect(within(failing).getByTestId('connection-status')).toHaveTextContent('Needs attention')
    expect(within(failing).getByTestId('connection-who')).toHaveTextContent('Only you')
  })

  it('shows an empty state that leads to connecting a service', async () => {
    vi.mocked(connectionsApi.list).mockResolvedValue([])
    at()
    expect(await screen.findByText('Nothing connected yet')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('link', { name: 'Connect a service' })[0])
    expect(await screen.findByText('at /connections/connect')).toBeInTheDocument()
  })

  it('gives admins an Advanced tab, and nobody else', async () => {
    const { unmount } = at()
    await screen.findByTestId('connection-card-conn-1')
    expect(screen.getByRole('tab', { name: 'Advanced' })).toBeInTheDocument()
    unmount()

    Object.assign(role, { role: 'member', canManage: false })
    at()
    await screen.findByTestId('connection-card-conn-1')
    expect(screen.queryByRole('tab', { name: 'Advanced' })).not.toBeInTheDocument()
  })

  it('sends a member who opens Advanced back to the list', async () => {
    Object.assign(role, { role: 'member', canManage: false })
    const { router } = renderAtRoute(<ConnectionsPage />, { path: '/connections/advanced', paths: PATHS })
    await waitFor(() => expect(router.state.location.pathname).toBe('/connections'))
    expect(screen.queryByTestId('connections-advanced')).not.toBeInTheDocument()
  })

  it('opens the connection a sign-in came back with', async () => {
    const { router } = at('/connections?connection=conn-1&status=connected')
    await waitFor(() => expect(router.state.location.pathname).toBe('/connections/conn-1'))
  })
})

describe('/connections/advanced', () => {
  const at = (url = '/connections/advanced') => renderAtRoute(<ConnectionsPage />, { path: '/connections/advanced', url, paths: PATHS })

  it('holds who can use each connection, personal keys, custom services and the rules', async () => {
    at('/connections/advanced?connection=conn-1')
    expect(await screen.findByTestId('connections-advanced')).toBeInTheDocument()
    // The grants of the connection named in the URL.
    await waitFor(() => expect(connectionsApi.listGrants).toHaveBeenCalledWith('conn-1'))
    expect(screen.getByRole('switch', { name: 'Allow personal keys' })).toBeInTheDocument()
    expect(await screen.findByText('Office vLLM')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Add a custom service' })).toHaveAttribute('href', '/connections/custom/new')
    expect(screen.getByTestId('governance-marker')).toBeInTheDocument()
  })

  it('never offers a private connection for sharing', async () => {
    at()
    await screen.findByTestId('connections-advanced')
    fireEvent.click(screen.getByRole('combobox', { name: 'Connection' }))
    expect(await screen.findByRole('option', { name: 'GitHub' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Acme CRM' })).not.toBeInTheDocument()
  })
})

describe('/connections/connect', () => {
  const at = (url = '/connections/connect') => renderAtRoute(<ConnectServicePage />, { path: '/connections/connect', url, paths: PATHS })

  it('goes tile, key, checked, listed', async () => {
    let resolve!: (v: unknown) => void
    vi.mocked(connectionsApi.connect).mockReturnValue(new Promise((r) => (resolve = r)))
    const { router } = at()
    fireEvent.click(await screen.findByTestId('service-tile-github'))
    expect(router.state.location.search).toBe('?service=github')

    const form = await screen.findByRole('form', { name: 'Connect GitHub' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // No name, no type, no description: the key and who can use it.
    expect(form.querySelectorAll('input')).toHaveLength(1)
    expect(within(form).queryByLabelText(/^Type/)).not.toBeInTheDocument()
    expect(within(form).queryByLabelText(/^Name/)).not.toBeInTheDocument()
    expect(within(form).getByTestId('who-can-use')).toHaveTextContent('everyone in your organization')

    fireEvent.change(within(form).getByLabelText('Token'), { target: { value: 'ghp_123' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Connect' }))
    expect(await screen.findByRole('button', { name: /Checking your key/ })).toBeDisabled()
    expect(connectionsApi.connect).toHaveBeenCalledWith('github', { method: 'api_key', owner: 'org', input: { apiKey: 'ghp_123' } })

    resolve({ pending: false, connection: connection({ id: 'conn-new' }) })
    const done = await screen.findByTestId('connect-success')
    expect(done).toHaveTextContent('GitHub is connected.')
    expect(within(done).getByTestId('connection-status')).toHaveTextContent('Works')
    fireEvent.click(within(done).getByRole('button', { name: 'Done' }))
    expect(await screen.findByText('at /connections')).toBeInTheDocument()
  })

  it('opens the new connection from the result, or returns to a same-origin returnTo', async () => {
    vi.mocked(connectionsApi.connect).mockResolvedValue({ pending: false, connection: connection({ id: 'conn-new' }) })
    const { unmount } = at('/connections/connect?service=github')
    fireEvent.change(await screen.findByLabelText('Token'), { target: { value: 'ghp_123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Open connection' }))
    expect(await screen.findByText('at /connections/conn-new')).toBeInTheDocument()
    unmount()

    at('/connections/connect?service=github&returnTo=%2Fguide')
    fireEvent.change(await screen.findByLabelText('Token'), { target: { value: 'ghp_123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Done' }))
    expect(await screen.findByText('at /guide')).toBeInTheDocument()
  })

  it('connects a sign-in service with its Connect button', async () => {
    vi.mocked(connectionsApi.connect).mockResolvedValue({ pending: true, method: 'oauth2_code', mode: 'browser', authorizeUrl: 'https://slack.com/oauth?state=s', state: 's', expiresInSeconds: 600, completeWith: 'callback' })
    vi.mocked(connectionsApi.list).mockResolvedValue([])
    at('/connections/connect?service=channel-slack')
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(connectionsApi.connect).toHaveBeenCalledWith('channel-slack', { method: 'oauth2_code', owner: 'org' }))
    expect(openSpy).toHaveBeenCalledWith('https://slack.com/oauth?state=s', '_blank', 'noopener')
    expect(await screen.findByTestId('oauth-waiting')).toHaveTextContent('Waiting for Slack')
  })

  it('saves any other key under a name, and says it was saved rather than that it works', async () => {
    vi.mocked(connectionsApi.connect).mockResolvedValue({ pending: false, connection: connection({ id: 'conn-acme', name: 'Acme CRM', connectorKey: 'other', accountLabel: null }) })
    at()
    fireEvent.click(await screen.findByTestId('service-tile-other'))
    const form = await screen.findByRole('form', { name: 'Connect Other service' })
    fireEvent.click(within(form).getByRole('button', { name: 'Connect' }))
    expect(await within(form).findByText('Give it a name you will recognise')).toBeInTheDocument()
    expect(connectionsApi.connect).not.toHaveBeenCalled()

    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Acme CRM' } })
    fireEvent.change(within(form).getByLabelText('Key'), { target: { value: 'acme-secret' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(connectionsApi.connect).toHaveBeenCalledWith('other', { method: 'api_key', owner: 'org', name: 'Acme CRM', input: { apiKey: 'acme-secret' } }))
    expect(within(await screen.findByTestId('connect-success')).getByTestId('connection-status')).toHaveTextContent('Saved')
  })

  it('offers "other service" when a search finds nothing', async () => {
    const { router } = at()
    fireEvent.change(await screen.findByRole('textbox', { name: 'Search services' }), { target: { value: 'zzzz' } })
    expect(screen.queryByTestId('service-tile-github')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save its key as another service' }))
    expect(router.state.location.search).toBe('?service=other')
  })

  it('sends an AI model provider to Models, where its models come with it', async () => {
    const { router } = at()
    fireEvent.click(await screen.findByTestId('service-tile-openai'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/models/connect'))
    expect(router.state.location.search).toBe('?type=openai')
  })
})

describe('/connections/:id', () => {
  const at = (id = 'conn-1') => renderAtRoute(<ConnectionDetailRoutePage />, { path: '/connections/:id', url: `/connections/${id}`, paths: PATHS })

  it('shows whether it works, the account, the key and who can use it', async () => {
    vi.mocked(connectionsApi.list).mockResolvedValue([connection({ health: { status: 'expired', error: 'token expired' } })])
    at()
    expect(await screen.findByRole('heading', { name: 'GitHub' })).toBeInTheDocument()
    expect(screen.getByTestId('connection-status')).toHaveTextContent('Needs attention')
    expect(screen.getByTestId('connection-last-error')).toHaveTextContent('token expired')
    expect(screen.getByText('octocat')).toBeInTheDocument()
    expect(screen.getByTestId('who-can-use')).toHaveTextContent('everyone in your organization')
    expect(screen.getByRole('link', { name: 'Change' })).toHaveAttribute('href', '/connections/advanced?connection=conn-1')
  })

  it('checks again and says the answer', async () => {
    vi.mocked(connectionsApi.validate).mockResolvedValue(connection({ health: { status: 'valid' } }))
    at()
    fireEvent.click(await screen.findByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(connectionsApi.validate).toHaveBeenCalledWith('conn-1'))
    expect(await screen.findByTestId('connection-check-result')).toHaveTextContent('Works.')
  })

  it('replaces the key in place', async () => {
    vi.mocked(connectionsApi.rotate).mockResolvedValue({ pending: false, connection: connection() })
    at()
    fireEvent.click(await screen.findByRole('button', { name: 'Replace key' }))
    fireEvent.change(await screen.findByLabelText('Token'), { target: { value: 'ghp_new' } })
    fireEvent.click(screen.getByRole('button', { name: 'Replace key' }))
    await waitFor(() => expect(connectionsApi.rotate).toHaveBeenCalledWith('conn-1', { input: { apiKey: 'ghp_new' } }))
    expect(await screen.findByTestId('connection-check-result')).toHaveTextContent('New key saved. Works.')
  })

  it('disconnects after a one-line confirm and returns to the list', async () => {
    vi.mocked(connectionsApi.remove).mockResolvedValue({ revoked: true })
    at()
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }))
    const confirm = await screen.findByRole('alertdialog')
    expect(within(confirm).getByText('Disconnect GitHub?')).toBeInTheDocument()
    fireEvent.click(within(confirm).getByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(connectionsApi.remove).toHaveBeenCalledWith('conn-1'))
    expect(await screen.findByText('at /connections')).toBeInTheDocument()
  })

  it('offers no change of who can use a private connection', async () => {
    at('conn-2')
    expect(await screen.findByRole('heading', { name: 'Acme CRM' })).toBeInTheDocument()
    expect(screen.getByTestId('who-can-use')).toHaveTextContent('only you')
    expect(screen.queryByRole('link', { name: 'Change' })).not.toBeInTheDocument()
  })

  it('says so when the connection is gone', async () => {
    at('nope')
    expect(await screen.findByText(/This connection is gone/)).toBeInTheDocument()
  })
})

describe('where connections and credentials used to live', () => {
  it('maps every Settings > Connections address onto Connections', () => {
    expect(settingsConnectionsTarget('/settings/connections', '')).toBe('/connections')
    expect(settingsConnectionsTarget('/settings/connections/connect', '')).toBe('/connections/connect')
    expect(settingsConnectionsTarget('/settings/connections/connect/github', '?returnTo=%2Fguide')).toBe('/connections/connect?service=github&returnTo=%2Fguide')
    expect(settingsConnectionsTarget('/settings/connections/custom/new', '')).toBe('/connections/custom/new')
    expect(settingsConnectionsTarget('/settings/connections/policies/p1', '')).toBe('/connections/policies/p1')
    expect(settingsConnectionsTarget('/settings/connections/conn-1', '')).toBe('/connections/conn-1')
  })

  it('maps Credentials onto Connections, and access keys onto the gateways they unlock', () => {
    expect(credentialsTarget('/credentials')).toBe('/connections')
    expect(credentialsTarget('/credentials/new')).toBe('/connections/connect?service=other')
    expect(credentialsTarget('/credentials/access-keys')).toBe('/gateways')
    expect(credentialsTarget('/credentials/access-keys/new')).toBe('/gateways')
  })

  it('redirects under a router', async () => {
    const settings = renderAtRoute(<SettingsConnectionsRedirect />, { path: '/settings/connections/*', url: '/settings/connections/conn-1', paths: PATHS })
    await waitFor(() => expect(settings.router.state.location.pathname).toBe('/connections/conn-1'))
    settings.unmount()
    const creds = renderAtRoute(<CredentialsRedirect />, { path: '/credentials/*', url: '/credentials', paths: PATHS })
    await waitFor(() => expect(creds.router.state.location.pathname).toBe('/connections'))
  })
})
