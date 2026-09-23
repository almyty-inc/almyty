import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient } from '@tanstack/react-query'

import { render } from '../../test/setup'
import { ApiDetailPage } from '../api-detail'
import { ApiSchemaImportPage } from '../api-schema-import'
import { apisApi } from '../../lib/api'

// Importing a schema is its own page (/apis/:id/import). The detail
// page's Import Schema buttons go there.
//
// The detail endpoint deliberately does not eager-load api.schemas, so
// the "Schema" row is fed by its own ['api-schemas', id] query. The
// import once invalidated four other keys but not that one, so a
// successful import kept reading as "Not uploaded" on the exact panel
// meant to confirm it. The import page has to drop that key.

vi.mock('../../lib/api', () => ({
  apisApi: {
    getById: vi.fn(),
    getSchemas: vi.fn(),
    getOperations: vi.fn(),
    importSchema: vi.fn(),
    pollImportStatus: vi.fn(),
    generateTools: vi.fn(),
  },
  toolsApi: { getAll: vi.fn() },
}))

vi.mock('../../store/app', () => ({
  useNotifications: () => ({
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}))

vi.mock('../../store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org-1' } }),
}))

const navigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useNavigate: () => navigate,
    useParams: () => ({ id: 'api-1' }),
    useLocation: () => ({ pathname: '/apis/api-1', search: '', hash: '', state: null }),
  }
})

const API = {
  id: 'api-1',
  name: 'Northwind',
  type: 'openapi',
  baseUrl: 'https://example.test',
}

describe('ApiDetailPage schema import', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(apisApi.getById).mockResolvedValue(API as any)
    vi.mocked(apisApi.getOperations).mockResolvedValue([] as any)
    vi.mocked(apisApi.getSchemas).mockResolvedValue([] as any)
    vi.mocked(apisApi.importSchema).mockResolvedValue({ operationCount: 3, toolCount: 3 } as any)
  })

  it('sends Import Schema to the import page instead of opening a dialog', async () => {
    const user = userEvent.setup()
    render(<ApiDetailPage />)

    expect(await screen.findByText('Not uploaded')).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: /Import Schema/i })[0])

    expect(navigate).toHaveBeenCalledWith('/apis/api-1/import')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('refreshes the schema panel\'s own query once the import succeeds', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const user = userEvent.setup()
    render(<ApiSchemaImportPage />, { queryClient })

    await user.click(await screen.findByRole('tab', { name: /url/i }))
    await user.type(screen.getByLabelText('Schema URL'), 'https://example.test/openapi.json')
    await user.click(screen.getByRole('button', { name: /Import Schema/i }))

    await waitFor(() => expect(apisApi.importSchema).toHaveBeenCalled())
    expect(vi.mocked(apisApi.importSchema).mock.calls[0][1]).toMatchObject({ schemaUrl: 'https://example.test/openapi.json' })
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['api-schemas', 'api-1'] }))
    expect(navigate).toHaveBeenCalledWith('/apis/api-1')
  })
})