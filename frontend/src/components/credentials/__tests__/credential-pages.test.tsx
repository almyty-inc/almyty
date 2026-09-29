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
import { AccessKeysRedirect, CredentialDetailRoutePage, OldCredentialsAddressRedirect, credentialsTarget } from '../../../pages/credential-pages'
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

const PATHS = ['/credentials', '/credentials/advanced', '/credentials/new', '/credentials/:id', '/credentials/providers/new', '/guide', '/gateways', '/apis/:id', '/models']

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

  it('shows model provider connections as their own group, connected from here, with the catalog one link away', async () => {
    at()
    const group = await screen.findByTestId('model-provider-credentials')
    expect(await within(group).findByText('OpenAI', { selector: 'span.truncate' })).toBeInTheDocument()
    expect(within(group).getByRole('link', { name: /Connect a provider/ })).toHaveAttribute('href', '/credentials/providers/new')
    expect(within(group).getByRole('link', { name: 'Models catalog' })).toHaveAttribute('href', '/models')
    expect(within(screen.getByTestId('credentials-table')).queryByText('OpenAI', { selector: 'span.truncate' })).not.toBeInTheDocument()
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

  it('gives admins an Advanced tab, and nobody else', async () => {
    const { unmount } = at()
    await screen.findByTestId('credentials-table')
    expect(screen.getByRole('tab', { name: 'Advanced' })).toBeInTheDocument()
    unmount()

    Object.assign(role, { role: 'member', canManage: false })
    at()
    await screen.findByTestId('credentials-table')
    expect(screen.queryByRole('tab', { name: 'Advanced' })).not.toBeInTheDocument()
  })

  it('sends a member who opens Advanced back to the list', async () => {
    Object.assign(role, { role: 'member', canManage: false })
    const { router } = renderAtRoute(<CredentialsPage />, { path: '/credentials/advanced', paths: PATHS })
    await waitFor(() => expect(router.state.location.pathname).toBe('/credentials'))
    expect(screen.queryByTestId('connections-advanced')).not.toBeInTheDocument()
  })

  it('opens the credential a sign-in came back with', async () => {
    const { router } = at('/credentials?connection=conn-1&status=connected')
    await waitFor(() => expect(router.state.location.pathname).toBe('/credentials/conn-1'))
  })
})

