/**
 * The Credentials pages under a real router: the list (a table, model
 * provider keys as their own group, keys a single API keeps listed too),
 * Add credential (tile, key, checked, listed), a credential's own page,
 * the admins' Advanced tab, and the redirects from where credentials used
 * to live (Connections, Settings > Connections).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'

import { renderAtRoute } from '../../../test/render-at-route'
import { CredentialsPage } from '../../../pages/credentials'
import { AddCredentialPage } from '../../../pages/credential-new'
import { CredentialDetailRoutePage } from '../../../pages/credential-pages'
import { connectionsApi, connectorsApi } from '../../../lib/connections-api'
import { credentialsApi, organizationsApi } from '../../../lib/api'
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
      setSharing: vi.fn(),
    },
    connectionSettingsApi: { setAllowUserScopedConnections: vi.fn().mockResolvedValue({}) },
  }
})

vi.mock('../../../lib/api', () => ({
  organizationsApi: { getById: vi.fn(), getMembers: vi.fn().mockResolvedValue([]), getTeams: vi.fn().mockResolvedValue([]) },
  agentsApi: { getAll: vi.fn().mockResolvedValue([]) },
  workspacesApi: { getAll: vi.fn().mockResolvedValue([]) },
  credentialsApi: { getAll: vi.fn(), getById: vi.fn(), remove: vi.fn() },
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
    connectorDisplayName: 'GitHub',
    kind: 'tool_source',
    owner: 'org',
    accountLabel: 'octocat',
    health: { status: 'valid' },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

/** A key one API keeps for itself: in GET /credentials, not in GET /connections. */
const apiKey = { id: 'cred-api', name: 'Petstore key', type: 'api_key', connectorKey: null, visibility: 'org', createdAt: '2026-08-01T00:00:00.000Z', metadata: { managedBy: { kind: 'api', id: 'api-1' } } }

const PATHS = ['/credentials', '/credentials/new', '/credentials/:id', '/models/providers/new', '/guide', '/gateways', '/apis/:id', '/models']

let openSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(role, { role: 'admin', canManage: true })
  vi.mocked(organizationsApi.getById).mockResolvedValue({ id: 'test-org-id', plan: 'free', settings: {} })
  vi.mocked(connectorsApi.list).mockResolvedValue([github, slack, openai, other, custom])
  vi.mocked(connectionsApi.list).mockResolvedValue([
    connection(),
    connection({ id: 'conn-2', name: 'Acme CRM', connectorKey: 'other', connectorDisplayName: 'Other service', owner: 'private', accountLabel: null, health: { status: 'failed', error: 'refused' } }),
    connection({ id: 'conn-3', name: 'OpenAI', connectorKey: 'openai', connectorDisplayName: 'OpenAI', kind: 'inference', accountLabel: null }),
  ])
  vi.mocked(credentialsApi.getAll).mockResolvedValue([apiKey, { id: 'conn-1', name: 'GitHub', type: 'api_key', connectorKey: 'github' }])
  openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
})

afterEach(() => openSpy.mockRestore())

describe('/credentials', () => {
  const at = (url = '/credentials') => renderAtRoute(<CredentialsPage />, { path: '/credentials', url, paths: PATHS })

  it('lists every credential in a table, with whether it works and who can use it', async () => {
    at()
    const table = await screen.findByTestId('credentials-table')
    const row = (await within(table).findByText('GitHub', { selector: 'span.truncate' })).closest('tr')!
    expect(within(row).getByTestId('credential-status')).toHaveTextContent('Works')
    expect(within(row).getByText('Everyone')).toBeInTheDocument()

    const failing = within(table).getByText('Acme CRM').closest('tr')!
    expect(within(failing).getByTestId('credential-status')).toHaveTextContent('Needs attention')
    expect(within(failing).getByText('Only you')).toBeInTheDocument()
  })

  it('lists the keys a single API keeps too, saying what uses it', async () => {
    at()
    const table = await screen.findByTestId('credentials-table')
    const row = (await within(table).findByText('Petstore key')).closest('tr')!
    expect(within(row).getByText('API key')).toBeInTheDocument()
    expect(within(row).getByText('An API')).toBeInTheDocument()
    // Each credential once: GitHub is in both lists, and shows once.
    expect(within(table).getAllByText('GitHub', { selector: 'span.truncate' })).toHaveLength(1)
  })

  it('includes model provider keys in the one table without a separate group', async () => {
    at()
    const table = await screen.findByTestId('credentials-table')
    expect(await within(table).findByText('OpenAI', { selector: 'span.truncate' })).toBeInTheDocument()
    expect(screen.queryByTestId('model-provider-credentials')).not.toBeInTheDocument()
  })

  it('opens a credential\'s own page from its row', async () => {
    const { router } = at()
    const table = await screen.findByTestId('credentials-table')
    fireEvent.click((await within(table).findByText('Acme CRM')).closest('tr')!)
    await waitFor(() => expect(router.state.location.pathname).toBe('/credentials/conn-2'))
  })

  it('shows an empty state that leads to adding a credential', async () => {
    vi.mocked(connectionsApi.list).mockResolvedValue([])
    vi.mocked(credentialsApi.getAll).mockResolvedValue([])
    at()
    expect(await screen.findByText('No credentials yet')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('link', { name: 'Add credential' })[0])
    expect(await screen.findByText('at /credentials/new')).toBeInTheDocument()
  })

  it('has no Advanced tab for any role', async () => {
    const { unmount } = at()
    await screen.findByTestId('credentials-table')
    expect(screen.queryByRole('tab', { name: 'Advanced' })).not.toBeInTheDocument()
    unmount()
    Object.assign(role, { role: 'member', canManage: false })
    at()
    await screen.findByTestId('credentials-table')
    expect(screen.queryByRole('tab', { name: 'Advanced' })).not.toBeInTheDocument()
  })

  it('opens the credential a sign-in came back with', async () => {
    const { router } = at('/credentials?connection=conn-1&status=connected')
    await waitFor(() => expect(router.state.location.pathname).toBe('/credentials/conn-1'))
  })
})

