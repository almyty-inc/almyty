/**
 * The connect flow, inline (as "Connect an account" opens it inside another
 * form) and on its own: tiles, the one field a service needs, who can use
 * it, the check on save, and everything else under Advanced.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'

import { render } from '../../../test/setup'
import { ConnectAccountButton, ConnectFlow, splitConnectSchema } from '../connect-flow'
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
  vi.mocked(connectorsApi.list).mockResolvedValue([openai, vllm, slack])
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
    expect(await screen.findByText('Connect OpenAI')).toBeInTheDocument()
    // One field, a link to where the key is made, and who can use it.
    expect(screen.getByLabelText('API key')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Get a key/ })).toHaveAttribute('href', 'https://platform.openai.com/api-keys')
    expect(screen.getByTestId('who-can-use')).toHaveTextContent('Who can use it: everyone in your organization')
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
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(connectionsApi.connect).toHaveBeenCalledWith('openai', { method: 'api_key', owner: 'org', input: { apiKey: 'sk-test-123' } }))
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(created))
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('refuses to post until the key is filled', async () => {
    render(<ConnectFlow embedded onCancel={() => {}} connectorKey="openai" onConnected={() => {}} />)
    await screen.findByLabelText('API key')
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    const failure = await screen.findByTestId('connect-failure')
    expect(failure).toHaveTextContent('OpenAI did not accept this.')
    expect(within(failure).getByText('provider rejected the credential (401)')).toBeInTheDocument()
    expect(screen.getByLabelText('API key')).toHaveValue('sk-bad')
    expect(onConnected).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-good' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() =>
      expect(connectionsApi.connect).toHaveBeenCalledWith('openai-compatible', expect.objectContaining({ input: { baseUrl: 'https://llm.example.com/v1', healthPath: '/health' } })),
    )
  })

  it('connects a sign-in service with one Connect button, waits, and hands back what the callback made', async () => {
    vi.mocked(connectionsApi.connect).mockResolvedValue(redirect('st-1'))
    const landed = connection({ id: 'conn-slack', name: 'Slack', connectorKey: 'channel-slack', kind: 'channel' })
    vi.mocked(connectionsApi.list).mockResolvedValueOnce([]).mockResolvedValueOnce([landed])
    const onConnected = vi.fn()
    render(<ConnectFlow embedded onCancel={() => {}} connectorKey="channel-slack" onConnected={onConnected} pollIntervalMs={5} />)

    // Nothing to paste; the bot-token way waits under Advanced.
    expect(await screen.findByText(/You sign in at Slack and come back here/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Bot token')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(connectionsApi.connect).toHaveBeenCalledWith('channel-slack', { method: 'oauth2_code', owner: 'org' }))
    await waitFor(() => expect(openSpy).toHaveBeenCalledWith('https://slack.com/oauth/authorize?state=st-1', '_blank', 'noopener'))
    expect(await screen.findByTestId('oauth-waiting')).toBeInTheDocument()
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(landed))
  })

  it('offers the other way to connect under Advanced', async () => {
    vi.mocked(connectionsApi.connect).mockResolvedValue({ pending: false, connection: connection({ connectorKey: 'channel-slack' }) })
    render(<ConnectFlow embedded onCancel={() => {}} connectorKey="channel-slack" onConnected={() => {}} />)
    await screen.findByText(/You sign in at Slack/)
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Bot token' }))
    fireEvent.change(await screen.findByLabelText('Bot token'), { target: { value: 'xoxb-123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(connectionsApi.connect).toHaveBeenCalledWith('channel-slack', { method: 'api_key', owner: 'org', input: { bot_token: 'xoxb-123' } }))
  })

  it('keeps pasting a sign-in code under Advanced, and finishes with it', async () => {
    vi.mocked(connectionsApi.connect).mockResolvedValue(redirect('st-2'))
    vi.mocked(connectionsApi.list).mockResolvedValue([])
    const landed = connection({ id: 'conn-slack', name: 'Slack', connectorKey: 'channel-slack', kind: 'channel' })
    vi.mocked(connectionsApi.complete).mockResolvedValue(landed)
    const onConnected = vi.fn()
    render(<ConnectFlow embedded onCancel={() => {}} connectorKey="channel-slack" onConnected={onConnected} pollIntervalMs={50} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }))
    await screen.findByTestId('oauth-waiting')
    expect(screen.queryByLabelText('Code from the service')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    fireEvent.change(screen.getByLabelText('Code from the service'), { target: { value: 'code-xyz' } })
    fireEvent.click(screen.getByRole('button', { name: /Finish/ }))

    await waitFor(() => expect(connectionsApi.complete).toHaveBeenCalledWith('channel-slack', { state: 'st-2', code: 'code-xyz' }))
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(landed))
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
    expect(line).toHaveTextContent('everyone in your organization')
    fireEvent.click(within(line).getByRole('button', { name: 'Change' }))
    // Organization or only you; a team is not something a connection is shared with here.
    expect(screen.queryByRole('radio', { name: /Team/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: /Private/ }))

    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-test-123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
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
    await waitFor(() => expect(screen.getByTestId('who-can-use')).toHaveTextContent('only you'))
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-test-123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(connectionsApi.connect).toHaveBeenCalledWith('openai', expect.objectContaining({ owner: 'private' })))
  })

  it('a member of an organization without personal keys is told to ask an admin', async () => {
    Object.assign(role, { role: 'member', canManage: false })
    vi.mocked(organizationsApi.getById).mockResolvedValue({ id: 'test-org-id', plan: 'pro', settings: { allowUserScopedConnections: false } })
    render(<ConnectFlow embedded onCancel={() => {}} connectorKey="openai" onConnected={() => {}} />)
    expect(await screen.findByTestId('connect-admins-only')).toHaveTextContent('Only admins can connect services')
    expect(screen.queryByLabelText('API key')).not.toBeInTheDocument()
  })
})

describe('ConnectAccountButton', () => {
  it('opens the flow inline, inside the other form, without a dialog or a nested form', async () => {
    const created = connection()
    vi.mocked(connectionsApi.connect).mockResolvedValue({ pending: false, connection: created })
    const onConnected = vi.fn()
    const outerSubmit = vi.fn((e: Event) => e.preventDefault())
    render(
      <form onSubmit={outerSubmit as any} data-testid="consumer-form">
        <ConnectAccountButton connectorKey="openai" onConnected={onConnected} />
      </form>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Connect an account' }))
    expect(await screen.findByText('Connect OpenAI')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // A <form> inside the other <form> would submit it.
    expect(screen.getByTestId('consumer-form').querySelectorAll('form')).toHaveLength(0)

    const key = await screen.findByLabelText('API key')
    fireEvent.change(key, { target: { value: 'sk-inline' } })
    fireEvent.keyDown(key, { key: 'Enter' })

    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(created))
    expect(connectionsApi.connect).toHaveBeenCalledWith('openai', { method: 'api_key', owner: 'org', input: { apiKey: 'sk-inline' } })
    expect(outerSubmit).not.toHaveBeenCalled()
    expect(await screen.findByRole('button', { name: 'Connect an account' })).toBeInTheDocument()
  })

  it('Cancel folds the flow away without connecting', async () => {
    render(<ConnectAccountButton connectorKey="openai" onConnected={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Connect an account' }))
    await screen.findByLabelText('API key')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('API key')).not.toBeInTheDocument()
    expect(connectionsApi.connect).not.toHaveBeenCalled()
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
})
