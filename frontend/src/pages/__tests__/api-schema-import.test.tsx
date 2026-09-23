/**
 * Importing a schema into an existing API is its own page
 * (/apis/:id/import), not a dialog on the list or the detail view.
 *
 * It also has to send what it is given. As a dialog, a file-only import
 * never submitted (the form demanded content or a URL) and, had it
 * submitted, the file was dropped by both pages that opened it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderWithProviders } from '@/test/setup'
import { ApiSchemaImportPage } from '../api-schema-import'
import { apisApi } from '@/lib/api'
import { ApiType } from '@/types'

const navigate = vi.fn()

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useParams: () => ({ id: 'api-1' }), useNavigate: () => navigate }
})

vi.mock('@/lib/api', () => ({
  apisApi: { getById: vi.fn(), importSchema: vi.fn(), pollImportStatus: vi.fn() },
}))

vi.mock('@/store/app', () => ({ useNotifications: () => ({ success: vi.fn(), error: vi.fn() }) }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(apisApi.getById).mockResolvedValue({ id: 'api-1', name: 'Petstore', type: ApiType.OPENAPI } as any)
  vi.mocked(apisApi.importSchema).mockResolvedValue({ operationCount: 3 } as any)
})

describe('the schema import page', () => {
  it('renders as a page for the API, not a dialog', async () => {
    renderWithProviders(<ApiSchemaImportPage />)

    expect(await screen.findByRole('heading', { level: 1, name: /Import OpenAPI/ })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Petstore/ })).toHaveAttribute('href', '/apis/api-1')
  })

  it('imports an uploaded file with nothing else filled in, and sends the file', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ApiSchemaImportPage />)

    const file = new File(['{"openapi":"3.0.0"}'], 'petstore.json', { type: 'application/json' })
    await user.upload(await screen.findByLabelText('Schema File'), file)
    await user.click(screen.getByRole('button', { name: /Import Schema/ }))

    await waitFor(() => expect(apisApi.importSchema).toHaveBeenCalled())
    const [id, data, sent] = vi.mocked(apisApi.importSchema).mock.calls[0]
    expect(id).toBe('api-1')
    expect(sent).toBe(file)
    expect(data).not.toHaveProperty('schemaUrl')
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/apis/api-1'))
  })

  it('still refuses when no source is given', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ApiSchemaImportPage />)

    await user.click(await screen.findByRole('button', { name: /Import Schema/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/schema content or URL/i)
    expect(apisApi.importSchema).not.toHaveBeenCalled()
  })
})
