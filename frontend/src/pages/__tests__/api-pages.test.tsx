import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router-dom'

import { ApiNewPage } from '@/pages/api-new'
import { ApiNewDescriptionPage } from '@/pages/api-new-description'
import { ApiNewHttpPage } from '@/pages/api-new-http'
import { ApiNewProviderPage } from '@/pages/api-new-provider'
import { ApiNewSdkPage } from '@/pages/api-new-sdk'
import { ApiSetupPage } from '@/pages/api-setup'
import { ApiEditPage } from '@/pages/api-edit'
import { ApiImportPage } from '@/pages/api-import'
import { apisApi, organizationsApi } from '@/lib/api'
import { connectionsApi } from '@/lib/connections-api'

// These pages are about routes: the real router, not setup.tsx's stubs.
vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

vi.mock('@/lib/api', () => ({
  apisApi: {
    getById: vi.fn(),
    update: vi.fn(),
    connect: vi.fn(),
    createSdkApi: vi.fn(),
    createHttpApi: vi.fn(),
    importSchema: vi.fn(),
    pollImportStatus: vi.fn(),
    getKey: vi.fn(),
    setKey: vi.fn(),
    removeKey: vi.fn(),
  },
  credentialsApi: { oauth2Authorize: vi.fn(), oauth2ClientCredentials: vi.fn() },
  organizationsApi: { getTeams: vi.fn(), getById: vi.fn() },
}))
vi.mock('@/lib/connections-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/connections-api')>('@/lib/connections-api')
  return { ...actual, connectorsApi: { list: vi.fn().mockResolvedValue([]) }, connectionsApi: { list: vi.fn(), connect: vi.fn() } }
})
vi.mock('@/hooks/use-organization-role', () => ({ useOrganizationRole: () => ({ role: 'admin', canManage: true, isOwner: false }) }))

