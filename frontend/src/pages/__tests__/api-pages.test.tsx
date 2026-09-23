import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router-dom'

import { ApiNewPage } from '@/pages/api-new'
import { ApiEditPage } from '@/pages/api-edit'
import { ApiImportPage } from '@/pages/api-import'
import { apisApi } from '@/lib/api'

// These pages are about routes: the real router, not setup.tsx's stubs.
vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

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
  organizationsApi: { getTeams: vi.fn().mockResolvedValue([]) },
  credentialsApi: { getAll: vi.fn().mockResolvedValue([]) },
}))

const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
vi.mock('@/store/app', () => ({ useNotifications: () => notify }))
vi.mock('@/store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org-1' } }),
}))

const API = {
  id: 'api-1',
  name: 'Northwind',
  type: 'openapi',
  baseUrl: 'https://example.test',
  version: '1',
  description: 'orders',
  authentication: { type: 'none', config: {} },
}

function Where() {
  const loc = useLocation()
  return <p data-testid="where">{loc.pathname + loc.search}</p>
}

function renderAt(url: string, queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const router = createMemoryRouter(
    [
      { path: '/apis', element: <Where /> },
      { path: '/apis/new', element: <ApiNewPage /> },
      { path: '/apis/:id', element: <Where /> },
      { path: '/apis/:id/edit', element: <ApiEditPage /> },
      { path: '/apis/:id/import', element: <ApiImportPage /> },
    ],
    { initialEntries: [url] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { router, queryClient }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(apisApi.getById).mockResolvedValue(API as any)
})

describe('/apis/new', () => {
  it('renders the connect form as a page with one submit', async () => {
    renderAt('/apis/new')
    expect(await screen.findByRole('heading', { name: 'Connect API' })).toBeInTheDocument()
    expect(screen.getByText('Step 1 of 2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue to schema import' })).toHaveAttribute('type', 'submit')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('creates the API and continues to its import step', async () => {
    vi.mocked(apisApi.create).mockResolvedValue({ id: 'api-9', name: 'Orders' } as any)
    const user = userEvent.setup()
    const { router } = renderAt('/apis/new')
    await user.type(await screen.findByLabelText(/API name/), 'Orders')
    await user.type(screen.getByLabelText(/Base URL/), 'https://orders.example.com/v1')
    await user.click(screen.getByRole('button', { name: 'Continue to schema import' }))

    await waitFor(() => expect(apisApi.create).toHaveBeenCalled())
    expect(vi.mocked(apisApi.create).mock.calls[0][0]).toMatchObject({
      name: 'Orders',
      baseUrl: 'https://orders.example.com/v1',
      type: 'openapi',
      authentication: { type: 'none', config: {} },
      visibility: 'org',
      teamId: null,
    })
    await waitFor(() => expect(router.state.location.pathname).toBe('/apis/api-9/import'))
    expect(router.state.location.search).toBe('?created=1')
  })

  it('a missing base URL is reported on the field and focuses it', async () => {
    const user = userEvent.setup()
    renderAt('/apis/new')
    await user.type(await screen.findByLabelText(/API name/), 'Orders')
    await user.click(screen.getByRole('button', { name: 'Continue to schema import' }))

    const url = screen.getByLabelText(/Base URL/)
    await waitFor(() => expect(url).toHaveAttribute('aria-invalid', 'true'))
    expect(screen.getByText('Please enter a valid URL')).toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toBe(url))
    expect(apisApi.create).not.toHaveBeenCalled()
  })
})

describe('/apis/:id/edit', () => {
  it('saves the changes without the type and returns to the API', async () => {
    vi.mocked(apisApi.update).mockResolvedValue({ ...API } as any)
    const user = userEvent.setup()
    const { router } = renderAt('/apis/api-1/edit')
    const name = await screen.findByLabelText(/API name/)
    expect(name).toHaveValue('Northwind')
    await user.clear(name)
    await user.type(name, 'Northwind v2')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(apisApi.update).toHaveBeenCalled())
    const [id, data] = vi.mocked(apisApi.update).mock.calls[0]
    expect(id).toBe('api-1')
    expect(data).toMatchObject({ name: 'Northwind v2', baseUrl: 'https://example.test' })
    expect(data).not.toHaveProperty('type')
    await waitFor(() => expect(router.state.location.pathname).toBe('/apis/api-1'))
  })
})

