/**
 * Add MCP server offers the MCP sign-in (OAuth) itself, next to a token:
 * the server is asked which it wants once its URL is entered, a server
 * that publishes where to sign in gets sign-in by default, the sign-in is
 * the same one Credentials uses, and a finished sign-in goes straight on
 * to adding the server and discovering its tools. Wherever the sign-in
 * asks for a client id, the redirect URL the app must list is shown with
 * a copy button.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'

import { render } from '../../../test/setup'
import { McpServerForm } from '../mcp-server-form'
import { mcpSourcesApi } from '../../../lib/api'
import { connectionsApi, connectorsApi } from '../../../lib/connections-api'
import type { Connection, Connector } from '@/types/connections'

vi.mock('../../../lib/api', () => ({
  mcpSourcesApi: { create: vi.fn(), checkAuth: vi.fn() },
  organizationsApi: { getById: vi.fn().mockResolvedValue({ id: 'org-1', plan: 'free', settings: {} }), getTeams: vi.fn().mockResolvedValue([]) },
}))

vi.mock('../../../lib/connections-api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/connections-api')>('../../../lib/connections-api')
  return {
    ...actual,
    connectorsApi: { list: vi.fn(), create: vi.fn() },
    connectionsApi: { list: vi.fn(), connect: vi.fn(), complete: vi.fn(), rotate: vi.fn(), signInCallbackUrl: vi.fn() },
  }
})

const notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('../../../store/app', () => ({ useNotifications: () => notify }))

vi.mock('../../../store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org-1', name: 'Test Org' } }),
}))

const role = { role: 'admin' as string | null, canManage: true, isOwner: false }
vi.mock('../../../hooks/use-organization-role', () => ({ useOrganizationRole: () => role }))

const navigateMock = vi.fn()
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual<typeof import('react-router-dom')>('react-router-dom')),
  useNavigate: () => navigateMock,
}))

const SERVER = 'https://mcp.apollo.io/mcp'
const CALLBACK = 'https://api.staging.almyty.com/credentials/oauth/callback'

const mcpServer: Connector = {
  key: 'mcp-custom',
  kind: 'mcp',
  displayName: 'MCP server',
  connect: [
    {
      type: 'api_key',
      label: 'Server URL and token',
      schema: { type: 'object', properties: { serverUrl: { type: 'string', title: 'Server URL', format: 'uri' }, apiKey: { type: 'string', title: 'Bearer token', 'x-secret': true } }, required: ['serverUrl'] },
    },
    {
      type: 'oauth2_pkce',
      label: 'Sign in to the server',
      schema: {
        type: 'object',
        properties: {
          serverUrl: { type: 'string', title: 'Server URL', format: 'uri' },
          clientId: { type: 'string', title: 'Client id (only if the server gave you one)', 'x-advanced': true },
          clientSecret: { type: 'string', title: 'Client secret (only with a client id)', 'x-secret': true, 'x-advanced': true },
        },
        required: ['serverUrl'],
      },
    },
  ],
}

function fill(name: string, url: string) {
  fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: name } })
  const field = screen.getByLabelText(/server url/i)
  fireEvent.change(field, { target: { value: url } })
  fireEvent.blur(field)
}

describe('Add MCP server: sign in to the server', () => {
  let openSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    vi.mocked(connectorsApi.list).mockResolvedValue([mcpServer])
    vi.mocked(connectionsApi.list).mockResolvedValue([])
    vi.mocked(connectionsApi.signInCallbackUrl).mockResolvedValue({ callbackUrl: CALLBACK })
    vi.mocked(mcpSourcesApi.create).mockResolvedValue({ source: { id: 'src-1' }, sync: { total: 4 }, syncError: null })
  })

  afterEach(() => openSpy.mockRestore())

  it('offers signing in to the server next to a token, on the page', () => {
    render(<McpServerForm organizationId="org-1" />)
    const choice = screen.getByRole('radiogroup', { name: /signs in to the server/i })
    expect(within(choice).getByRole('radio', { name: /Sign in to the server/ })).toBeInTheDocument()
    expect(within(choice).getByRole('radio', { name: /Token/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('asks the server once the URL is entered, and defaults to sign-in when it publishes where to sign in', async () => {
    vi.mocked(mcpSourcesApi.checkAuth).mockResolvedValue({ auth: 'sign_in' })
    render(<McpServerForm organizationId="org-1" />)
    fill('apollo', SERVER)

    await waitFor(() => expect(mcpSourcesApi.checkAuth).toHaveBeenCalledWith('org-1', SERVER))
    expect(await screen.findByText('This server asks you to sign in.')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Sign in to the server/ })).toHaveAttribute('aria-checked', 'true')
    // The sign-in from Credentials, inline, without asking for the URL again.
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.getAllByLabelText(/server url/i)).toHaveLength(1)
  })

  it('keeps the token when the server publishes no sign-in', async () => {
    vi.mocked(mcpSourcesApi.checkAuth).mockResolvedValue({ auth: 'token' })
    render(<McpServerForm organizationId="org-1" />)
    fill('internal', SERVER)

    expect(await screen.findByText(/asks for a token/)).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Token/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('combobox', { name: /token/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument()
  })

  it('signs in through the MCP sign-in and goes straight on to discovering the tools', async () => {
    vi.mocked(mcpSourcesApi.checkAuth).mockResolvedValue({ auth: 'sign_in' })
    vi.mocked(connectionsApi.connect).mockResolvedValue({ pending: true, authorizeUrl: 'https://auth.apollo.io/authorize?state=st-1', state: 'st-1', completeWith: 'redirect', method: 'oauth2_pkce' } as any)
    const signedIn: Connection = {
      id: 'cred-apollo',
      name: 'apollo sign-in',
      connectorKey: 'mcp-custom',
      connectorDisplayName: 'MCP server',
      kind: 'mcp',
      owner: 'org',
      health: { status: 'valid' },
      createdAt: new Date(Date.now() + 60_000).toISOString(),
    }
    vi.mocked(connectionsApi.list).mockResolvedValue([signedIn])

    render(<McpServerForm organizationId="org-1" />)
    fill('apollo', SERVER)
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }))

    await waitFor(() =>
      expect(connectionsApi.connect).toHaveBeenCalledWith('mcp-custom', {
        method: 'oauth2_pkce',
        owner: 'org',
        name: 'apollo sign-in',
        input: { serverUrl: SERVER },
      }),
    )
    expect(openSpy).toHaveBeenCalledWith('https://auth.apollo.io/authorize?state=st-1', '_blank', 'noopener')
    await waitFor(() => expect(mcpSourcesApi.create).toHaveBeenCalledWith('org-1', { name: 'apollo', url: SERVER, credentialId: 'cred-apollo' }))
    await waitFor(() => expect(notify.success).toHaveBeenCalledWith('MCP server added', expect.stringContaining('4 tools')))
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/tools', undefined))
  })

  it('does not add the server in sign-in mode before signing in', async () => {
    render(<McpServerForm organizationId="org-1" />)
    fill('apollo', SERVER)
    fireEvent.click(screen.getByRole('radio', { name: /Sign in to the server/ }))
    fireEvent.click(screen.getByRole('button', { name: /add server/i }))
    expect(await screen.findByText('Sign in to the server first.')).toBeInTheDocument()
    expect(mcpSourcesApi.create).not.toHaveBeenCalled()
  })

  it('shows the redirect URL from the API, with a copy button, next to the client id', async () => {
    vi.mocked(mcpSourcesApi.checkAuth).mockResolvedValue({ auth: 'sign_in' })
    render(<McpServerForm organizationId="org-1" />)
    fill('hubspot', 'https://mcp.hubspot.com')

    await screen.findByRole('button', { name: 'Sign in' })
    fireEvent.click(screen.getByRole('button', { name: 'More options' }))
    expect(screen.getByLabelText(/Client id/)).toBeInTheDocument()

    const box = await screen.findByTestId('sign-in-redirect-url')
    expect(within(box).getByText(CALLBACK)).toBeInTheDocument()
    expect(within(box).getByRole('button', { name: 'Copy redirect url' })).toBeInTheDocument()
    expect(connectionsApi.signInCallbackUrl).toHaveBeenCalled()
  })
})
