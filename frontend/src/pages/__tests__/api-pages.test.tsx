import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router-dom'

import { ApiNewPage } from '@/pages/api-new'
import { ApiNewSdkPage } from '@/pages/api-new-sdk'
import { ApiSetupPage } from '@/pages/api-setup'
import { ApiEditPage } from '@/pages/api-edit'
import { ApiImportPage } from '@/pages/api-import'
import { apisApi, organizationsApi } from '@/lib/api'

// These pages are about routes: the real router, not setup.tsx's stubs.
vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

vi.mock('@/lib/api', () => ({
  apisApi: {
    getById: vi.fn(),
    update: vi.fn(),
    connect: vi.fn(),
    createSdkApi: vi.fn(),
    importSchema: vi.fn(),
    pollImportStatus: vi.fn(),
    getKey: vi.fn(),
    setKey: vi.fn(),
    removeKey: vi.fn(),
  },
  credentialsApi: { oauth2Authorize: vi.fn(), oauth2ClientCredentials: vi.fn() },
  organizationsApi: { getTeams: vi.fn() },
}))

const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
vi.mock('@/store/app', () => ({ useNotifications: () => notify }))
vi.mock('@/store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org-1' } }),
}))

const API = {
  id: 'api-1',
  name: 'Petstore',
  type: 'openapi',
  baseUrl: 'https://petstore.example.com/v2',
  version: '2.1.0',
  description: 'pets',
  authentication: { type: 'api_key', config: { headerName: 'X-Pets-Key', location: 'header' } },
}

const RESULT = {
  api: { ...API, id: 'api-9' },
  jobId: 'job-1',
  detected: { type: 'openapi', format: 'openapi3', name: 'Petstore', version: '2.1.0', description: 'pets', baseUrl: API.baseUrl, auth: { type: 'api_key', headerName: 'X-Pets-Key', location: 'header' } },
  needs: { key: true, address: false },
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
      { path: '/apis/new/sdk', element: <ApiNewSdkPage /> },
      { path: '/tools/new', element: <Where /> },
      { path: '/apis/:id', element: <Where /> },
      { path: '/apis/:id/edit', element: <ApiEditPage /> },
      { path: '/apis/:id/import', element: <ApiImportPage /> },
      { path: '/apis/:id/setup', element: <ApiSetupPage /> },
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
  vi.mocked(organizationsApi.getTeams).mockResolvedValue([] as any)
  // Radix Select uses pointer capture and scrollIntoView, absent in jsdom.
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
  if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = vi.fn()
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = vi.fn()
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
})

const box = () => screen.getByLabelText('Paste a link, drop a file, or paste it here')