describe('/credentials/new', () => {
  const at = (url = '/credentials/new') => renderAtRoute(<AddCredentialPage />, { path: '/credentials/new', url, paths: PATHS })

  it('names a credential, chooses its service, saves and opens it', async () => {
    vi.mocked(connectionsApi.connect).mockResolvedValue({ pending: false, connection: connection({ id: 'conn-new', name: 'Production GitHub' }) })
    const { router } = at()
    fireEvent.click(await screen.findByTestId('service-select-trigger'))
    fireEvent.click(screen.getByTestId('service-select-option-github'))
    expect(router.state.location.search).toBe('?service=github')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Production GitHub' } })
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'ghp_123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(connectionsApi.connect).toHaveBeenCalledWith('github', { method: 'api_key', owner: 'org', name: 'Production GitHub', input: { apiKey: 'ghp_123' } }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/credentials/conn-new'))
  })

  it('returns to the caller after saving', async () => {
    vi.mocked(connectionsApi.connect).mockResolvedValue({ pending: false, connection: connection({ id: 'conn-new' }) })
    const { router } = at('/credentials/new?service=github&returnTo=%2Fguide')
    fireEvent.change(await screen.findByLabelText('Token'), { target: { value: 'ghp_123' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'GitHub test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/guide'))
  })

  it('requires a name for a generic key', async () => {
    at('/credentials/new?service=other')
    fireEvent.change(await screen.findByLabelText('Key'), { target: { value: 'acme-secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Give it a name')).toBeInTheDocument()
    expect(connectionsApi.connect).not.toHaveBeenCalled()
  })

  it('searches every service in one list including model providers and Custom', async () => {
    at()
    fireEvent.click(await screen.findByTestId('service-select-trigger'))
    expect(screen.getByTestId('service-select-option-model:openai')).toBeInTheDocument()
    expect(screen.getByTestId('service-select-option-custom')).toBeInTheDocument()
    expect(screen.queryByTestId('service-select-option-channel-slack')).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search services' }), { target: { value: 'github' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option')).toHaveTextContent('GitHub')
  })
})

