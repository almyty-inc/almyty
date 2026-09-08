import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'

import { render } from '../../../test/setup'
import { ConnectSheet } from '../connect-sheet'
import { connectionsApi, connectorsApi } from '../../../lib/connections-api'
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
  organizationsApi: { getById: vi.fn().mockResolvedValue({ id: 'test-org-id', plan: 'free', settings: {} }) },
}))

vi.mock('../../../store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'test-org-id', name: 'Test Org' } }),
}))

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

const slack: Connector = {
  key: 'slack',
  kind: 'channel',
  displayName: 'Slack',
  connect: [{ type: 'oauth2_code', label: 'Add to Slack', scopes: ['chat:write'] }],
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

describe('ConnectSheet', () => {
  let openSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(connectorsApi.list).mockResolvedValue([openai, slack])
    openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
  })

  afterEach(() => {
    openSpy.mockRestore()
  })

  it('lists connectors of the requested kind and drills into one', async () => {
    const anthropic: Connector = { key: 'anthropic', kind: 'inference', displayName: 'Anthropic', connect: [{ type: 'api_key', label: 'API key' }] }
    vi.mocked(connectorsApi.list).mockResolvedValue([openai, anthropic, slack])
    render(<ConnectSheet open onOpenChange={() => {}} kind="inference" onConnected={() => {}} />)
    expect(await screen.findByTestId('connector-option-openai')).toBeInTheDocument()
    expect(screen.queryByTestId('connector-option-slack')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('connector-option-openai'))
    expect(await screen.findByText('Connect OpenAI')).toBeInTheDocument()
    expect(screen.getByTestId('connect-instructions')).toHaveTextContent('Create a key in the OpenAI dashboard.')
    expect(screen.getByRole('link', { name: /Get your key/ })).toHaveAttribute('href', 'https://platform.openai.com/api-keys')
  })

  it('posts the api_key form as input and hands the connection back', async () => {
    const created = connection()
    vi.mocked(connectionsApi.connect).mockResolvedValue({ pending: false, connection: created })
    const onConnected = vi.fn()
    const onOpenChange = vi.fn()
    render(<ConnectSheet open onOpenChange={onOpenChange} connectorKey="openai" onConnected={onConnected} />)

    const keyInput = await screen.findByLabelText('API key')
    fireEvent.change(keyInput, { target: { value: 'sk-test-123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(connectionsApi.connect).toHaveBeenCalledWith('openai', { method: 'api_key', owner: 'org', input: { apiKey: 'sk-test-123' } }))
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(created))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('refuses to post until the required field is filled', async () => {
    render(<ConnectSheet open onOpenChange={() => {}} connectorKey="openai" onConnected={() => {}} />)
    await screen.findByLabelText('API key')
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(await screen.findByText('API key is required')).toBeInTheDocument()
    expect(connectionsApi.connect).not.toHaveBeenCalled()
  })

  it('shows a live validation failure inline and lets the user retry', async () => {
    const kept = connection({ health: { status: 'failed', error: 'invalid api key' } })
    vi.mocked(connectionsApi.connect)
      .mockRejectedValueOnce({ response: { status: 422, data: { code: 'CONNECTION_VALIDATION_FAILED', message: 'invalid api key', connection: kept } } })
      .mockResolvedValueOnce({ pending: false, connection: connection() })
    const onConnected = vi.fn()
    render(<ConnectSheet open onOpenChange={() => {}} connectorKey="openai" onConnected={onConnected} />)

    fireEvent.change(await screen.findByLabelText('API key'), { target: { value: 'sk-bad' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    const failure = await screen.findByTestId('connect-failure')
    expect(failure).toHaveTextContent('invalid api key')
    expect(failure).toHaveTextContent('kept as failed')
    expect(onConnected).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-good' } })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1))
    expect(connectionsApi.connect).toHaveBeenLastCalledWith('openai', { method: 'api_key', owner: 'org', input: { apiKey: 'sk-good' } })
  })

  it('opens the authorize URL in a new tab and polls until the connection lands', async () => {
    vi.mocked(connectionsApi.connect).mockResolvedValue({
      pending: true,
      method: 'oauth2_code',
      mode: 'browser',
      authorizeUrl: 'https://slack.com/oauth/authorize?state=st-1',
      state: 'st-1',
      expiresInSeconds: 600,
      completeWith: 'callback',
    })
    const landed = connection({ id: 'conn-slack', name: 'Slack', connectorKey: 'slack', kind: 'channel' })
    vi.mocked(connectionsApi.list)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([landed])
    const onConnected = vi.fn()
    render(<ConnectSheet open onOpenChange={() => {}} connectorKey="slack" onConnected={onConnected} pollIntervalMs={5} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Continue with Slack' }))

    await waitFor(() => expect(connectionsApi.connect).toHaveBeenCalledWith('slack', { method: 'oauth2_code', owner: 'org' }))
    await waitFor(() => expect(openSpy).toHaveBeenCalledWith('https://slack.com/oauth/authorize?state=st-1', '_blank', 'noopener'))
    expect(await screen.findByTestId('oauth-waiting')).toBeInTheDocument()
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(landed))
    expect(connectionsApi.list).toHaveBeenCalledTimes(2)
  })

  it('offers a paste-the-code fallback that completes the flow', async () => {
    vi.mocked(connectionsApi.connect).mockResolvedValue({
      pending: true,
      method: 'oauth2_code',
      mode: 'browser',
      authorizeUrl: 'https://slack.com/oauth/authorize',
      state: 'st-2',
      expiresInSeconds: 600,
      completeWith: 'callback',
    })
    vi.mocked(connectionsApi.list).mockResolvedValue([])
    const landed = connection({ id: 'conn-slack', name: 'Slack', connectorKey: 'slack', kind: 'channel' })
    vi.mocked(connectionsApi.complete).mockResolvedValue(landed)
    const onConnected = vi.fn()
    render(<ConnectSheet open onOpenChange={() => {}} connectorKey="slack" onConnected={onConnected} pollIntervalMs={50} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Continue with Slack' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Paste the code instead' }))
    fireEvent.change(screen.getByLabelText('Authorization code'), { target: { value: 'code-xyz' } })
    fireEvent.click(screen.getByRole('button', { name: /Finish/ }))

    await waitFor(() => expect(connectionsApi.complete).toHaveBeenCalledWith('slack', { state: 'st-2', code: 'code-xyz' }))
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(landed))
  })

  it('rotates through POST /connections/:id/rotate with only the input', async () => {
    const existing = connection()
    vi.mocked(connectionsApi.rotate).mockResolvedValue({ pending: false, connection: { ...existing, updatedAt: new Date().toISOString() } })
    const onConnected = vi.fn()
    render(<ConnectSheet open onOpenChange={() => {}} rotateConnection={existing} onConnected={onConnected} />)

    expect(await screen.findByText('Rotate OpenAI')).toBeInTheDocument()
    fireEvent.change(await screen.findByLabelText('API key'), { target: { value: 'sk-new' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }))

    await waitFor(() => expect(connectionsApi.rotate).toHaveBeenCalledWith('conn-1', { input: { apiKey: 'sk-new' } }))
    await waitFor(() => expect(onConnected).toHaveBeenCalled())
    expect(connectionsApi.connect).not.toHaveBeenCalled()
  })
})
