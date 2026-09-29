import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, fireEvent } from '@testing-library/react'

import { render } from '../../../test/setup'
import { McpServerForm } from '../mcp-server-form'

vi.mock('../../../lib/api', () => ({
  mcpSourcesApi: {
    create: vi.fn(),
  },
}))

vi.mock('../../../lib/connections-api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/connections-api')>('../../../lib/connections-api')
  return {
    ...actual,
    connectionsApi: {
      list: vi.fn().mockResolvedValue([
        { id: 'conn-mcp-1', name: 'Team MCP', connectorKey: 'mcp-custom', connectorDisplayName: 'MCP server', kind: 'mcp', owner: 'org', health: { status: 'valid' }, createdAt: '2026-01-01T00:00:00.000Z' },
      ]),
    },
  }
})

const navigateMock = vi.fn()
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual<typeof import('react-router-dom')>('react-router-dom')),
  useNavigate: () => navigateMock,
}))

const successMock = vi.fn()
const errorMock = vi.fn()
vi.mock('../../../store/app', () => ({
  useNotifications: () => ({ success: successMock, error: errorMock, info: vi.fn() }),
}))

import { mcpSourcesApi } from '../../../lib/api'

const mockedCreate = mcpSourcesApi.create as ReturnType<typeof vi.fn>

describe('McpServerForm (/tools/mcp-servers/new)', () => {
  beforeEach(() => {
    mockedCreate.mockReset()
    successMock.mockReset()
    errorMock.mockReset()
    navigateMock.mockReset()
  })

  it('renders name, url, and an optional token picked from Credentials, as a page', () => {
    render(<McpServerForm organizationId="org-1" />)

    expect(screen.getByRole('heading', { name: 'Add MCP server' })).toBeInTheDocument()
    expect(screen.getByLabelText(/^name/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/server url/i)).toBeInTheDocument()
    // The token is a credential: picked, or created with "Create one here". Never pasted onto the server row.
    expect(screen.getByRole('combobox', { name: /token/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create one here' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('an empty submit marks name and URL and focuses the name', async () => {
    render(<McpServerForm organizationId="org-1" />)
    fireEvent.click(screen.getByRole('button', { name: /add server/i }))

    const name = screen.getByLabelText(/^name/i)
    await waitFor(() => expect(name).toHaveAttribute('aria-invalid', 'true'))
    expect(screen.getByLabelText(/server url/i)).toHaveAttribute('aria-invalid', 'true')
    await waitFor(() => expect(document.activeElement).toBe(name))
    expect(mockedCreate).not.toHaveBeenCalled()
  })

  it('creates the source and reports discovered tool count', async () => {
    mockedCreate.mockResolvedValue({
      source: { id: 'src-1', name: 'weather', status: 'active', toolCount: 3 },
      sync: { added: 3, updated: 0, removed: 0, total: 3 },
      syncError: null,
    })

    render(<McpServerForm organizationId="org-1" />)

    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: 'weather' } })
    fireEvent.change(screen.getByLabelText(/server url/i), {
      target: { value: 'https://mcp.example.com/mcp' },
    })
    fireEvent.click(screen.getByRole('button', { name: /add server/i }))

    await waitFor(() => {
      expect(mockedCreate).toHaveBeenCalledWith('org-1', {
        name: 'weather',
        url: 'https://mcp.example.com/mcp',
      })
    })
    await waitFor(() => {
      expect(successMock).toHaveBeenCalledWith('MCP server added', expect.stringContaining('3 tools'))
    })
    // Back to the tools list, where the discovered tools appear.
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/tools', undefined))
  })

  it('sends no token when none is picked', async () => {
    mockedCreate.mockResolvedValue({
      source: { id: 'src-1' },
      sync: { added: 0, updated: 0, removed: 0, total: 0 },
      syncError: null,
    })

    render(<McpServerForm organizationId="org-1" />)

    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: 'weather' } })
    fireEvent.change(screen.getByLabelText(/server url/i), {
      target: { value: 'https://mcp.example.com/mcp' },
    })
    fireEvent.click(screen.getByRole('button', { name: /add server/i }))

    await waitFor(() => {
      expect(mockedCreate).toHaveBeenCalledWith('org-1', {
        name: 'weather',
        url: 'https://mcp.example.com/mcp',
      })
    })
  })

  it('surfaces a partial failure when the source saved but the sync failed', async () => {
    mockedCreate.mockResolvedValue({
      source: { id: 'src-1', status: 'error' },
      sync: null,
      syncError: 'MCP server returned HTTP 401 for initialize',
    })

    render(<McpServerForm organizationId="org-1" />)

    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: 'weather' } })
    fireEvent.change(screen.getByLabelText(/server url/i), {
      target: { value: 'https://mcp.example.com/mcp' },
    })
    fireEvent.click(screen.getByRole('button', { name: /add server/i }))

    await waitFor(() => {
      expect(errorMock).toHaveBeenCalledWith(
        'Server added, sync failed',
        expect.stringContaining('HTTP 401'),
      )
    })
  })

  it('shows the backend error message when creation fails outright', async () => {
    mockedCreate.mockRejectedValue({
      response: { data: { message: 'MCP server URL rejected: Blocked private/reserved IP' } },
    })

    render(<McpServerForm organizationId="org-1" />)

    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: 'internal' } })
    fireEvent.change(screen.getByLabelText(/server url/i), {
      target: { value: 'http://10.0.0.5/mcp' },
    })
    fireEvent.click(screen.getByRole('button', { name: /add server/i }))

    await waitFor(() => {
      expect(errorMock).toHaveBeenCalledWith('Error', expect.stringContaining('Blocked private'))
    })
  })

  it('sends the credential picked for the token as credentialId, never a token', async () => {
    mockedCreate.mockResolvedValue({ source: { id: 'src-1' }, sync: { total: 1 }, syncError: null })
    if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
    render(<McpServerForm organizationId="org-1" />)

    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: 'weather' } })
    fireEvent.change(screen.getByLabelText(/server url/i), { target: { value: 'https://mcp.example.com/mcp' } })
    fireEvent.click(screen.getByRole('combobox', { name: /token/i }))
    fireEvent.click(await screen.findByRole('option', { name: /Team MCP/ }))
    expect(await screen.findByTestId('credential-picker-open')).toHaveTextContent('Open Team MCP')

    fireEvent.click(screen.getByRole('button', { name: /add server/i }))
    await waitFor(() => {
      expect(mockedCreate).toHaveBeenCalledWith('org-1', {
        name: 'weather',
        url: 'https://mcp.example.com/mcp',
        credentialId: 'conn-mcp-1',
      })
    })
    const sent = mockedCreate.mock.calls[0][1]
    expect(sent).not.toHaveProperty('bearerToken')
    expect(sent).not.toHaveProperty('connectionId')
  })
})