describe('/apis/new: one box', () => {
  it('asks one thing with one button, keeps the rest under Advanced, and is a page', async () => {
    renderAt('/apis/new')
    expect(await screen.findByRole('heading', { name: 'Connect an API' })).toBeInTheDocument()
    expect(box()).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import' })).toHaveAttribute('type', 'submit')
    // Nothing else to fill in until Advanced is opened.
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Address')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Advanced' })).toHaveAttribute('aria-expanded', 'false')
    // No type to choose, and Custom HTTP is a tool now.
    expect(screen.queryByText(/API type/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Custom HTTP/)).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Create a tool' })).toHaveAttribute('href', '/tools/new')
    expect(screen.getByRole('link', { name: 'import an npm package' })).toHaveAttribute('href', '/apis/new/sdk')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('imports a pasted link and goes on to ask for the key', async () => {
    vi.mocked(apisApi.connect).mockResolvedValue(RESULT as any)
    const user = userEvent.setup()
    const { router } = renderAt('/apis/new')
    await user.type(await screen.findByLabelText('Paste a link, drop a file, or paste it here'), 'https://petstore.example.com/openapi.json')
    await user.click(screen.getByRole('button', { name: 'Import' }))

    await waitFor(() => expect(apisApi.connect).toHaveBeenCalledWith({ url: 'https://petstore.example.com/openapi.json' }, undefined))
    await waitFor(() => expect(router.state.location.pathname).toBe('/apis/api-9/setup'))
    expect(router.state.location.search).toBe('?job=job-1&key=1')
  })

  it('sends pasted text as the description itself', async () => {
    vi.mocked(apisApi.connect).mockResolvedValue({ ...RESULT, needs: { key: false, address: true } } as any)
    const { router } = renderAt('/apis/new')
    const sdl = 'type Query {\n  countries: [String]\n}'
    fireEvent.change(await screen.findByLabelText('Paste a link, drop a file, or paste it here'), { target: { value: sdl } })
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))

    await waitFor(() => expect(apisApi.connect).toHaveBeenCalledWith({ content: sdl }, undefined))
    await waitFor(() => expect(router.state.location.search).toBe('?job=job-1&address=1'))
  })

  it('takes a chosen file, which can be removed again', async () => {
    vi.mocked(apisApi.connect).mockResolvedValue(RESULT as any)
    const user = userEvent.setup()
    renderAt('/apis/new')
    const file = new File(['openapi: 3.0.0'], 'petstore.yaml', { type: 'application/yaml' })
    await user.upload(await screen.findByLabelText('Choose a file'), file)
    expect(screen.getByTestId('source-file')).toHaveTextContent('petstore.yaml')
    await user.click(screen.getByRole('button', { name: 'Remove petstore.yaml' }))
    expect(screen.queryByTestId('source-file')).not.toBeInTheDocument()

    await user.upload(screen.getByLabelText('Choose a file'), file)
    await user.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(apisApi.connect).toHaveBeenCalledWith({}, file))
  })

  it('takes a dropped file', async () => {
    vi.mocked(apisApi.connect).mockResolvedValue(RESULT as any)
    renderAt('/apis/new')
    const file = new File(['<definitions/>'], 'service.wsdl', { type: 'text/xml' })
    fireEvent.drop(await screen.findByTestId('source-box'), { dataTransfer: { files: [file], getData: () => '' } })
    expect(screen.getByTestId('source-file')).toHaveTextContent('service.wsdl')
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(apisApi.connect).toHaveBeenCalledWith({}, file))
  })

  it('an empty Import says what to do and imports nothing', async () => {
    const user = userEvent.setup()
    renderAt('/apis/new')
    await user.click(await screen.findByRole('button', { name: 'Import' }))
    expect(await screen.findByTestId('source-error')).toHaveTextContent('Paste a link, drop a file, or paste the description first.')
    expect(box()).toHaveAttribute('aria-invalid', 'true')
    await waitFor(() => expect(document.activeElement).toBe(box()))
    expect(apisApi.connect).not.toHaveBeenCalled()
  })

  it('shows the server\'s plain-words refusal under the box', async () => {
    vi.mocked(apisApi.connect).mockRejectedValue({ response: { status: 400, data: { message: "This link doesn't return an API description." } } })
    const user = userEvent.setup()
    const { router } = renderAt('/apis/new')
    await user.type(await screen.findByLabelText('Paste a link, drop a file, or paste it here'), 'https://www.example.com/')
    await user.click(screen.getByRole('button', { name: 'Import' }))
    expect(await screen.findByTestId('source-error')).toHaveTextContent("This link doesn't return an API description.")
    expect(router.state.location.pathname).toBe('/apis/new')
  })

  it('sends what Advanced overrides, and "don\'t make tools"', async () => {
    vi.mocked(apisApi.connect).mockResolvedValue(RESULT as any)
    const user = userEvent.setup()
    renderAt('/apis/new')
    await user.type(await screen.findByLabelText('Paste a link, drop a file, or paste it here'), 'https://petstore.example.com/openapi.json')
    await user.click(screen.getByRole('button', { name: 'Advanced' }))
    await user.type(screen.getByLabelText('Name'), 'Pets')
    await user.type(screen.getByLabelText('Address'), 'https://staging.petstore.example.com')
    await user.click(screen.getByRole('combobox', { name: 'Sign-in' }))
    await user.click(await screen.findByRole('option', { name: 'Bearer token' }))
    await user.click(screen.getByLabelText('Make a tool for every operation'))
    // No teams in this organization: nothing to ask about who can use it.
    expect(screen.queryByTestId('who-can-use')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Import' }))

    await waitFor(() =>
      expect(apisApi.connect).toHaveBeenCalledWith(
        {
          url: 'https://petstore.example.com/openapi.json',
          name: 'Pets',
          baseUrl: 'https://staging.petstore.example.com',
          authType: 'bearer',
          generateTools: false,
        },
        undefined,
      ),
    )
  })

  it('asks who can use it only when the organization has teams', async () => {
    vi.mocked(organizationsApi.getTeams).mockResolvedValue([{ id: 't1', name: 'Payments', isDefault: false }] as any)
    vi.mocked(apisApi.connect).mockResolvedValue(RESULT as any)
    const user = userEvent.setup()
    renderAt('/apis/new')
    await user.type(await screen.findByLabelText('Paste a link, drop a file, or paste it here'), 'https://petstore.example.com/openapi.json')
    await user.click(screen.getByRole('button', { name: 'Advanced' }))
    expect(await screen.findByTestId('who-can-use')).toHaveTextContent('Who can use it: everyone in your organization')
    await user.click(screen.getByRole('button', { name: 'Change' }))
    await user.click(screen.getByRole('radio', { name: /Private/ }))
    await user.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(vi.mocked(apisApi.connect).mock.calls[0][0]).toMatchObject({ visibility: 'private', teamId: null }))
  })
})

