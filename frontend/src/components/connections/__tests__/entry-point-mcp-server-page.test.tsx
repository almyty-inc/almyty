/**
 * One consumer end to end: the Add MCP server page's token is the shared
 * pick-or-create credential control. "Create one here" opens the add flow
 * inline, the credential it makes lands on Credentials and comes back
 * picked, and the page sends it as credentialId; no token is pasted onto
 * the server row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'

import { render } from '../../../test/setup'
import { McpServerForm } from '../../tools/mcp-server-form'
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

const other: Connector = {
  key: 'other',
  kind: 'tool_source',
  displayName: 'Other service',
  validation: { kind: 'format' },
  connect: [{ type: 'api_key', label: 'Key', schema: { type: 'object', properties: { apiKey: { type: 'string', title: 'Key', 'x-secret': true } }, required: ['apiKey'] } }],
}

const made: Connection = {
  id: 'cred-weather',
  name: 'weather token',
  connectorKey: 'other',
  connectorDisplayName: 'Other service',
  kind: 'tool_source',
  owner: 'org',
  health: { status: 'valid' },
  createdAt: new Date().toISOString(),
}

describe('Add MCP server: the token is a credential', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(connectorsApi.list).mockResolvedValue([other])
    vi.mocked(connectionsApi.list).mockResolvedValue([])
    vi.mocked(connectionsApi.connect).mockResolvedValue({ pending: false, connection: made })
    vi.mocked(mcpSourcesApi.create).mockResolvedValue({ source: { id: 'src-1' }, sync: { total: 2 }, syncError: null })
  })

  it('creates the token here, inline, without submitting the page, and sends it as credentialId', async () => {
    render(<McpServerForm organizationId="org-1" />)

    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: 'weather' } })
    fireEvent.change(screen.getByLabelText(/server url/i), { target: { value: 'https://mcp.example.com/mcp' } })

    fireEvent.click(screen.getByRole('button', { name: 'Create one here' }))
    const sheet = within(await screen.findByTestId('credential-form'))
    expect(sheet.getByLabelText('Name')).toHaveValue('weather token')
    fireEvent.change(await sheet.findByLabelText('Key'), { target: { value: 'tok-secret' } })
    fireEvent.click(sheet.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(connectionsApi.connect).toHaveBeenCalledWith('other', { method: 'api_key', owner: 'org', name: 'weather token', input: { apiKey: 'tok-secret' } }))
    // Saving inside the inline flow does not submit the page's own form.
    expect(mcpSourcesApi.create).not.toHaveBeenCalled()
    expect(await screen.findByTestId('credential-picker-open')).toHaveTextContent('Open weather token')

    fireEvent.click(screen.getByRole('button', { name: /add server/i }))
    await waitFor(() => expect(mcpSourcesApi.create).toHaveBeenCalledWith('org-1', { name: 'weather', url: 'https://mcp.example.com/mcp', credentialId: 'cred-weather' }))
  })

  it('folds the create panel away on Cancel and sends no token', async () => {
    render(<McpServerForm organizationId="org-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Create one here' }))
    const sheet = within(await screen.findByTestId('credential-form'))
    fireEvent.click(sheet.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByTestId('credential-form')).not.toBeInTheDocument())

    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: 'weather' } })
    fireEvent.change(screen.getByLabelText(/server url/i), { target: { value: 'https://mcp.example.com/mcp' } })
    fireEvent.click(screen.getByRole('button', { name: /add server/i }))
    await waitFor(() => expect(mcpSourcesApi.create).toHaveBeenCalledWith('org-1', { name: 'weather', url: 'https://mcp.example.com/mcp' }))
  })
})