describe('/credentials/advanced', () => {
  const at = (url = '/credentials/advanced') => renderAtRoute(<CredentialsPage />, { path: '/credentials/advanced', url, paths: PATHS })

  it('holds who can use each credential, personal keys, custom services and the rules', async () => {
    at('/credentials/advanced?credential=conn-1')
    expect(await screen.findByTestId('connections-advanced')).toBeInTheDocument()
    // The grants of the credential named in the URL.
    await waitFor(() => expect(connectionsApi.listGrants).toHaveBeenCalledWith('conn-1'))
    expect(screen.getByRole('switch', { name: 'Allow personal keys' })).toBeInTheDocument()
    expect(await screen.findByText('Office vLLM')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Add a custom service' })).toHaveAttribute('href', '/credentials/custom/new')
    expect(screen.getByTestId('governance-marker')).toBeInTheDocument()
  })

  it('never offers a private credential for sharing', async () => {
    at()
    await screen.findByTestId('connections-advanced')
    fireEvent.click(screen.getByRole('combobox', { name: 'Credential' }))
    expect(await screen.findByRole('option', { name: 'GitHub' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Acme CRM' })).not.toBeInTheDocument()
  })
})

describe('/credentials/new', () => {
  const at = (url = '/credentials/new') => renderAtRoute(<AddCredentialPage />, { path: '/credentials/new', url, paths: PATHS })

  it('goes tile, key, checked, listed', async () => {
    let resolve!: (v: unknown) => void
    vi.mocked(connectionsApi.connect).mockReturnValue(new Promise((r) => (resolve = r)))
    const { router } = at()
    expect(await screen.findByRole('heading', { name: 'Add credential' })).toBeInTheDocument()
    fireEvent.click(await screen.findByTestId('service-tile-github'))
    expect(router.state.location.search).toBe('?service=github')

    const form = await screen.findByRole('form', { name: 'Add GitHub' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // No name, no type, no description: the key and who can use it.
    expect(form.querySelectorAll('input')).toHaveLength(1)
    expect(within(form).queryByLabelText(/^Type/)).not.toBeInTheDocument()
    expect(within(form).queryByLabelText(/^Name/)).not.toBeInTheDocument()
    expect(within(form).getByTestId('who-can-use')).toHaveTextContent('everyone in your organization')

    fireEvent.change(within(form).getByLabelText('Token'), { target: { value: 'ghp_123' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('button', { name: /Checking your key/ })).toBeDisabled()
    expect(connectionsApi.connect).toHaveBeenCalledWith('github', { method: 'api_key', owner: 'org', input: { apiKey: 'ghp_123' } })

    resolve({ pending: false, connection: connection({ id: 'conn-new' }) })
    const done = await screen.findByTestId('connect-success')
    expect(done).toHaveTextContent('GitHub is saved.')
    expect(within(done).getByTestId('connection-status')).toHaveTextContent('Works')
    fireEvent.click(within(done).getByRole('button', { name: 'Done' }))
    expect(await screen.findByText('at /credentials')).toBeInTheDocument()
  })

  it('opens the new credential from the result, or returns to a same-origin returnTo', async () => {
    vi.mocked(connectionsApi.connect).mockResolvedValue({ pending: false, connection: connection({ id: 'conn-new' }) })
    const { unmount } = at('/credentials/new?service=github')
    fireEvent.change(await screen.findByLabelText('Token'), { target: { value: 'ghp_123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Open credential' }))
    expect(await screen.findByText('at /credentials/conn-new')).toBeInTheDocument()
    unmount()

    at('/credentials/new?service=github&returnTo=%2Fguide')
    fireEvent.change(await screen.findByLabelText('Token'), { target: { value: 'ghp_123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Done' }))
    expect(await screen.findByText('at /guide')).toBeInTheDocument()
  })

  it('adds a sign-in service with its Sign in button', async () => {
    vi.mocked(connectionsApi.connect).mockResolvedValue({ pending: true, method: 'oauth2_code', mode: 'browser', authorizeUrl: 'https://slack.com/oauth?state=s', state: 's', expiresInSeconds: 600, completeWith: 'callback' })
    vi.mocked(connectionsApi.list).mockResolvedValue([])
    at('/credentials/new?service=channel-slack')
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(connectionsApi.connect).toHaveBeenCalledWith('channel-slack', { method: 'oauth2_code', owner: 'org' }))
    expect(openSpy).toHaveBeenCalledWith('https://slack.com/oauth?state=s', '_blank', 'noopener')
    expect(await screen.findByTestId('oauth-waiting')).toHaveTextContent('Waiting for Slack')
  })

  it('saves any other key under a name, and says it was saved rather than that it works', async () => {
    vi.mocked(connectionsApi.connect).mockResolvedValue({ pending: false, connection: connection({ id: 'conn-acme', name: 'Acme CRM', connectorKey: 'other', accountLabel: null }) })
    at()
    fireEvent.click(await screen.findByTestId('service-tile-other'))
    const form = await screen.findByRole('form', { name: 'Add a key' })
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
    expect(await within(form).findByText('Give it a name you will recognise')).toBeInTheDocument()
    expect(connectionsApi.connect).not.toHaveBeenCalled()

    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Acme CRM' } })
    fireEvent.change(within(form).getByLabelText('Key'), { target: { value: 'acme-secret' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
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

  it('shows model providers as one tile that leads to connecting one, with no AI or GPU hosting groups of its own', async () => {
    const modal: Connector = { key: 'modal', kind: 'deployment', adapterKey: 'modal', displayName: 'Modal', connect: [{ type: 'api_key' }] }
    vi.mocked(connectorsApi.list).mockResolvedValue([github, slack, openai, modal, other])
    const { router } = at()
    const tile = await screen.findByTestId('service-tile-ai-models')
    expect(tile).toHaveTextContent('Model providers')
    expect(screen.queryByTestId('service-tile-openai')).not.toBeInTheDocument()
    expect(screen.queryByTestId('service-tile-modal')).not.toBeInTheDocument()
    expect(screen.queryByText('GPU hosting')).not.toBeInTheDocument()
    fireEvent.click(tile)
    await waitFor(() => expect(router.state.location.pathname).toBe('/credentials/providers/new'))
  })

  it('sends a link to a model provider on to connecting one, where its models come with it', async () => {
    const { router } = at('/credentials/new?service=openai')
    await waitFor(() => expect(router.state.location.pathname).toBe('/credentials/providers/new'))
    expect(router.state.location.search).toBe('?type=openai')
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
    expect(screen.getByTestId('who-can-use')).toHaveTextContent('everyone in your organization')
    expect(screen.getByRole('link', { name: 'Change' })).toHaveAttribute('href', '/credentials/advanced?credential=conn-1')
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

  it('offers no change of who can use a private credential', async () => {
    at('conn-2')
    expect(await screen.findByRole('heading', { name: 'Acme CRM' })).toBeInTheDocument()
    expect(screen.getByTestId('who-can-use')).toHaveTextContent('only you')
    expect(screen.queryByRole('link', { name: 'Change' })).not.toBeInTheDocument()
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

describe('where credentials used to live', () => {
  it('maps every Connections and Settings > Connections address onto Credentials', () => {
    for (const base of ['/connections', '/settings/connections']) {
      expect(credentialsTarget(base, '')).toBe('/credentials')
      expect(credentialsTarget(`${base}/advanced`, '')).toBe('/credentials/advanced')
      expect(credentialsTarget(`${base}/connect`, '')).toBe('/credentials/new')
      expect(credentialsTarget(`${base}/connect`, '?service=github')).toBe('/credentials/new?service=github')
      expect(credentialsTarget(`${base}/connect/github`, '?returnTo=%2Fguide')).toBe('/credentials/new?service=github&returnTo=%2Fguide')
      expect(credentialsTarget(`${base}/custom/new`, '')).toBe('/credentials/custom/new')
      expect(credentialsTarget(`${base}/policies/p1`, '')).toBe('/credentials/policies/p1')
      expect(credentialsTarget(`${base}/policies/new`, '?kind=expiry_rule')).toBe('/credentials/policies/new?kind=expiry_rule')
      expect(credentialsTarget(`${base}/conn-1`, '')).toBe('/credentials/conn-1')
    }
    // A sign-in that came back to the old address opens what it made.
    expect(credentialsTarget('/connections', '?connection=conn-9&status=valid')).toBe('/credentials/conn-9')
  })

  it('redirects under a router, and sends access keys to the gateways they unlock', async () => {
    const old = renderAtRoute(<OldCredentialsAddressRedirect />, { path: '/connections/*', url: '/connections/conn-1', paths: PATHS })
    await waitFor(() => expect(old.router.state.location.pathname).toBe('/credentials/conn-1'))
    old.unmount()
    const keys = renderAtRoute(<AccessKeysRedirect />, { path: '/credentials/access-keys/*', url: '/credentials/access-keys', paths: PATHS })
    await waitFor(() => expect(keys.router.state.location.pathname).toBe('/gateways'))
  })
})