describe('/apis/:id/setup: finish connecting', () => {
  const keyView = { type: 'api_key', headerName: 'X-Pets-Key', location: 'header', oauth2: null, source: null, credential: null, connection: null }

  it('asks only for the key, header prefilled, while the import runs; then opens the API', async () => {
    let finish: (v: unknown) => void = () => {}
    vi.mocked(apisApi.pollImportStatus).mockReturnValue(new Promise((r) => { finish = r }) as any)
    vi.mocked(apisApi.getKey).mockResolvedValue(keyView as any)
    vi.mocked(apisApi.setKey).mockResolvedValue({ ...keyView, source: 'key' } as any)
    const user = userEvent.setup()
    const { router } = renderAt('/apis/api-1/setup?job=job-1&key=1')

    expect(await screen.findByRole('heading', { name: 'Finish connecting Petstore' })).toBeInTheDocument()
    expect(apisApi.pollImportStatus).toHaveBeenCalledWith('api-1', 'job-1')
    expect(screen.getByTestId('import-status')).toHaveTextContent('Reading the description')
    expect(await screen.findByTestId('api-key-sent-as')).toHaveTextContent('Sent in the X-Pets-Key header')
    expect(screen.queryByText('Where does it run?')).not.toBeInTheDocument()

    await user.type(screen.getByLabelText('Paste your key'), 'pk-1')
    await user.click(screen.getByRole('button', { name: 'Save key' }))
    await waitFor(() => expect(apisApi.setKey).toHaveBeenCalledWith('api-1', { type: 'api_key', key: 'pk-1', headerName: 'X-Pets-Key', location: 'header' }))
    expect(await screen.findByTestId('setup-key-done')).toBeInTheDocument()

    finish({ status: 'completed', result: { operationCount: 3, toolCount: 3 } })
    expect(await screen.findByText(/Found 3 operations and made 3 tools/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open Petstore' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/apis/api-1'))
  })

  it('asks where it runs when the description has no address', async () => {
    vi.mocked(apisApi.getById).mockResolvedValue({ ...API, baseUrl: '' } as any)
    vi.mocked(apisApi.pollImportStatus).mockResolvedValue({ status: 'completed', result: { operationCount: 2 } } as any)
    vi.mocked(apisApi.update).mockResolvedValue({} as any)
    const user = userEvent.setup()
    renderAt('/apis/api-1/setup?job=job-1&address=1')
    await user.type(await screen.findByLabelText('Address'), 'https://greeter.example.com')
    await user.click(screen.getByRole('button', { name: 'Save address' }))
    await waitFor(() => expect(apisApi.update).toHaveBeenCalledWith('api-1', { baseUrl: 'https://greeter.example.com' }))
  })

  it('Skip for now goes to the API', async () => {
    vi.mocked(apisApi.pollImportStatus).mockReturnValue(new Promise(() => {}) as any)
    vi.mocked(apisApi.getKey).mockResolvedValue(keyView as any)
    const user = userEvent.setup()
    const { router } = renderAt('/apis/api-1/setup?job=job-1&key=1')
    await user.click(await screen.findByRole('button', { name: 'Skip for now' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/apis/api-1'))
    expect(apisApi.setKey).not.toHaveBeenCalled()
  })

  it('with nothing to ask, goes on to the API once the import is in', async () => {
    vi.mocked(apisApi.pollImportStatus).mockResolvedValue({ status: 'completed', result: { operationCount: 1 } } as any)
    const { router } = renderAt('/apis/api-1/setup?job=job-1')
    await waitFor(() => expect(router.state.location.pathname).toBe('/apis/api-1'))
  })

  it('says so when the import failed', async () => {
    vi.mocked(apisApi.pollImportStatus).mockRejectedValue(new Error("We couldn't read this as OpenAPI, GraphQL, WSDL or proto."))
    vi.mocked(apisApi.getKey).mockResolvedValue(keyView as any)
    renderAt('/apis/api-1/setup?job=job-1&key=1')
    expect(await screen.findByRole('alert')).toHaveTextContent("The import failed: We couldn't read this as OpenAPI, GraphQL, WSDL or proto.")
  })
})

describe('/apis/:id/import: update the description', () => {
  it('imports from a link, refreshes the schema panel query and returns to the API', async () => {
    vi.mocked(apisApi.importSchema).mockResolvedValue({ operationCount: 3, toolCount: 3 } as any)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const user = userEvent.setup()
    const { router } = renderAt('/apis/api-1/import', queryClient)

    expect(await screen.findByRole('heading', { name: 'Update the description' })).toBeInTheDocument()
    await user.type(box(), 'https://example.test/openapi.json')
    await user.click(screen.getByRole('button', { name: 'Import' }))

    await waitFor(() =>
      expect(apisApi.importSchema).toHaveBeenCalledWith('api-1', { schemaUrl: 'https://example.test/openapi.json', generateTools: true }, undefined),
    )
    // The detail page's "Schema" row reads this key.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['api-schemas', 'api-1'] })
    await waitFor(() => expect(router.state.location.pathname).toBe('/apis/api-1'))
    expect(notify.success).toHaveBeenCalledWith('Description updated', '3 operations found, 3 tools made.')
  })

  it('sends a chosen file', async () => {
    vi.mocked(apisApi.importSchema).mockResolvedValue({ operationCount: 1 } as any)
    const user = userEvent.setup()
    renderAt('/apis/api-1/import')
    const file = new File(['{}'], 'openapi.json', { type: 'application/json' })
    await user.upload(await screen.findByLabelText('Choose a file'), file)
    await user.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(apisApi.importSchema).toHaveBeenCalled())
    expect(vi.mocked(apisApi.importSchema).mock.calls[0][2]).toBe(file)
  })

  it('an empty Import marks the box and focuses it', async () => {
    renderAt('/apis/api-1/import')
    fireEvent.click(await screen.findByRole('button', { name: 'Import' }))
    await waitFor(() => expect(box()).toHaveAttribute('aria-invalid', 'true'))
    await waitFor(() => expect(document.activeElement).toBe(box()))
    expect(apisApi.importSchema).not.toHaveBeenCalled()
  })

  it('puts a background job in the URL and waits for it', async () => {
    vi.mocked(apisApi.importSchema).mockResolvedValue({ jobId: 'job-7' } as any)
    let resolvePoll: (v: unknown) => void = () => {}
    vi.mocked(apisApi.pollImportStatus).mockReturnValue(new Promise((r) => { resolvePoll = r }) as any)
    const { router } = renderAt('/apis/api-1/import')
    fireEvent.change(await screen.findByLabelText('Paste a link, drop a file, or paste it here'), { target: { value: 'openapi: 3.0.0\ninfo: {}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))

    await waitFor(() => expect(router.state.location.search).toBe('?job=job-7'))
    expect(apisApi.importSchema).toHaveBeenCalledWith('api-1', { schemaContent: 'openapi: 3.0.0\ninfo: {}', generateTools: true }, undefined)
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
})

describe('/apis/:id/edit', () => {
  it('saves name and address without a type or a key, and returns to the API', async () => {
    vi.mocked(apisApi.update).mockResolvedValue({ ...API } as any)
    const user = userEvent.setup()
    const { router } = renderAt('/apis/api-1/edit')
    const name = await screen.findByLabelText(/Name/)
    expect(name).toHaveValue('Petstore')
    expect(screen.queryByText(/Authentication/)).not.toBeInTheDocument()
    await user.clear(name)
    await user.type(name, 'Petstore v2')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(apisApi.update).toHaveBeenCalled())
    const [id, data] = vi.mocked(apisApi.update).mock.calls[0]
    expect(id).toBe('api-1')
    expect(data).toMatchObject({ name: 'Petstore v2', baseUrl: API.baseUrl })
    expect(data).not.toHaveProperty('type')
    expect(data).not.toHaveProperty('authentication')
    await waitFor(() => expect(router.state.location.pathname).toBe('/apis/api-1'))
  })

  it('starts from the API\'s own private scope and keeps it on save', async () => {
    vi.mocked(apisApi.getById).mockResolvedValue({ ...API, visibility: 'private', teamId: null } as any)
    vi.mocked(apisApi.update).mockResolvedValue({ ...API } as any)
    const user = userEvent.setup()
    renderAt('/apis/api-1/edit')
    await screen.findByLabelText(/Name/)
    expect(screen.getByRole('radio', { name: /Private/ })).toHaveAttribute('aria-checked', 'true')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(apisApi.update).toHaveBeenCalled())
    expect(vi.mocked(apisApi.update).mock.calls[0][1]).toMatchObject({ visibility: 'private', teamId: null })
  })
})

describe('/apis/new/sdk', () => {
  it('creates an API from npm packages', async () => {
    vi.mocked(apisApi.createSdkApi).mockResolvedValue({ id: 'api-5' } as any)
    const user = userEvent.setup()
    const { router } = renderAt('/apis/new/sdk')
    await user.type(await screen.findByLabelText(/Name/), 'S3')
    await user.type(screen.getByLabelText('Package name'), '@aws-sdk/client-s3')
    await user.click(screen.getByRole('button', { name: 'Add package' }))
    await user.click(screen.getByRole('button', { name: 'Create API' }))
    await waitFor(() =>
      expect(apisApi.createSdkApi).toHaveBeenCalledWith(expect.objectContaining({ name: 'S3', dependencies: { '@aws-sdk/client-s3': '*' } })),
    )
    await waitFor(() => expect(router.state.location.pathname).toBe('/apis/api-5'))
  })
})
