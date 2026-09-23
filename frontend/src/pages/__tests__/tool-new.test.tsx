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

beforeEach(() => {
  vi.clearAllMocks()
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false) as any
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
})

async function fillBasics(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Tool Name'), 'mine')
  await user.type(screen.getByLabelText('Description'), 'a private tool')
  await user.type(screen.getByLabelText('URL'), 'https://api.example.com/x')
}

describe('the create-tool page', () => {
  it('renders as a page, not a dialog', () => {
    renderWithProviders(<ToolNewPage />)

    expect(screen.getByRole('heading', { level: 1, name: 'Create manual tool' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Tools/ })).toHaveAttribute('href', '/tools')
  })

  it('sends visibility "private" when the tool is made private, then opens the new tool', async () => {
    vi.mocked(toolsApi.create).mockResolvedValue({ id: 'tool-1' } as any)
    const user = userEvent.setup()
    renderWithProviders(<ToolNewPage />)

    await fillBasics(user)
    await user.click(screen.getByRole('radio', { name: /Private/ }))
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
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/tools/tool-1'))
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

  it('Cancel goes back to the list without creating anything', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ToolNewPage />)

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(navigate).toHaveBeenCalledWith('/tools')
    expect(toolsApi.create).not.toHaveBeenCalled()
  })
})