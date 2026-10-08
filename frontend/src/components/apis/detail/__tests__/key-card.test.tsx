/**
 * The API page's one Key card (it replaced "Authentication" and
 * "Upstream credentials", which were the same secret twice). It says how
 * the key is sent and where it comes from; "Replace key" opens the shared
 * pick-or-create credential control in place, so a key typed here lands on
 * Credentials. A username and password and an OAuth 2.0 sign-in are
 * credentials too, made in the same control (a sign-in leaves for the
 * provider and comes back here), and a half-typed password asks before
 * leaving.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderAtRoute } from '@/test/render-at-route'
import { expectLeaveAsks, expectLeavesWithoutAsking } from '@/test/leave-guard'
import { ApiKeyCard } from '../key-card'
import { apisApi, credentialsApi } from '@/lib/api'
import { connectionsApi, connectorsApi } from '@/lib/connections-api'
import type { ApiKeyView } from '@/types/api-connect'
import type { Connection, Connector } from '@/types/connections'

vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

vi.mock('@/lib/api', () => ({
  apisApi: { getKey: vi.fn(), setKey: vi.fn(), removeKey: vi.fn() },
  credentialsApi: { oauth2Authorize: vi.fn(), oauth2ClientCredentials: vi.fn() },
  organizationsApi: { getById: vi.fn().mockResolvedValue({ id: 'org-1', plan: 'free', settings: {} }) },
}))
vi.mock('@/lib/connections-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/connections-api')>('@/lib/connections-api')
  return { ...actual, connectorsApi: { list: vi.fn(), create: vi.fn() }, connectionsApi: { list: vi.fn(), connect: vi.fn(), complete: vi.fn() } }
})
vi.mock('@/store/organization', () => ({
  useOrganizationStore: (selector?: (s: any) => any) => {
    const state = { currentOrganization: { id: 'org-1', name: 'Org' } }
    return selector ? selector(state) : state
  },
}))
vi.mock('@/hooks/use-organization-role', () => ({ useOrganizationRole: () => ({ role: 'admin', canManage: true, isOwner: false }) }))
const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
vi.mock('@/store/app', () => ({ useNotifications: () => notify }))

const other: Connector = {
  key: 'other',
  kind: 'tool_source',
  displayName: 'Other service',
  validation: { kind: 'format' },
  connect: [{ type: 'api_key', label: 'Key', schema: { type: 'object', properties: { apiKey: { type: 'string', title: 'Key', 'x-secret': true } }, required: ['apiKey'] } }],
}
const basicAuth: Connector = {
  key: 'basic-auth',
  kind: 'tool_source',
  displayName: 'Username and password',
  validation: { kind: 'format', accountLabelFrom: 'username' },
  connect: [{
    type: 'api_key',
    label: 'Username and password',
    schema: { type: 'object', properties: { username: { type: 'string', title: 'Username' }, password: { type: 'string', title: 'Password', 'x-secret': true } }, required: ['username', 'password'] },
  }],
}
const petsAccount: Connection = { id: 'conn-1', name: 'Pets account', connectorKey: 'other', connectorDisplayName: 'Other service', kind: 'tool_source', owner: 'org', accountLabel: 'ops@example.com', health: { status: 'valid' }, createdAt: '2026-09-01T00:00:00.000Z' }

const view = (over: Partial<ApiKeyView> = {}): ApiKeyView => ({
  type: 'api_key',
  headerName: 'X-Pets-Key',
  location: 'header',
  oauth2: null,
  source: null,
  credential: null,
  connection: null,
  ...over,
})
const fromCredential = (c: Pick<Connection, 'id' | 'name' | 'accountLabel'>, over: Partial<ApiKeyView> = {}) =>
  view({ source: 'connection', connection: { id: c.id, name: c.name, accountLabel: c.accountLabel ?? null, connectorKey: 'other' }, ...over })

const at = () => renderAtRoute(<ApiKeyCard apiId="api-1" apiName="Petstore" />, { path: '/apis/api-1', paths: ['/elsewhere', '/credentials/:id'] })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(connectorsApi.list).mockResolvedValue([other, basicAuth])
  vi.mocked(connectionsApi.list).mockResolvedValue([petsAccount])
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
})

describe('the Key card', () => {
  it('says how the key is sent and that there is none yet, and adds one by creating a credential right here', async () => {
    const made: Connection = { ...petsAccount, id: 'conn-new', name: 'Petstore key', accountLabel: null }
    vi.mocked(apisApi.getKey).mockResolvedValue(view())
    vi.mocked(connectionsApi.connect).mockResolvedValue({ pending: false, connection: made })
    vi.mocked(apisApi.setKey).mockResolvedValue(fromCredential(made))
    const user = userEvent.setup()
    at()

    const summary = await screen.findByTestId('api-key-summary')
    expect(summary).toHaveTextContent('Sent in the X-Pets-Key header')
    expect(summary).toHaveTextContent('No key yet')
    // One card, not the two it replaced.
    expect(screen.queryByText('Upstream credentials')).not.toBeInTheDocument()
    expect(screen.queryByText('Authentication')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add a key' }))
    await user.click(await screen.findByRole('button', { name: 'Create one here' }))
    const flow = await screen.findByTestId('credential-form')
    // It lands on Credentials under a name that says what it is for.
    expect(await within(flow).findByLabelText('Name')).toHaveValue('Petstore key')
    const key = await within(flow).findByLabelText('Key')
    // A secret: masked.
    expect(key).toHaveAttribute('type', 'password')
    await user.type(key, 'pk-live-1')
    await user.click(within(flow).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(connectionsApi.connect).toHaveBeenCalledWith('other', expect.objectContaining({ name: 'Petstore key', input: { apiKey: 'pk-live-1' } })))
    await waitFor(() =>
      expect(apisApi.setKey).toHaveBeenCalledWith('api-1', { type: 'api_key', connectionId: 'conn-new', headerName: 'X-Pets-Key', location: 'header' }),
    )
    expect(await screen.findByTestId('api-key-summary')).toHaveTextContent('From Petstore key')
    expect(screen.getByTestId('api-key-credential-link')).toHaveAttribute('href', '/credentials/conn-new')
  })

  it('picks a credential already on Credentials, and changes the header on the way', async () => {
    vi.mocked(apisApi.getKey).mockResolvedValue(view())
    vi.mocked(apisApi.setKey).mockResolvedValue(fromCredential(petsAccount, { headerName: 'Authorization-Token' }))
    const user = userEvent.setup()
    at()
    await user.click(await screen.findByRole('button', { name: 'Add a key' }))
    await user.click(screen.getByRole('button', { name: 'Change' }))
    const header = screen.getByLabelText('Header')
    await user.clear(header)
    await user.type(header, 'Authorization-Token')
    await user.click(screen.getByRole('combobox', { name: 'Credential' }))
    await user.click(await screen.findByRole('option', { name: /Pets account/ }))
    await waitFor(() =>
      expect(apisApi.setKey).toHaveBeenCalledWith('api-1', { type: 'api_key', connectionId: 'conn-1', headerName: 'Authorization-Token', location: 'header' }),
    )
  })

  it('shows the credential in use, links to it, and offers another one', async () => {
    vi.mocked(apisApi.getKey).mockResolvedValue(fromCredential(petsAccount))
    const user = userEvent.setup()
    at()
    expect(await screen.findByTestId('api-key-summary')).toHaveTextContent('From Pets account (ops@example.com)')
    expect(screen.getByRole('link', { name: 'Open credential' })).toHaveAttribute('href', '/credentials/conn-1')
    await user.click(screen.getByRole('button', { name: 'Replace key' }))
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Credential' })).toHaveTextContent('Pets account'))
    expect(screen.getByRole('button', { name: 'Create one here' })).toBeInTheDocument()
  })

  it('keeps a username and password as a credential, never typed into the API itself', async () => {
    const made: Connection = { ...petsAccount, id: 'conn-basic', name: 'Username and password', connectorKey: 'basic-auth', accountLabel: 'ops' }
    vi.mocked(apisApi.getKey).mockResolvedValue(view({ type: 'basic', headerName: null, location: null }))
    vi.mocked(connectionsApi.connect).mockResolvedValue({ pending: false, connection: made })
    vi.mocked(apisApi.setKey).mockResolvedValue(fromCredential(made, { type: 'basic', headerName: null, location: null }))
    const user = userEvent.setup()
    at()
    await user.click(await screen.findByRole('button', { name: 'Add a key' }))
    // No password field on the form: the picker is the only way in.
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Username and password' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Create one here' }))
    const flow = await screen.findByTestId('credential-form')
    await user.type(await within(flow).findByLabelText(/^Username\s*\*?$/), 'ops')
    const password = within(flow).getByLabelText(/^Password\s*\*?$/)
    expect(password).toHaveAttribute('type', 'password')
    await user.type(password, 'pw')
    await user.click(within(flow).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(connectionsApi.connect).toHaveBeenCalledWith('basic-auth', expect.objectContaining({ input: { username: 'ops', password: 'pw' } })))
    await waitFor(() => expect(apisApi.setKey).toHaveBeenCalledWith('api-1', { type: 'basic', connectionId: 'conn-basic' }))
  })

  it('signs in with OAuth 2.0 when the spec declares it, coming back to the API', async () => {
    vi.mocked(apisApi.getKey).mockResolvedValue(
      view({
        type: 'oauth2',
        headerName: null,
        location: null,
        oauth2: { flow: 'authorization_code', authorizationUrl: 'https://auth.cal.example.com/authorize', tokenUrl: 'https://auth.cal.example.com/token', scopes: ['events.read'] },
      }),
    )
    vi.mocked(credentialsApi.oauth2Authorize).mockResolvedValue({ authorizationUrl: 'https://auth.cal.example.com/authorize?state=s', state: 's' })
    const assign = vi.fn()
    const original = window.location
    Object.defineProperty(window, 'location', { value: { ...original, assign }, configurable: true })
    try {
      const user = userEvent.setup()
      at()
      await user.click(await screen.findByRole('button', { name: 'Add a key' }))
      // A sign-in is a credential: picked, or made in the same control.
      expect(screen.getByRole('combobox', { name: 'Sign-in' })).toBeInTheDocument()
      expect(screen.queryByLabelText('Client ID')).not.toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Create one here' }))
      expect(screen.getByText(/Sign in at auth.cal.example.com/)).toBeInTheDocument()
      await user.type(screen.getByLabelText('Client ID'), 'cid')
      await user.type(screen.getByLabelText('Client secret'), 'csecret')
      await user.click(screen.getByRole('button', { name: 'Sign in' }))

      await waitFor(() =>
        expect(credentialsApi.oauth2Authorize).toHaveBeenCalledWith(
          expect.objectContaining({
            apiId: 'api-1',
            clientId: 'cid',
            clientSecret: 'csecret',
            authorizationUrl: 'https://auth.cal.example.com/authorize',
            tokenUrl: 'https://auth.cal.example.com/token',
            scopes: ['events.read'],
            returnTo: '/apis/api-1',
          }),
        ),
      )
      await waitFor(() => expect(assign).toHaveBeenCalledWith('https://auth.cal.example.com/authorize?state=s'))
    } finally {
      Object.defineProperty(window, 'location', { value: original, configurable: true })
    }
  })

  it('removes the key after asking', async () => {
    vi.mocked(apisApi.getKey).mockResolvedValue(view({ source: 'key' }))
    vi.mocked(apisApi.removeKey).mockResolvedValue(view())
    const user = userEvent.setup()
    at()
    await user.click(await screen.findByRole('button', { name: 'Remove' }))
    await user.click(await screen.findByRole('button', { name: 'Remove key' }))
    await waitFor(() => expect(apisApi.removeKey).toHaveBeenCalledWith('api-1'))
    expect(await screen.findByTestId('api-key-summary')).toHaveTextContent('No key yet')
  })
})

describe('the Key card asks before leaving', () => {
  beforeEach(() => {
    vi.mocked(apisApi.getKey).mockResolvedValue(view({ type: 'basic', headerName: null, location: null, source: 'key' }))
  })

  it('asks while a password is half typed', async () => {
    const { router } = at()
    fireEvent.click(await screen.findByRole('button', { name: 'Replace key' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create one here' }))
    fireEvent.change(await screen.findByLabelText(/^Password\s*\*?$/), { target: { value: 'pk-half' } })
    await expectLeaveAsks(router)
  })

  it('leaves an opened but empty form without asking', async () => {
    const { router } = at()
    fireEvent.click(await screen.findByRole('button', { name: 'Replace key' }))
    await expectLeavesWithoutAsking(router)
  })

  it('leaves without asking after Cancel', async () => {
    const { router } = at()
    fireEvent.click(await screen.findByRole('button', { name: 'Replace key' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create one here' }))
    const flow = await screen.findByTestId('credential-form')
    fireEvent.change(await within(flow).findByLabelText(/^Password\s*\*?$/), { target: { value: 'pk-half' } })
    fireEvent.click(within(flow).getByRole('button', { name: 'Cancel' }))
    await expectLeavesWithoutAsking(router)
  })
})