describe('/apis/:id/import', () => {
  it('imports from a URL, refreshes the schema panel query and returns to the API', async () => {
    vi.mocked(apisApi.importSchema).mockResolvedValue({ operationCount: 3, toolCount: 3 } as any)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const user = userEvent.setup()
    const { router } = renderAt('/apis/api-1/import', queryClient)

    await user.click(await screen.findByRole('tab', { name: /url/i }))
    await user.type(screen.getByLabelText('Schema URL'), 'https://example.test/openapi.json')
    await user.click(screen.getByRole('button', { name: 'Import schema' }))

    await waitFor(() =>
      expect(apisApi.importSchema).toHaveBeenCalledWith(
        'api-1',
        { schemaUrl: 'https://example.test/openapi.json', generateTools: true },
        undefined,
      ),
    )
    // The detail page's "Schema" row reads this key; without it a
    // successful import kept reading "Not uploaded".
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['api-schemas', 'api-1'] })
    await waitFor(() => expect(router.state.location.pathname).toBe('/apis/api-1'))
    expect(notify.success).toHaveBeenCalledWith('Schema imported', '3 operations found, 3 tools generated.')
  })

  it('sends the chosen file', async () => {
    vi.mocked(apisApi.importSchema).mockResolvedValue({ operationCount: 1 } as any)
    const user = userEvent.setup()
    renderAt('/apis/api-1/import')
    const file = new File(['{}'], 'openapi.json', { type: 'application/json' })
    await user.upload(await screen.findByLabelText('Schema file'), file)
    await user.click(screen.getByRole('button', { name: 'Import schema' }))

    await waitFor(() => expect(apisApi.importSchema).toHaveBeenCalled())
    expect(vi.mocked(apisApi.importSchema).mock.calls[0][2]).toBe(file)
  })

  it('an empty submit marks the file field and focuses it', async () => {
    renderAt('/apis/api-1/import')
    fireEvent.click(await screen.findByRole('button', { name: 'Import schema' }))
    const input = screen.getByLabelText('Schema file')
    await waitFor(() => expect(input).toHaveAttribute('aria-invalid', 'true'))
    await waitFor(() => expect(document.activeElement).toBe(input))
    expect(apisApi.importSchema).not.toHaveBeenCalled()
  })

  it('puts a background job in the URL and waits for it', async () => {
    vi.mocked(apisApi.importSchema).mockResolvedValue({ jobId: 'job-7' } as any)
    let resolvePoll: (v: unknown) => void = () => {}
    vi.mocked(apisApi.pollImportStatus).mockReturnValue(new Promise((r) => { resolvePoll = r }) as any)
    const user = userEvent.setup()
    const { router } = renderAt('/apis/api-1/import')
    await user.click(await screen.findByRole('tab', { name: /paste/i }))
    await user.type(screen.getByLabelText('Schema content'), 'openapi: 3.0.0')
    await user.click(screen.getByRole('button', { name: 'Import schema' }))

    await waitFor(() => expect(router.state.location.search).toBe('?job=job-7'))
    expect(apisApi.pollImportStatus).toHaveBeenCalledTimes(1)
    expect(apisApi.pollImportStatus).toHaveBeenCalledWith('api-1', 'job-7')
    expect(screen.getByTestId('schema-import-running')).toBeInTheDocument()

    resolvePoll({ status: 'completed', result: { operationCount: 2, toolCount: 2 } })
    await waitFor(() => expect(router.state.location.pathname).toBe('/apis/api-1'))
  })

  it('resumes a job carried in the URL after a refresh', async () => {
    vi.mocked(apisApi.pollImportStatus).mockResolvedValue({ status: 'completed', result: { operationCount: 4 } } as any)
    const { router } = renderAt('/apis/api-1/import?job=job-3')
    await waitFor(() => expect(apisApi.pollImportStatus).toHaveBeenCalledWith('api-1', 'job-3'))
    expect(apisApi.importSchema).not.toHaveBeenCalled()
    await waitFor(() => expect(router.state.location.pathname).toBe('/apis/api-1'))
  })

  it('as step 2 of connecting, offers to skip', async () => {
    const user = userEvent.setup()
    const { router } = renderAt('/apis/api-1/import?created=1')
    expect(await screen.findByText('Step 2 of 2')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Skip for now' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/apis/api-1'))
    expect(apisApi.importSchema).not.toHaveBeenCalled()
  })
})
