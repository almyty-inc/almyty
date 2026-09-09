/**
 * One consumer end to end: the Add MCP Server dialog's "Connect an account"
 * action opens the connect sheet, and the connection it returns lands in the
 * dialog's own payload as credentialId while the pasted token is dropped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'

import { render } from '../../../test/setup'
import { AddMcpServerDialog } from '../../tools/add-mcp-server-dialog'
import { mcpSourcesApi } from '../../../lib/api'
import { connectionsApi, connectorsApi } from '../../../lib/connections-api'
import type { Connection, Connector } from '@/types/connections'

vi.mock('../../../lib/api', () => ({
  mcpSourcesApi: { create: vi.fn() },
  organizationsApi: { getById: vi.fn().mockResolvedValue({ id: 'test-org-id', plan: 'free', settings: {} }) },
}))

vi.mock('../../../lib/connections-api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/connections-api')>('../../../lib/connections-api')
  return {
    ...actual,
    connectorsApi: { list: vi.fn(), create: vi.fn() },
    connectionsApi: { list: vi.fn(), connect: vi.fn(), complete: vi.fn(), rotate: vi.fn() },
  }
})

const notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('../../../store/app', () => ({ useNotifications: () => notify }))

vi.mock('../../../store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'test-org-id', name: 'Test Org' } }),
}))

const mcpConnector: Connector = {
  key: 'mcp-custom',
  kind: 'mcp',
  displayName: 'MCP server',
  connect: [
    {
      type: 'api_key',
      label: 'Server URL and token',
      schema: {
        type: 'object',
        properties: {
          serverUrl: { type: 'string', title: 'Server URL' },
          apiKey: { type: 'string', title: 'Bearer token', 'x-secret': true },
        },
        required: ['serverUrl'],
      },
    },
  ],
}

const connected: Connection = {
  id: 'conn-mcp-1',
  name: 'MCP server',
  connectorKey: 'mcp-custom',
  kind: 'mcp',
  owner: 'org',
  accountLabel: 'https://mcp.example.com/mcp',
  health: { status: 'valid' },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

describe('AddMcpServerDialog connect entry point', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(connectorsApi.list).mockResolvedValue([mcpConnector])
    vi.mocked(connectionsApi.connect).mockResolvedValue({ pending: false, connection: connected })
    vi.mocked(mcpSourcesApi.create).mockResolvedValue({ source: { id: 'src-1' }, sync: { total: 2 }, syncError: null })
  })

  it('keeps the raw token flow and offers the connect action beside it', () => {
    render(<AddMcpServerDialog open onOpenChange={() => {}} organizationId="org-1" />)
    expect(screen.getByLabelText(/auth token/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect an account' })).toBeInTheDocument()
    expect(screen.queryByTestId('connected-chip')).not.toBeInTheDocument()
  })

  it('opens the sheet filtered to MCP connectors and selects the returned connection in the dialog', async () => {
    const onOpenChange = vi.fn()
    render(<AddMcpServerDialog open onOpenChange={onOpenChange} organizationId="org-1" />)

    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: 'weather' } })
    fireEvent.change(screen.getByLabelText(/server url/i), { target: { value: 'https://mcp.example.com/mcp' } })
    fireEvent.change(screen.getByLabelText(/auth token/i), { target: { value: 'tok-typed' } })

    fireEvent.click(screen.getByRole('button', { name: 'Connect an account' }))
    expect(await screen.findByText('Connect MCP server')).toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalled()
    await waitFor(() => expect(connectorsApi.list).toHaveBeenCalled())

    const sheet = within(screen.getByRole('dialog', { name: 'Connect MCP server' }))
    fireEvent.change(await sheet.findByLabelText('Server URL'), { target: { value: 'https://mcp.example.com/mcp' } })
    fireEvent.change(sheet.getByLabelText('Bearer token'), { target: { value: 'tok-secret' } })
    fireEvent.click(sheet.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(connectionsApi.connect).toHaveBeenCalledWith('mcp-custom', { method: 'api_key', owner: 'org', input: { serverUrl: 'https://mcp.example.com/mcp', apiKey: 'tok-secret' } }))
    await waitFor(() => expect(onOpenChange).not.toHaveBeenCalled())
    const chip = await screen.findByTestId('connected-chip')
    expect(chip).toHaveTextContent('MCP server')
    // The typed token was replaced by the connection.
    expect(screen.getByLabelText(/auth token/i)).toHaveValue('')

    fireEvent.click(screen.getByRole('button', { name: /add server/i }))
    await waitFor(() => expect(mcpSourcesApi.create).toHaveBeenCalledWith('org-1', { name: 'weather', url: 'https://mcp.example.com/mcp', credentialId: 'conn-mcp-1' }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('lets the user drop the connection and go back to a token', async () => {
    render(<AddMcpServerDialog open onOpenChange={() => {}} organizationId="org-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Connect an account' }))
    const sheet = within(await screen.findByRole('dialog', { name: 'Connect MCP server' }))
    fireEvent.change(await sheet.findByLabelText('Server URL'), { target: { value: 'https://mcp.example.com/mcp' } })
    fireEvent.click(sheet.getByRole('button', { name: 'Connect' }))
    await screen.findByTestId('connected-chip')

    fireEvent.click(screen.getByRole('button', { name: 'Remove MCP server' }))
    expect(screen.queryByTestId('connected-chip')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect an account' })).toBeInTheDocument()
  })
})
