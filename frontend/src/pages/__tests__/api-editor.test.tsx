/**
 * Connecting and editing an API happen on their own pages (/apis/new,
 * /apis/:id/edit), not in a dialog on the list.
 *
 * "Private (just me)" has to reach the create call, and the edit page has
 * to start from the API's own scope: the old edit dialog started every
 * edit at org-wide and posted that on save, so renaming a private API
 * published it to the whole organization.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderWithProviders } from '@/test/setup'
import { ApiEditorPage } from '../api-editor'
import { apisApi } from '@/lib/api'
import { ApiType } from '@/types'

const params: { id?: string } = {}
const navigate = vi.fn()

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useParams: () => params, useNavigate: () => navigate }
})

vi.mock('@/lib/api', () => ({
  apisApi: {
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    createHttpApi: vi.fn(),
    createSdkApi: vi.fn(),
    importSchema: vi.fn(),
    pollImportStatus: vi.fn(),
  },
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
  delete params.id
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false) as any
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
})

describe('the API editor page', () => {
  it('renders as a page, not a dialog', async () => {
    renderWithProviders(<ApiEditorPage />)

    expect(screen.getByRole('heading', { level: 1, name: 'Connect new API' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /APIs/ })).toHaveAttribute('href', '/apis')
  })

  it('sends visibility "private" when a new API is made private, then moves on to the schema step', async () => {
    vi.mocked(apisApi.create).mockResolvedValue({ id: 'api-1', name: 'Mine', type: ApiType.OPENAPI } as any)
    const user = userEvent.setup()
    renderWithProviders(<ApiEditorPage />)

    await user.type(screen.getByLabelText('API Name'), 'Mine')
    await user.type(document.getElementById('baseUrl') as HTMLElement, 'https://api.example.com')
    await user.click(screen.getByRole('radio', { name: /Private/ }))
    expect(screen.getByText(/Only you can see and use this API/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Connect API' }))

    await waitFor(() => expect(apisApi.create).toHaveBeenCalled())
    expect(vi.mocked(apisApi.create).mock.calls[0][0]).toMatchObject({ visibility: 'private', teamId: null })
    expect(await screen.findByRole('heading', { level: 1, name: 'Import schema' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Skip for now' }))
    expect(navigate).toHaveBeenCalledWith('/apis/api-1')
  })

  it('loads the API on /apis/:id/edit, starts from its own private scope and keeps it on save', async () => {
    params.id = 'api-1'
    vi.mocked(apisApi.getById).mockResolvedValue({
      id: 'api-1',
      name: 'Mine',
      type: ApiType.OPENAPI,
      baseUrl: 'https://api.example.com',
      visibility: 'private',
      teamId: null,
    } as any)
    vi.mocked(apisApi.update).mockResolvedValue({ id: 'api-1' } as any)
    const user = userEvent.setup()
    renderWithProviders(<ApiEditorPage />)

    expect(await screen.findByRole('heading', { level: 1, name: 'Edit API' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText('API Name')).toHaveValue('Mine'))
    expect(screen.getByRole('radio', { name: /Private/ })).toHaveAttribute('aria-checked', 'true')
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => expect(apisApi.update).toHaveBeenCalled())
    expect(vi.mocked(apisApi.update).mock.calls[0][0]).toBe('api-1')
    expect(vi.mocked(apisApi.update).mock.calls[0][1]).toMatchObject({ visibility: 'private', teamId: null })
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/apis/api-1'))
  })

  it('Cancel goes back without saving', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ApiEditorPage />)

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(navigate).toHaveBeenCalledWith('/apis')
    expect(apisApi.create).not.toHaveBeenCalled()
  })
})