const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
vi.mock('@/store/app', () => ({ useNotifications: () => notify }))
vi.mock('@/store/organization', () => ({
  useOrganizationStore: (selector?: (s: any) => any) => {
    const state = { currentOrganization: { id: 'org-1' } }
    return selector ? selector(state) : state
  },
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
      { path: '/apis/new/http', element: <ApiNewHttpPage /> },
      { path: '/apis/new/provider/:key', element: <ApiNewProviderPage /> },
      { path: '/apis/new/:type', element: <ApiNewDescriptionPage /> },
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
  vi.mocked(connectionsApi.list).mockResolvedValue([
    { id: 'cred-1', name: 'Pets key', connectorKey: 'other', connectorDisplayName: 'Other service', kind: 'tool_source', owner: 'org', health: { status: 'valid' }, createdAt: '2026-09-01T00:00:00.000Z' },
  ] as any)
  // Radix Select uses pointer capture and scrollIntoView, absent in jsdom.
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
  if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = vi.fn()
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = vi.fn()
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
})

const box = () => screen.getByLabelText('Paste a link, drop a file, or paste it here')

describe('/apis/new: pick the kind first', () => {
  it('offers the six kinds as tiles, with no paste box that guesses, and is a page', async () => {
    renderAt('/apis/new')
    expect(await screen.findByRole('heading', { name: 'Connect an API' })).toBeInTheDocument()
    const tiles = screen.getAllByTestId(/^api-kind-/).map((t) => t.textContent)
    expect(tiles).toEqual([
      'OpenAPI / SwaggerA link, a file or the JSON or YAML',
      'GraphQLThe endpoint, or its schema',
      'SOAP / WSDLA WSDL link or file',
      'gRPC / protoA .proto file',
      'SDK / npmIts functions become tools',
      'Manual HTTPAn address; tools added by hand',
    ])
    expect(screen.queryByLabelText('Paste a link, drop a file, or paste it here')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Create a tool' })).toHaveAttribute('href', '/tools/new')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it.each([
    ['api-kind-openapi', '/apis/new/openapi'],
    ['api-kind-grpc', '/apis/new/grpc'],
    ['api-kind-sdk', '/apis/new/sdk'],
    ['api-kind-http', '/apis/new/http'],
  ])('%s opens its own form', async (tile, path) => {
    const { router } = renderAt('/apis/new')
    fireEvent.click(await screen.findByTestId(tile))
    await waitFor(() => expect(router.state.location.pathname).toBe(path))
  })
})

describe('/apis/new: ready-made provider APIs', () => {
  const OPENAI_SPEC = 'https://raw.githubusercontent.com/openai/openai-openapi/a1514fbafe294e45d9200b32f1df7511f95492f7/openapi.yaml'
  const openaiKey = { id: 'cred-openai', name: 'OpenAI', connectorKey: 'openai', connectorDisplayName: 'OpenAI', kind: 'inference', owner: 'org', health: { status: 'valid' }, createdAt: '2026-09-01T00:00:00.000Z' }

  it('offers the providers that publish an API description, as their own group of tiles', async () => {
    const { router } = renderAt('/apis/new')
    expect(await screen.findByRole('heading', { name: 'Ready-made provider APIs' })).toBeInTheDocument()
    const tiles = screen.getAllByTestId(/^provider-api-/).map((t) => t.getAttribute('data-testid'))
    expect(tiles).toEqual(['provider-api-openai', 'provider-api-mistral', 'provider-api-huggingface'])
    fireEvent.click(screen.getByTestId('provider-api-openai'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/apis/new/provider/openai'))
  })

  it('picks the provider key the organization already keeps, imports the pinned description and calls it with that key', async () => {
    vi.mocked(connectionsApi.list).mockResolvedValue([openaiKey] as any)
    vi.mocked(apisApi.connect).mockResolvedValue({ ...RESULT, needs: { key: true, address: false } } as any)
    vi.mocked(apisApi.setKey).mockResolvedValue({} as any)
    const { router } = renderAt('/apis/new/provider/openai')
    expect(await screen.findByRole('heading', { name: 'Connect OpenAI' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('combobox', { name: /OpenAI key/ })).toHaveTextContent('OpenAI'))
    fireEvent.click(screen.getByRole('button', { name: 'Connect API' }))

    await waitFor(() => expect(apisApi.connect).toHaveBeenCalledWith({ type: 'openapi', url: OPENAI_SPEC, name: 'OpenAI API' }))
    await waitFor(() => expect(apisApi.setKey).toHaveBeenCalledWith('api-9', { type: 'bearer', connectionId: 'cred-openai' }))
    // The key is in, so "Finish connecting" does not ask for it.
    await waitFor(() => expect(router.state.location.pathname).toBe('/apis/api-9/setup'))
    expect(router.state.location.search).not.toContain('key=1')
  })

  it('asks for a key when the organization keeps none, and imports nothing', async () => {
    vi.mocked(connectionsApi.list).mockResolvedValue([] as any)
    renderAt('/apis/new/provider/mistral')
    expect(await screen.findByRole('heading', { name: 'Connect Mistral' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create one here' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Connect API' }))
    expect(await screen.findByText('Pick your Mistral key, or create one here.')).toBeInTheDocument()
    expect(apisApi.connect).not.toHaveBeenCalled()
  })

  it('sends an unknown provider back to the tiles', async () => {
    const { router } = renderAt('/apis/new/provider/anthropic')
    await waitFor(() => expect(router.state.location.pathname).toBe('/apis/new'))
  })
})

describe('/apis/new/:type: the kind\'s own form', () => {
  it('asks for an OpenAPI description by link first, keeps the rest under Advanced, and goes on to ask for the key', async () => {
    vi.mocked(apisApi.connect).mockResolvedValue(RESULT as any)
    const user = userEvent.setup()
    const { router } = renderAt('/apis/new/openapi')
    expect(await screen.findByRole('heading', { name: 'Connect an API' })).toBeInTheDocument()
    expect(screen.getByText(/OpenAPI \/ Swagger: every operation/)).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Link' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'File' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Paste' })).toBeInTheDocument()
    // Nothing else to fill in until Advanced is opened.
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Advanced' })).toHaveAttribute('aria-expanded', 'false')

    await user.type(screen.getByLabelText('Link to the description'), 'https://petstore.example.com/openapi.json')
    await user.click(screen.getByRole('button', { name: 'Connect API' }))

    await waitFor(() => expect(apisApi.connect).toHaveBeenCalledWith({ type: 'openapi', url: 'https://petstore.example.com/openapi.json' }, undefined))
    await waitFor(() => expect(router.state.location.pathname).toBe('/apis/api-9/setup'))
    expect(router.state.location.search).toBe('?job=job-1&key=1')
  })

  it('sends pasted text as the description itself, with the kind picked', async () => {
    vi.mocked(apisApi.connect).mockResolvedValue({ ...RESULT, needs: { key: false, address: true } } as any)
    const user = userEvent.setup()
    const { router } = renderAt('/apis/new/graphql')
    await user.click(await screen.findByRole('tab', { name: 'Paste' }))
    const sdl = 'type Query {\n  countries: [String]\n}'
    fireEvent.change(screen.getByLabelText('The schema'), { target: { value: sdl } })
    await user.click(screen.getByRole('button', { name: 'Connect API' }))

    await waitFor(() => expect(apisApi.connect).toHaveBeenCalledWith({ type: 'graphql', content: sdl }, undefined))
    await waitFor(() => expect(router.state.location.search).toBe('?job=job-1&address=1'))
  })

  it('asks a GraphQL API for its endpoint, which describes itself', async () => {
    renderAt('/apis/new/graphql')
    expect(await screen.findByLabelText('Endpoint')).toHaveAttribute('placeholder', 'https://api.example.com/graphql')
    expect(screen.getByText(/asks the endpoint for its schema/)).toBeInTheDocument()
  })

  it('takes a chosen file, which can be removed again', async () => {
    vi.mocked(apisApi.connect).mockResolvedValue(RESULT as any)
    const user = userEvent.setup()
    renderAt('/apis/new/soap')
    // SOAP comes as a link or a file; there is nothing to paste.
    expect(await screen.findByRole('tab', { name: 'Link' })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Paste' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'File' }))
    const file = new File(['<definitions/>'], 'service.wsdl', { type: 'text/xml' })
    await user.upload(screen.getByLabelText('Choose a file'), file)
    expect(screen.getByTestId('source-file')).toHaveTextContent('service.wsdl')
    await user.click(screen.getByRole('button', { name: 'Remove service.wsdl' }))
    expect(screen.queryByTestId('source-file')).not.toBeInTheDocument()

    await user.upload(screen.getByLabelText('Choose a file'), file)
    await user.click(screen.getByRole('button', { name: 'Connect API' }))
    await waitFor(() => expect(apisApi.connect).toHaveBeenCalledWith({ type: 'soap' }, file))
  })

  it('opens a gRPC API on its .proto file, with no link to give', async () => {
    renderAt('/apis/new/grpc')
    expect(await screen.findByRole('tab', { name: 'File' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('tab', { name: 'Link' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Choose a file')).toHaveAttribute('accept', '.proto,.txt')
  })

  it('an empty Connect says what to do and imports nothing', async () => {
    const user = userEvent.setup()
    renderAt('/apis/new/openapi')
    await user.click(await screen.findByRole('button', { name: 'Connect API' }))
    expect(await screen.findByTestId('source-error')).toHaveTextContent('Paste the link.')
    const link = screen.getByLabelText('Link to the description')
    expect(link).toHaveAttribute('aria-invalid', 'true')
    await waitFor(() => expect(document.activeElement).toBe(link))
    expect(apisApi.connect).not.toHaveBeenCalled()
  })

  it('shows the server\'s plain-words refusal under the field, such as a description of another kind', async () => {
    vi.mocked(apisApi.connect).mockRejectedValue({ response: { status: 400, data: { message: 'This is a SOAP description, not an OpenAPI one. Pick SOAP instead, or give an OpenAPI description.' } } })
    const user = userEvent.setup()
    const { router } = renderAt('/apis/new/openapi')
    await user.type(await screen.findByLabelText('Link to the description'), 'https://www.example.com/service?wsdl')
    await user.click(screen.getByRole('button', { name: 'Connect API' }))
    expect(await screen.findByTestId('source-error')).toHaveTextContent('This is a SOAP description, not an OpenAPI one.')
    expect(router.state.location.pathname).toBe('/apis/new/openapi')
  })

  it('sends what Advanced overrides, and "don\'t make tools"', async () => {
    vi.mocked(apisApi.connect).mockResolvedValue(RESULT as any)
    const user = userEvent.setup()
    renderAt('/apis/new/openapi')
    await user.type(await screen.findByLabelText('Link to the description'), 'https://petstore.example.com/openapi.json')
    await user.click(screen.getByRole('button', { name: 'Advanced' }))
    await user.type(screen.getByLabelText('Name'), 'Pets')
    await user.type(screen.getByLabelText('Address'), 'https://staging.petstore.example.com')
    await user.click(screen.getByRole('combobox', { name: 'Sign-in' }))
    await user.click(await screen.findByRole('option', { name: 'Bearer token' }))
    await user.click(screen.getByLabelText('Make a tool for every operation'))
    // No teams in this organization: nothing to ask about who can use it.
    expect(screen.queryByTestId('who-can-use')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Connect API' }))

    await waitFor(() =>
      expect(apisApi.connect).toHaveBeenCalledWith(
        {
          type: 'openapi',
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
    renderAt('/apis/new/openapi')
    await user.type(await screen.findByLabelText('Link to the description'), 'https://petstore.example.com/openapi.json')
    await user.click(screen.getByRole('button', { name: 'Advanced' }))
    expect(await screen.findByTestId('who-can-use')).toHaveTextContent('Who can use it: everyone in your organization')
    await user.click(screen.getByRole('button', { name: 'Change' }))
    await user.click(screen.getByRole('radio', { name: /Private/ }))
    await user.click(screen.getByRole('button', { name: 'Connect API' }))
    await waitFor(() => expect(vi.mocked(apisApi.connect).mock.calls[0][0]).toMatchObject({ visibility: 'private', teamId: null }))
  })

  it('sends an unknown kind back to the tiles', async () => {
    const { router } = renderAt('/apis/new/rest')
    await waitFor(() => expect(router.state.location.pathname).toBe('/apis/new'))
  })
})

describe('/apis/new/http: manual HTTP', () => {
  it('creates an API from its address and how it signs in, then asks for the key', async () => {
    vi.mocked(apisApi.createHttpApi).mockResolvedValue({ id: 'api-7' } as any)
    const user = userEvent.setup()
    const { router } = renderAt('/apis/new/http')
    expect(await screen.findByRole('heading', { name: 'Connect an API' })).toBeInTheDocument()
    await user.type(screen.getByLabelText(/^Name/), 'Acme orders')
    await user.type(screen.getByLabelText(/^Address/), 'https://api.acme.example.com')
    await user.click(screen.getByRole('combobox', { name: 'How it signs in' }))
    await user.click(await screen.findByRole('option', { name: 'Key in a header' }))
    const header = screen.getByLabelText('Header')
    await user.clear(header)
    await user.type(header, 'X-Acme-Key')
    await user.click(screen.getByRole('button', { name: 'Connect API' }))

    await waitFor(() =>
      expect(apisApi.createHttpApi).toHaveBeenCalledWith({
        name: 'Acme orders',
        baseUrl: 'https://api.acme.example.com',
        authentication: { type: 'api_key', config: { headerName: 'X-Acme-Key', location: 'header' } },
      }),
    )
    await waitFor(() => expect(router.state.location.pathname).toBe('/apis/api-7/setup'))
    expect(router.state.location.search).toBe('?key=1')
  })

  it('goes straight to the API when it takes no key', async () => {
    vi.mocked(apisApi.createHttpApi).mockResolvedValue({ id: 'api-8' } as any)
    const user = userEvent.setup()
    const { router } = renderAt('/apis/new/http')
    await user.type(await screen.findByLabelText(/^Name/), 'Open data')
    await user.type(screen.getByLabelText(/^Address/), 'https://data.example.com')
    await user.click(screen.getByRole('button', { name: 'Connect API' }))
    await waitFor(() => expect(apisApi.createHttpApi).toHaveBeenCalledWith(expect.objectContaining({ authentication: { type: 'none', config: {} } })))
    await waitFor(() => expect(router.state.location.pathname).toBe('/apis/api-8'))
  })

  it('says what is missing and creates nothing', async () => {
    const user = userEvent.setup()
    renderAt('/apis/new/http')
    await user.type(await screen.findByLabelText(/^Address/), 'api.example.com')
    await user.click(screen.getByRole('button', { name: 'Connect API' }))
    expect(await screen.findByText('Give it a name.')).toBeInTheDocument()
    expect(screen.getByText('Enter the address, starting with http:// or https://.')).toBeInTheDocument()
    expect(apisApi.createHttpApi).not.toHaveBeenCalled()
  })
})

describe('/apis/:id/setup: finish connecting', () => {
  const keyView = { type: 'api_key', headerName: 'X-Pets-Key', location: 'header', oauth2: null, source: null, credential: null, connection: null }

  it('asks only for the key, picked from Credentials or created there, while the import runs; then opens the API', async () => {
    let finish: (v: unknown) => void = () => {}
    vi.mocked(apisApi.pollImportStatus).mockReturnValue(new Promise((r) => { finish = r }) as any)
    vi.mocked(apisApi.getKey).mockResolvedValue(keyView as any)
    vi.mocked(apisApi.setKey).mockResolvedValue({ ...keyView, source: 'connection', connection: { id: 'cred-1', name: 'Pets key', accountLabel: null, connectorKey: 'other' } } as any)
    const user = userEvent.setup()
    const { router } = renderAt('/apis/api-1/setup?job=job-1&key=1')

    expect(await screen.findByRole('heading', { name: 'Finish connecting Petstore' })).toBeInTheDocument()
    expect(apisApi.pollImportStatus).toHaveBeenCalledWith('api-1', 'job-1')
    expect(screen.getByTestId('import-status')).toHaveTextContent('Reading the description')
    expect(await screen.findByTestId('api-key-sent-as')).toHaveTextContent('Sent in the X-Pets-Key header')
    expect(screen.queryByText('Where does it run?')).not.toBeInTheDocument()

    // The one pick-or-create control: a key made here lands on Credentials.
    expect(screen.getByRole('button', { name: 'Create one here' })).toBeInTheDocument()
    await user.click(screen.getByRole('combobox', { name: 'Credential' }))
    await user.click(await screen.findByRole('option', { name: /Pets key/ }))
    await waitFor(() => expect(apisApi.setKey).toHaveBeenCalledWith('api-1', { type: 'api_key', connectionId: 'cred-1', headerName: 'X-Pets-Key', location: 'header' }))
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
    const skip = await screen.findByRole('button', { name: 'Skip for now' })
    // Styled as a link, not bare text nobody reads as clickable.
    expect(skip).toHaveClass('text-primary', 'hover:underline')
    await user.click(skip)
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
    await user.click(screen.getByRole('button', { name: 'Connect API' }))
    await waitFor(() =>
      expect(apisApi.createSdkApi).toHaveBeenCalledWith(expect.objectContaining({ name: 'S3', dependencies: { '@aws-sdk/client-s3': '*' } })),
    )
    await waitFor(() => expect(router.state.location.pathname).toBe('/apis/api-5'))
  })
})
