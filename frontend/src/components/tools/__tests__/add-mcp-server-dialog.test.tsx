import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, fireEvent } from '@testing-library/react'

import { render } from '../../../test/setup'
import { AddMcpServerDialog } from '../add-mcp-server-dialog'

vi.mock('../../../lib/api', () => ({
  mcpSourcesApi: {
    create: vi.fn(),
  },
}))

const successMock = vi.fn()
const errorMock = vi.fn()
vi.mock('../../../store/app', () => ({
  useNotifications: () => ({ success: successMock, error: errorMock, info: vi.fn() }),
}))

import { mcpSourcesApi } from '../../../lib/api'

const mockedCreate = mcpSourcesApi.create as ReturnType<typeof vi.fn>

describe('AddMcpServerDialog', () => {
  beforeEach(() => {
    mockedCreate.mockReset()
    successMock.mockReset()
    errorMock.mockReset()
  })

  it('renders name, url, and optional auth token fields', () => {
    render(<AddMcpServerDialog open onOpenChange={() => {}} organizationId="org-1" />)

    expect(screen.getByText('Add MCP Server')).toBeInTheDocument()
    expect(screen.getByLabelText(/name/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/server url/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/auth token/i)).toBeInTheDocument()
    // Submit is disabled until name + url are filled.
    expect(screen.getByRole('button', { name: /add server/i })).toBeDisabled()
  })

  it('creates the source and reports discovered tool count', async () => {
    mockedCreate.mockResolvedValue({
      source: { id: 'src-1', name: 'weather', status: 'active', toolCount: 3 },
      sync: { added: 3, updated: 0, removed: 0, total: 3 },
      syncError: null,
    })
    const onOpenChange = vi.fn()

    render(<AddMcpServerDialog open onOpenChange={onOpenChange} organizationId="org-1" />)

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'weather' } })
    fireEvent.change(screen.getByLabelText(/server url/i), {
      target: { value: 'https://mcp.example.com/mcp' },
    })
    fireEvent.change(screen.getByLabelText(/auth token/i), { target: { value: 'tok-123' } })
    fireEvent.click(screen.getByRole('button', { name: /add server/i }))

    await waitFor(() => {
      expect(mockedCreate).toHaveBeenCalledWith('org-1', {
        name: 'weather',
        url: 'https://mcp.example.com/mcp',
        bearerToken: 'tok-123',
      })
    })
    await waitFor(() => {
      expect(successMock).toHaveBeenCalledWith('MCP server added', expect.stringContaining('3 tools'))
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('omits bearerToken from the payload when left empty', async () => {
    mockedCreate.mockResolvedValue({
      source: { id: 'src-1' },
      sync: { added: 0, updated: 0, removed: 0, total: 0 },
      syncError: null,
    })

    render(<AddMcpServerDialog open onOpenChange={() => {}} organizationId="org-1" />)

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'weather' } })
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

    render(<AddMcpServerDialog open onOpenChange={() => {}} organizationId="org-1" />)

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'weather' } })
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

    render(<AddMcpServerDialog open onOpenChange={() => {}} organizationId="org-1" />)

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'internal' } })
    fireEvent.change(screen.getByLabelText(/server url/i), {
      target: { value: 'http://10.0.0.5/mcp' },
    })
    fireEvent.click(screen.getByRole('button', { name: /add server/i }))

    await waitFor(() => {
      expect(errorMock).toHaveBeenCalledWith('Error', expect.stringContaining('Blocked private'))
    })
  })
})