describe('/credentials/:id', () => {
  const at = (id = 'conn-1') => renderAtRoute(<CredentialDetailRoutePage />, { path: '/credentials/:id', url: `/credentials/${id}`, paths: PATHS })

  it('has the detail header, and shows whether it works, the account, the key and who can use it', async () => {
    vi.mocked(connectionsApi.list).mockResolvedValue([connection({ health: { status: 'expired', error: 'token expired' } })])
    at()
    expect(await screen.findByRole('heading', { name: 'GitHub' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Credentials' })).toHaveAttribute('href', '/credentials')
    expect(screen.getByTestId('credential-status')).toHaveTextContent('Needs attention')
    expect(screen.getByTestId('credential-last-error')).toHaveTextContent('token expired')
    expect(screen.getByText('octocat')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Overview' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Used by/ })).toBeInTheDocument()
    expect(screen.getByTestId('who-can-use')).toHaveTextContent('Everyone')
    expect(screen.queryByRole('link', { name: 'Advanced' })).not.toBeInTheDocument()
  })

  it('checks again and says the answer', async () => {
    vi.mocked(connectionsApi.validate).mockResolvedValue(connection({ health: { status: 'valid' } }))
    at()
    fireEvent.click(await screen.findByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(connectionsApi.validate).toHaveBeenCalledWith('conn-1'))
    expect(await screen.findByTestId('credential-check-result')).toHaveTextContent('Works.')
  })

  it('replaces the key in place', async () => {
    vi.mocked(connectionsApi.rotate).mockResolvedValue({ pending: false, connection: connection() })
    at()
    fireEvent.click(await screen.findByRole('button', { name: 'Replace key' }))
    fireEvent.change(await screen.findByLabelText('Token'), { target: { value: 'ghp_new' } })
    fireEvent.click(screen.getByRole('button', { name: 'Replace key' }))
    await waitFor(() => expect(connectionsApi.rotate).toHaveBeenCalledWith('conn-1', { input: { apiKey: 'ghp_new' } }))
    expect(await screen.findByTestId('credential-check-result')).toHaveTextContent('New key saved. Works.')
  })

  it('deletes after a one-line confirm and returns to the list', async () => {
    vi.mocked(connectionsApi.remove).mockResolvedValue({ revoked: true })
    at()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete credential' }))
    const confirm = await screen.findByRole('alertdialog')
    expect(within(confirm).getByText('Delete GitHub?')).toBeInTheDocument()
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(connectionsApi.remove).toHaveBeenCalledWith('conn-1'))
    expect(await screen.findByText('at /credentials')).toBeInTheDocument()
  })

  it('changes who can use a private credential in place, as on a provider connection', async () => {
    vi.mocked(connectionsApi.setSharing).mockResolvedValue(connection({ id: 'conn-2', owner: 'org' }))
    at('conn-2')
    expect(await screen.findByRole('heading', { name: 'Acme CRM' })).toBeInTheDocument()
    const line = screen.getByTestId('who-can-use')
    expect(line).toHaveTextContent('Only you')
    fireEvent.click(within(line).getByRole('button', { name: 'Change' }))
    for (const name of [/^Only you/, /^Everyone/]) expect(screen.getByRole('radio', { name })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: /^Everyone/ }))
    await waitFor(() => expect(connectionsApi.setSharing).toHaveBeenCalledWith('conn-2', { owner: 'org' }))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    // The grants editor is its own link, not a second "Change".
    expect(screen.queryByRole('link', { name: 'Change' })).not.toBeInTheDocument()
  })

  it('shares it with one team, sending the team', async () => {
    vi.mocked(organizationsApi.getTeams).mockResolvedValue([{ id: 'team-1', name: 'Support', isDefault: false }])
    vi.mocked(connectionsApi.setSharing).mockResolvedValue(connection({ id: 'conn-2', owner: 'team', teamId: 'team-1' }))
    at('conn-2')
    fireEvent.click(within(await screen.findByTestId('who-can-use')).getByRole('button', { name: 'Change' }))
    await waitFor(() => expect(screen.getByRole('radio', { name: /^One team/ })).toBeEnabled())
    fireEvent.click(screen.getByRole('radio', { name: /^One team/ }))
    await waitFor(() => expect(connectionsApi.setSharing).toHaveBeenCalledWith('conn-2', { owner: 'team', teamId: 'team-1' }))
    vi.mocked(organizationsApi.getTeams).mockResolvedValue([])
  })

  it('leaves the key a provider connection keeps to that connection', async () => {
    vi.mocked(connectionsApi.list).mockResolvedValue([connection({ providerId: 'p1' })])
    at()
    const line = await screen.findByTestId('who-can-use')
    expect(within(line).queryByRole('button', { name: 'Change' })).not.toBeInTheDocument()
  })

  it('shows a key a single API keeps, and where it is changed', async () => {
    vi.mocked(credentialsApi.getById).mockResolvedValue(apiKey)
    at('cred-api')
    expect(await screen.findByRole('heading', { name: 'Petstore key' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Change it where it is used' })).toHaveAttribute('href', '/apis/api-1')
    fireEvent.click(screen.getByRole('button', { name: 'Delete credential' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(credentialsApi.remove).toHaveBeenCalledWith('cred-api'))
    expect(await screen.findByText('at /credentials')).toBeInTheDocument()
  })

  it('says so when the credential is gone', async () => {
    vi.mocked(credentialsApi.getById).mockRejectedValue(new Error('404'))
    at('nope')
    expect(await screen.findByText(/This credential is gone/)).toBeInTheDocument()
  })
})

