/**
 * The connect flow, inline (as "Connect an account" opens it inside another
 * form) and on its own: tiles, the one field a service needs, who can use
 * it, the check on save, and everything else under Advanced.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'

import { render } from '../../../test/setup'
import { ConnectFlow, splitConnectSchema } from '../connect-flow'
import { connectionsApi, connectorsApi } from '../../../lib/connections-api'
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
      listGrants: vi.fn(),
      addGrant: vi.fn(),
      removeGrant: vi.fn(),
    },
  }
})

vi.mock('../../../lib/api', () => ({
  organizationsApi: { getById: vi.fn(), getTeams: vi.fn().mockResolvedValue([]) },
}))

vi.mock('../../../store/organization', () => ({
  useOrganizationStore: (selector?: (s: any) => any) => {
    const state = { currentOrganization: { id: 'test-org-id', name: 'Test Org' } }
    return selector ? selector(state) : state
  },
}))

const role = { role: 'admin' as string | null, canManage: true, isOwner: false }
vi.mock('../../../hooks/use-organization-role', () => ({ useOrganizationRole: () => role }))

const openai: Connector = {
  key: 'openai',
  kind: 'inference',
  displayName: 'OpenAI',
  description: 'GPT models',
  keyPageUrl: 'https://platform.openai.com/api-keys',
  connect: [
    {
      type: 'api_key',
      label: 'API key',
      description: 'Create a key in the OpenAI dashboard.',
      schema: { type: 'object', properties: { apiKey: { type: 'string', title: 'API key', 'x-secret': true } }, required: ['apiKey'] },
    },
  ],
}

const vllm: Connector = {
  key: 'openai-compatible',
  kind: 'inference',
  displayName: 'Your own server',
  connect: [
    {
      type: 'api_key',
      schema: {
        type: 'object',
        properties: {
          baseUrl: { type: 'string', title: 'Base URL', format: 'uri' },
          apiKey: { type: 'string', title: 'API key', 'x-secret': true },
          healthPath: { type: 'string', title: 'Health path' },
        },
        required: ['baseUrl'],
      },
    },
  ],
}

const slack: Connector = {
  key: 'channel-slack',
  kind: 'channel',
  displayName: 'Slack',
  connect: [
    { type: 'oauth2_code', label: 'Add to Slack', scopes: ['chat:write'] },
    { type: 'api_key', label: 'Bot token', schema: { type: 'object', properties: { bot_token: { type: 'string', title: 'Bot token', 'x-secret': true } }, required: ['bot_token'] } },
  ],
}

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
          clientId: { type: 'string', title: 'Client id', 'x-advanced': true },
          clientSecret: { type: 'string', title: 'Client secret', 'x-secret': true, 'x-advanced': true },
        },
        required: ['serverUrl'],
      },
    },
  ],
}

function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'conn-1',
    name: 'OpenAI',
    connectorKey: 'openai',
    kind: 'inference',
    owner: 'org',
    health: { status: 'valid' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

const redirect = (state: string) => ({
  pending: true as const,
  method: 'oauth2_code' as const,
  mode: 'browser' as const,
  authorizeUrl: `https://slack.com/oauth/authorize?state=${state}`,
  state,
  expiresInSeconds: 600,
  completeWith: 'callback' as const,
})

let openSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(role, { role: 'admin', canManage: true })
  vi.mocked(organizationsApi.getById).mockResolvedValue({ id: 'test-org-id', plan: 'free', settings: {} })
  vi.mocked(organizationsApi.getTeams).mockResolvedValue([])
  vi.mocked(connectorsApi.list).mockResolvedValue([openai, vllm, slack, mcpServer])
  openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
})

afterEach(() => {
  openSpy.mockRestore()
})

describe('ConnectFlow', () => {
  it('shows the services as tiles, filtered by kind, and opens one into its form', async () => {
    render(<ConnectFlow embedded onCancel={() => {}} kind="inference" onConnected={() => {}} />)
    expect(await screen.findByTestId('service-tile-openai')).toBeInTheDocument()
    expect(screen.queryByTestId('service-tile-channel-slack')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('service-tile-openai'))
    expect(await screen.findByText('Add OpenAI')).toBeInTheDocument()
    // One field, a link to where the key is made, and who can use it.
    expect(screen.getByLabelText('API key')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Get a key/ })).toHaveAttribute('href', 'https://platform.openai.com/api-keys')
    expect(screen.getByTestId('who-can-use')).toHaveTextContent('Who can use it: Everyone')
    // The service's own instructions wait under Advanced.
    expect(screen.queryByTestId('connect-instructions')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    expect(screen.getByTestId('connect-instructions')).toHaveTextContent('Create a key in the OpenAI dashboard.')
  })

  it('posts the key for the organization and hands the connection back', async () => {
    const created = connection()
    vi.mocked(connectionsApi.connect).mockResolvedValue({ pending: false, connection: created })
    const onConnected = vi.fn()
    const onCancel = vi.fn()
    render(<ConnectFlow embedded onCancel={onCancel} connectorKey="openai" onConnected={onConnected} />)

    fireEvent.change(await screen.findByLabelText('API key'), { target: { value: 'sk-test-123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(connectionsApi.connect).toHaveBeenCalledWith('openai', { method: 'api_key', owner: 'org', input: { apiKey: 'sk-test-123' } }))
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(created))
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('refuses to post until the key is filled', async () => {
    render(<ConnectFlow embedded onCancel={() => {}} connectorKey="openai" onConnected={() => {}} />)
    await screen.findByLabelText('API key')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('API key is required')).toBeInTheDocument()
    expect(connectionsApi.connect).not.toHaveBeenCalled()
  })

  it('says a refused key plainly, keeps the form filled, and the next try replaces the key of the kept connection', async () => {
    const kept = connection({ id: 'conn-kept', health: { status: 'failed', error: 'provider rejected the credential (401)' } })
    vi.mocked(connectionsApi.connect).mockRejectedValueOnce({
      response: { status: 422, data: { code: 'CONNECTION_VALIDATION_FAILED', message: 'provider rejected the credential (401)', connection: kept } },
    })
    vi.mocked(connectionsApi.rotate).mockResolvedValueOnce({ pending: false, connection: connection({ id: 'conn-kept' }) })
    const onConnected = vi.fn()
    render(<ConnectFlow embedded onCancel={() => {}} connectorKey="openai" onConnected={onConnected} />)

    fireEvent.change(await screen.findByLabelText('API key'), { target: { value: 'sk-bad' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    const failure = await screen.findByTestId('connect-failure')
    expect(failure).toHaveTextContent('OpenAI did not accept this.')
    expect(within(failure).getByText('provider rejected the credential (401)')).toBeInTheDocument()
    expect(screen.getByLabelText('API key')).toHaveValue('sk-bad')
    expect(onConnected).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-good' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1))
    expect(connectionsApi.rotate).toHaveBeenCalledWith('conn-kept', { input: { apiKey: 'sk-good' } })
    expect(connectionsApi.connect).toHaveBeenCalledTimes(1)
  })

  it('says an out-of-credit account is not a bad key', async () => {
    vi.mocked(connectionsApi.connect).mockRejectedValueOnce({
      response: { status: 422, data: { code: 'CONNECTION_VALIDATION_FAILED', message: 'insufficient_quota', connection: connection({ health: { status: 'quota' } }) } },
    })
    render(<ConnectFlow embedded onCancel={() => {}} connectorKey="openai" onConnected={() => {}} />)
    fireEvent.change(await screen.findByLabelText('API key'), { target: { value: 'sk-broke' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByTestId('connect-failure')).toHaveTextContent('OpenAI accepted the key, but the account is out of credit or over its limit.')
  })

  it('asks for the required fields up front and keeps the optional ones under Advanced', async () => {
    vi.mocked(connectionsApi.connect).mockResolvedValue({ pending: false, connection: connection({ connectorKey: 'openai-compatible' }) })
    render(<ConnectFlow embedded onCancel={() => {}} connectorKey="openai-compatible" onConnected={() => {}} />)
    expect(await screen.findByLabelText('Base URL')).toBeInTheDocument()
    expect(screen.getByLabelText('API key')).toBeInTheDocument()
    expect(screen.queryByLabelText('Health path')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    fireEvent.change(screen.getByLabelText('Health path'), { target: { value: '/health' } })
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://llm.example.com/v1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(connectionsApi.connect).toHaveBeenCalledWith('openai-compatible', expect.objectContaining({ input: { baseUrl: 'https://llm.example.com/v1', healthPath: '/health' } })),
    )
  })

  it('connects a sign-in service with one Sign in button, waits, and hands back what the callback made', async () => {
    vi.mocked(connectionsApi.connect).mockResolvedValue(redirect('st-1'))
    const landed = connection({ id: 'conn-slack', name: 'Slack', connectorKey: 'channel-slack', kind: 'channel' })
    vi.mocked(connectionsApi.list).mockResolvedValueOnce([]).mockResolvedValueOnce([landed])
    const onConnected = vi.fn()
    render(<ConnectFlow embedded onCancel={() => {}} connectorKey="channel-slack" onConnected={onConnected} pollIntervalMs={5} />)

    // Nothing to paste; the bot-token way waits under Advanced.
    expect(await screen.findByText(/You sign in at Slack and come back here/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Bot token')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => expect(connectionsApi.connect).toHaveBeenCalledWith('channel-slack', { method: 'oauth2_code', owner: 'org' }))
    await waitFor(() => expect(openSpy).toHaveBeenCalledWith('https://slack.com/oauth/authorize?state=st-1', '_blank', 'noopener'))
    expect(await screen.findByTestId('oauth-waiting')).toBeInTheDocument()
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(landed))
  })

  it('offers the other way to sign in under Advanced', async () => {
    vi.mocked(connectionsApi.connect).mockResolvedValue({ pending: false, connection: connection({ connectorKey: 'channel-slack' }) })
    render(<ConnectFlow embedded onCancel={() => {}} connectorKey="channel-slack" onConnected={() => {}} />)
    await screen.findByText(/You sign in at Slack/)
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Bot token' }))
    fireEvent.change(await screen.findByLabelText('Bot token'), { target: { value: 'xoxb-123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(connectionsApi.connect).toHaveBeenCalledWith('channel-slack', { method: 'api_key', owner: 'org', input: { bot_token: 'xoxb-123' } }))
  })

  it('keeps pasting a sign-in code under Advanced, and finishes with it', async () => {
    vi.mocked(connectionsApi.connect).mockResolvedValue(redirect('st-2'))
    vi.mocked(connectionsApi.list).mockResolvedValue([])
    const landed = connection({ id: 'conn-slack', name: 'Slack', connectorKey: 'channel-slack', kind: 'channel' })
    vi.mocked(connectionsApi.complete).mockResolvedValue(landed)
    const onConnected = vi.fn()
    render(<ConnectFlow embedded onCancel={() => {}} connectorKey="channel-slack" onConnected={onConnected} pollIntervalMs={50} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }))
    await screen.findByTestId('oauth-waiting')
    expect(screen.queryByLabelText('Code from the service')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    fireEvent.change(screen.getByLabelText('Code from the service'), { target: { value: 'code-xyz' } })
    fireEvent.click(screen.getByRole('button', { name: /Finish/ }))

    await waitFor(() => expect(connectionsApi.complete).toHaveBeenCalledWith('channel-slack', { state: 'st-2', code: 'code-xyz' }))
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(landed))
  })


  it('signs in to an MCP server: asks where it is first, keeps a client id under Advanced, and sends both', async () => {
    vi.mocked(connectionsApi.connect).mockResolvedValue({ ...redirect('st-mcp'), method: 'oauth2_pkce' })
    vi.mocked(connectionsApi.list).mockResolvedValue([])
    render(<ConnectFlow embedded onCancel={() => {}} connectorKey="mcp-custom" onConnected={() => {}} pollIntervalMs={50} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Advanced' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Sign in to the server' }))
    expect(await screen.findByText(/Enter where it is, then sign in at MCP server/)).toBeInTheDocument()

    // Without the address there is nothing to sign in to.
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(connectionsApi.connect).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://mcp.example.com/mcp' } })
    // The sign-in's own Advanced: the client id an owner hands out.
    if (!screen.queryByLabelText('Client id')) fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    fireEvent.change(screen.getByLabelText('Client id'), { target: { value: 'pre-registered-id' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() =>
      expect(connectionsApi.connect).toHaveBeenCalledWith('mcp-custom', {
        method: 'oauth2_pkce',
        owner: 'org',
        input: { serverUrl: 'https://mcp.example.com/mcp', clientId: 'pre-registered-id' },
      }),
    )
    await waitFor(() => expect(openSpy).toHaveBeenCalledWith('https://slack.com/oauth/authorize?state=st-mcp', '_blank', 'noopener'))
  })

  it('signs in to an MCP server again without asking where it is', async () => {
    const existing = connection({ id: 'conn-mcp', name: 'Docs MCP', connectorKey: 'mcp-custom', kind: 'mcp', method: 'oauth2_pkce' } as Partial<Connection>)
    vi.mocked(connectionsApi.rotate).mockResolvedValue({ ...redirect('st-again'), method: 'oauth2_pkce' })
    vi.mocked(connectionsApi.list).mockResolvedValue([])
    render(<ConnectFlow embedded onCancel={() => {}} rotateConnection={existing} onConnected={() => {}} pollIntervalMs={50} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Advanced' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Sign in to the server' }))
    expect(screen.queryByLabelText('Server URL')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(connectionsApi.rotate).toHaveBeenCalledWith('conn-mcp', {}))
  })
  it('replaces the key of an existing connection with only the new key', async () => {
    const existing = connection()
    vi.mocked(connectionsApi.rotate).mockResolvedValue({ pending: false, connection: { ...existing, updatedAt: new Date().toISOString() } })
    const onConnected = vi.fn()
    render(<ConnectFlow embedded onCancel={() => {}} rotateConnection={existing} onConnected={onConnected} />)

    expect(await screen.findByText('Replace the key of OpenAI')).toBeInTheDocument()
    expect(screen.queryByTestId('who-can-use')).not.toBeInTheDocument()
    fireEvent.change(await screen.findByLabelText('API key'), { target: { value: 'sk-new' } })
    fireEvent.click(screen.getByRole('button', { name: 'Replace key' }))

    await waitFor(() => expect(connectionsApi.rotate).toHaveBeenCalledWith('conn-1', { input: { apiKey: 'sk-new' } }))
    await waitFor(() => expect(onConnected).toHaveBeenCalled())
    expect(connectionsApi.connect).not.toHaveBeenCalled()
  })
})

describe('who can use it', () => {
  it('defaults to the organization and sends owner private once changed to only you', async () => {
    vi.mocked(connectionsApi.connect).mockResolvedValue({ pending: false, connection: connection({ owner: 'private' }) })
    render(<ConnectFlow embedded onCancel={() => {}} connectorKey="openai" onConnected={() => {}} />)
    const line = await screen.findByTestId('who-can-use')
    expect(line).toHaveTextContent('Everyone')
    fireEvent.click(within(line).getByRole('button', { name: 'Change' }))
    // Organization or only you: this organization has no teams, so there is no team to pick.
    expect(screen.queryByRole('radio', { name: /^One team/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: /^Only you/ }))

    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-test-123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(connectionsApi.connect).toHaveBeenCalledWith('openai', expect.objectContaining({ owner: 'private' })))
  })

  it('offers nothing to change when the organization keeps personal keys off', async () => {
    vi.mocked(organizationsApi.getById).mockResolvedValue({ id: 'test-org-id', plan: 'pro', settings: { allowUserScopedConnections: false } })
    render(<ConnectFlow embedded onCancel={() => {}} connectorKey="openai" onConnected={() => {}} />)
    const line = await screen.findByTestId('who-can-use')
    await waitFor(() => expect(organizationsApi.getById).toHaveBeenCalled())
    await waitFor(() => expect(within(line).queryByRole('button', { name: 'Change' })).not.toBeInTheDocument())
  })

  it('a member connects a key only they can use', async () => {
    Object.assign(role, { role: 'member', canManage: false })
    vi.mocked(connectionsApi.connect).mockResolvedValue({ pending: false, connection: connection({ owner: 'private' }) })
    render(<ConnectFlow embedded onCancel={() => {}} connectorKey="openai" onConnected={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('who-can-use')).toHaveTextContent('Only you'))
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-test-123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(connectionsApi.connect).toHaveBeenCalledWith('openai', expect.objectContaining({ owner: 'private' })))
  })

  it('a member of an organization without personal keys is told to ask an admin', async () => {
    Object.assign(role, { role: 'member', canManage: false })
    vi.mocked(organizationsApi.getById).mockResolvedValue({ id: 'test-org-id', plan: 'pro', settings: { allowUserScopedConnections: false } })
    render(<ConnectFlow embedded onCancel={() => {}} connectorKey="openai" onConnected={() => {}} />)
    expect(await screen.findByTestId('connect-admins-only')).toHaveTextContent('Only admins can add credentials')
    expect(screen.queryByLabelText('API key')).not.toBeInTheDocument()
  })

  it('offers one team too, like a provider connection, and sends the team picked', async () => {
    vi.mocked(organizationsApi.getTeams).mockResolvedValue([{ id: 'team-1', name: 'Support', isDefault: false }, { id: 'team-2', name: 'Sales', isDefault: false }])
    vi.mocked(connectionsApi.connect).mockResolvedValue({ pending: false, connection: connection({ owner: 'team', teamId: 'team-1' }) })
    render(<ConnectFlow embedded onCancel={() => {}} connectorKey="openai" onConnected={() => {}} />)
    const line = await screen.findByTestId('who-can-use')
    fireEvent.click(within(line).getByRole('button', { name: 'Change' }))
    await waitFor(() => expect(screen.getByRole('radio', { name: /^One team/ })).toBeEnabled())
    // The three choices a provider connection has.
    for (const name of [/^Only you/, /^One team/, /^Everyone/]) expect(screen.getByRole('radio', { name })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: /^One team/ }))

    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-test-123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(connectionsApi.connect).toHaveBeenCalledWith('openai', expect.objectContaining({ owner: 'team', teamId: 'team-1' })))
  })

  it('a member without personal keys can still add one for a team', async () => {
    Object.assign(role, { role: 'member', canManage: false })
    vi.mocked(organizationsApi.getById).mockResolvedValue({ id: 'test-org-id', plan: 'pro', settings: { allowUserScopedConnections: false } })
    vi.mocked(organizationsApi.getTeams).mockResolvedValue([{ id: 'team-1', name: 'Support', isDefault: false }])
    vi.mocked(connectionsApi.connect).mockResolvedValue({ pending: false, connection: connection({ owner: 'team', teamId: 'team-1' }) })
    render(<ConnectFlow embedded onCancel={() => {}} connectorKey="openai" onConnected={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('who-can-use')).toHaveTextContent('One team'))
    expect(screen.queryByTestId('connect-admins-only')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-test-123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(connectionsApi.connect).toHaveBeenCalledWith('openai', expect.objectContaining({ owner: 'team', teamId: 'team-1' })))
  })
})

describe('splitConnectSchema', () => {
  it('puts required and secret fields up front and the rest under Advanced', () => {
    const { main, extra } = splitConnectSchema(vllm.connect[0].schema)
    expect(Object.keys(main.properties)).toEqual(['baseUrl', 'apiKey'])
    expect(main.required).toEqual(['baseUrl'])
    expect(Object.keys(extra!.properties)).toEqual(['healthPath'])
  })

  it('keeps everything up front when nothing is required or secret', () => {
    const { main, extra } = splitConnectSchema({ type: 'object', properties: { a: { type: 'string' } } })
    expect(Object.keys(main.properties)).toEqual(['a'])
    expect(extra).toBeNull()
  })

  it('keeps fields marked x-advanced under Advanced, secret or not, unless they are required', () => {
    const { main, extra } = splitConnectSchema(mcpServer.connect[1].schema)
    expect(Object.keys(main.properties)).toEqual(['serverUrl'])
    expect(Object.keys(extra!.properties)).toEqual(['clientId', 'clientSecret'])
  })
})
