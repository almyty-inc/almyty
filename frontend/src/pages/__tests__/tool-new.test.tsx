/**
 * Creating a manual tool happens on its own page (/tools/new), not in a
 * dialog on the Tools list. "Private (just me)" picked there has to reach
 * the create call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderWithProviders } from '@/test/setup'
import { ToolNewPage } from '../tool-new'
import { toolsApi } from '@/lib/api'

const navigate = vi.fn()

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => navigate }
})

vi.mock('@/lib/api', () => ({
  toolsApi: { create: vi.fn() },
  llmProvidersApi: { getAll: vi.fn().mockResolvedValue([]) },
  apisApi: { getAll: vi.fn().mockResolvedValue([]), getSdkMaps: vi.fn().mockResolvedValue({}) },
  credentialsApi: { getAll: vi.fn().mockResolvedValue([]) },
  organizationsApi: { getTeams: vi.fn().mockResolvedValue([]) },
}))

vi.mock('@/store/organization', () => {
  const state = { currentOrganization: { id: 'org-1', name: 'Acme' } }
  const useOrganizationStore: any = (selector?: (s: any) => unknown) => (selector ? selector(state) : state)
  useOrganizationStore.getState = () => state
  return { useOrganizationStore }
})

vi.mock('@/store/app', () => ({ useNotifications: () => ({ success: vi.fn(), error: vi.fn() }) }))

vi.mock('@/lib/connections-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/connections-api')>('@/lib/connections-api')
  return {
    ...actual,
    connectorsApi: { list: vi.fn().mockResolvedValue([]) },
    connectionsApi: {
      list: vi.fn().mockResolvedValue([
        { id: 'cred-1', name: 'Acme key', connectorKey: 'other', connectorDisplayName: 'Other service', kind: 'tool_source', owner: 'org', health: { status: 'valid' }, createdAt: '2026-09-01T00:00:00.000Z' },
        { id: 'cred-2', name: 'Acme sign-in', connectorKey: 'basic-auth', connectorDisplayName: 'Username and password', accountLabel: 'ops', kind: 'tool_source', owner: 'org', health: { status: 'valid' }, createdAt: '2026-09-01T00:00:00.000Z' },
      ]),
    },
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false) as any
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
})

async function fillBasics(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/Tool name/), 'mine')
  await user.type(screen.getByLabelText('Description'), 'a private tool')
  await user.type(screen.getByLabelText('URL'), 'https://api.example.com/x')
}

describe('the create-tool page', () => {
  it('renders as a page, not a dialog', () => {
    renderWithProviders(<ToolNewPage />)

    expect(screen.getByRole('heading', { level: 1, name: 'Create tool' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Tools/ })).toHaveAttribute('href', '/tools')
  })

  it('sends visibility "private" when the tool is made private, then opens the new tool', async () => {
    vi.mocked(toolsApi.create).mockResolvedValue({ id: 'tool-1' } as any)
    const user = userEvent.setup()
    renderWithProviders(<ToolNewPage />)

    await fillBasics(user)
    await user.click(screen.getByRole('radio', { name: /^Only you/ }))
    expect(screen.getByText(/Only you can see and use this tool/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Create tool' }))

    await waitFor(() => expect(toolsApi.create).toHaveBeenCalled())
    expect(vi.mocked(toolsApi.create).mock.calls[0][0]).toMatchObject({
      name: 'mine',
      visibility: 'private',
      teamId: null,
      executionMethod: 'http',
      httpConfig: expect.objectContaining({ method: 'GET', path: 'https://api.example.com/x' }),
    })
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/tools/tool-1', undefined))
  })

  it('defaults to org-wide when nothing is picked', async () => {
    vi.mocked(toolsApi.create).mockResolvedValue({ id: 'tool-2' } as any)
    const user = userEvent.setup()
    renderWithProviders(<ToolNewPage />)

    await fillBasics(user)
    await user.click(screen.getByRole('button', { name: 'Create tool' }))

    await waitFor(() => expect(toolsApi.create).toHaveBeenCalled())
    expect(vi.mocked(toolsApi.create).mock.calls[0][0]).toMatchObject({ visibility: 'org', teamId: null })
  })

  it('sends an API key as the credential the tool points at, never a pasted secret', async () => {
    vi.mocked(toolsApi.create).mockResolvedValue({ id: 'tool-3' } as any)
    const user = userEvent.setup()
    renderWithProviders(<ToolNewPage />)

    await fillBasics(user)
    await user.click(screen.getByRole('combobox', { name: 'Authentication' }))
    await user.click(await screen.findByRole('option', { name: 'API key' }))
    // The one pick-or-create control: pick from Credentials, or create one here.
    expect(screen.getByRole('button', { name: 'Create one here' })).toBeInTheDocument()
    await user.click(screen.getByRole('combobox', { name: 'API key' }))
    await user.click(await screen.findByRole('option', { name: /Acme key/ }))
    await user.click(screen.getByRole('button', { name: 'Create tool' }))

    await waitFor(() => expect(toolsApi.create).toHaveBeenCalled())
    expect(vi.mocked(toolsApi.create).mock.calls[0][0].authConfig).toEqual({ type: 'apiKey', config: { credentialId: 'cred-1', headerName: 'X-API-Key' } })
  })

  it('sends a username and password as the credential the tool points at, never typed in', async () => {
    vi.mocked(toolsApi.create).mockResolvedValue({ id: 'tool-4' } as any)
    const user = userEvent.setup()
    renderWithProviders(<ToolNewPage />)

    await fillBasics(user)
    await user.click(screen.getByRole('combobox', { name: 'Authentication' }))
    await user.click(await screen.findByRole('option', { name: 'Basic auth' }))
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
    await user.click(screen.getByRole('combobox', { name: 'Username and password' }))
    await user.click(await screen.findByRole('option', { name: /Acme sign-in/ }))
    await user.click(screen.getByRole('button', { name: 'Create tool' }))

    await waitFor(() => expect(toolsApi.create).toHaveBeenCalled())
    expect(vi.mocked(toolsApi.create).mock.calls[0][0].authConfig).toEqual({ type: 'basic', config: { credentialId: 'cred-2' } })
  })

  it('Cancel goes back to the list without creating anything', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ToolNewPage />)

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(navigate).toHaveBeenCalledWith('/tools', undefined)
    expect(toolsApi.create).not.toHaveBeenCalled()
  })
})
