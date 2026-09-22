import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '../../test/setup'
import { ApiDetailPage } from '../api-detail'
import { apisApi } from '../../lib/api'

// The detail endpoint deliberately does not eager-load api.schemas, so
// the "Schema" row is fed by its own ['api-schemas', id] query. The
// import mutation invalidated four other keys but not that one, so a
// successful import kept reading as "Not uploaded" on the exact panel
// meant to confirm it.

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

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useNavigate: () => vi.fn(),
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
    vi.mocked(apisApi.importSchema).mockResolvedValue({ operationCount: 3, toolCount: 3 } as any)
  })

  it('stops saying "Not uploaded" once the import succeeds', async () => {
    vi.mocked(apisApi.getSchemas)
      .mockResolvedValueOnce([] as any)
      .mockResolvedValue([{ id: 'schema-1', fileName: 'openapi.json', rawSchema: '{}' }] as any)

    const user = userEvent.setup()
    render(<ApiDetailPage />)

    expect(await screen.findByText('Not uploaded')).toBeInTheDocument()

    await user.click(screen.getAllByRole('button', { name: /Import Schema/i })[0])
    const dialog = within(await screen.findByRole('dialog'))
    await user.click(dialog.getByRole('tab', { name: /url/i }))
    await user.type(dialog.getByLabelText('Schema URL'), 'https://example.test/openapi.json')
    await user.click(dialog.getByRole('button', { name: /Import Schema/i }))

    await waitFor(() => expect(apisApi.importSchema).toHaveBeenCalled())
    // The schemas query has to be refetched, or the panel keeps the
    // pre-import answer.
    await waitFor(() => expect(apisApi.getSchemas).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(screen.queryByText('Not uploaded')).not.toBeInTheDocument(),
    )
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument()
  })
})
