import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router-dom'

import { GatewaysPage } from '../gateways'
import { GatewayNewPage } from '../gateway-new'
import { GatewayDetailPage } from '../gateway-detail'
import { GatewayEditPage } from '../gateway-edit'
import { agentsApi, gatewaysApi, toolsApi } from '@/lib/api'

// Routes under test: the real router, not setup.tsx's stubs.
vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getApiBaseUrl: () => 'https://api.example.com',
    gatewaysApi: {
      getAll: vi.fn(),
      getById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      getTools: vi.fn(),
      updateToolConfig: vi.fn(),
      assignTool: vi.fn(),
      removeTool: vi.fn(),
      bulkAssignTools: vi.fn(),
      removeAllTools: vi.fn(),
      getAuthConfigs: vi.fn(),
      listApiKeys: vi.fn(),
      createAuthConfig: vi.fn(),
      deleteAuthConfig: vi.fn(),
      generateApiKey: vi.fn(),
      revokeApiKey: vi.fn(),
      getEvents: vi.fn(),
      testChannelConnection: vi.fn(),
      activate: vi.fn(),
      deactivate: vi.fn(),
    },
    toolsApi: { getAll: vi.fn() },
    agentsApi: { getAll: vi.fn() },
    organizationsApi: { getTeams: vi.fn().mockResolvedValue([]) },
  }
})

vi.mock('@/hooks/use-entitlement', () => ({ useEntitlements: () => new Set<string>() }))

vi.mock('@/store/organization', () => {
  const ORG = { id: 'org-1', name: 'Acme Inc', slug: 'acme' }
  const useOrganizationStore: any = () => ({ currentOrganization: ORG })
  useOrganizationStore.getState = () => ({ currentOrganization: ORG })
  return { useOrganizationStore }
})

const notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('@/store/app', () => ({ useNotifications: () => notify }))

// Visibility is owned by another workstream; its behaviour is not under test.
vi.mock('@/components/ui/visibility-field', () => ({ VisibilityField: () => null }))

beforeEach(() => {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false) as any
    Element.prototype.setPointerCapture = vi.fn() as any
    Element.prototype.releasePointerCapture = vi.fn() as any
  }
})

function Where() {
  const location = useLocation()
  return <p data-testid="where">{location.pathname + location.search}</p>
}

function renderAt(path: string, state?: unknown) {
  const router = createMemoryRouter(
    [
      { path: '/gateways', element: <><GatewaysPage /><Where /></> },
      { path: '/gateways/new', element: <><GatewayNewPage /><Where /></> },
      { path: '/gateways/:id', element: <><GatewayDetailPage /><Where /></> },
      { path: '/gateways/:id/edit', element: <><GatewayEditPage /><Where /></> },
    ],
    { initialEntries: [{ pathname: path.split('?')[0], search: path.includes('?') ? `?${path.split('?')[1]}` : '', state }] },
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

const where = () => screen.getByTestId('where').textContent

const GATEWAY = {
  id: 'gw-1',
  name: 'Petstore',
  description: 'Pets',
  type: 'mcp',
  status: 'active',
  endpoint: '/petstore',
  configuration: {},
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(gatewaysApi.getAll).mockResolvedValue({ gateways: [] } as any)
  vi.mocked(gatewaysApi.getById).mockResolvedValue(GATEWAY as any)
  vi.mocked(gatewaysApi.getTools).mockResolvedValue([] as any)
  vi.mocked(gatewaysApi.getAuthConfigs).mockResolvedValue([{ id: 'a-1', type: 'api_key', configuration: {} }] as any)
  vi.mocked(gatewaysApi.listApiKeys).mockResolvedValue([] as any)
  vi.mocked(gatewaysApi.getEvents).mockResolvedValue([] as any)
  vi.mocked(toolsApi.getAll).mockResolvedValue({ tools: [] } as any)
  vi.mocked(agentsApi.getAll).mockResolvedValue([{ id: 'agent-1', name: 'Support agent' }] as any)
})

const SHAREABLE = [
  { id: 't1', name: 'listPets', status: 'active', visibility: 'org', api: { id: 'api-1', name: 'Petstore' } },
  // The list carries a spec-imported tool's API on its operation.
  { id: 't2', name: 'getPet', status: 'active', visibility: 'org', operation: { api: { id: 'api-1', name: 'Petstore' } } },
  { id: 't3', name: 'deletePet', status: 'draft', visibility: 'org', api: { id: 'api-1', name: 'Petstore' } },
  { id: 't4', name: 'weatherNow', status: 'active', visibility: 'org' },
  { id: 't5', name: 'myNotes', status: 'active', visibility: 'private' },
]

const SHARED = {
  id: 'gw-9',
  name: 'Petstore',
  description: '',
  type: 'tools',
  status: 'active',
  endpoint: '/petstore',
  configuration: {},
}

describe('/gateways/new: share tools', () => {
  beforeEach(() => {
    vi.mocked(toolsApi.getAll).mockResolvedValue({ tools: SHAREABLE } as any)
    vi.mocked(gatewaysApi.getById).mockImplementation(async (id: string) => (id === 'gw-9' ? SHARED : GATEWAY) as any)
  })

  it('is where an old ?new=1 link lands, and asks for tools, not a protocol or an agent', async () => {
    renderAt('/gateways?new=1')
    await waitFor(() => expect(where()).toBe('/gateways/new'))
    expect(screen.getByRole('heading', { level: 1, name: 'Share tools' })).toBeInTheDocument()
    await screen.findByTestId('share-api-api-1')
    expect(screen.queryByLabelText(/^Protocol/)).toBeNull()
    expect(screen.queryByRole('radio', { name: /^Agent/ })).toBeNull()
    expect(screen.queryByText(/A2A|Slack|Telegram/)).toBeNull()
  })

  it('shares a whole API: its active tools, named after it, then shows the key and the snippets', async () => {
    const user = userEvent.setup()
    vi.mocked(gatewaysApi.create).mockResolvedValue({
      id: 'gw-9',
      initialApiKey: 'ak_secret_once',
      sharedTools: { associated: 2, skipped: [] },
    } as any)
    renderAt('/gateways/new')

    await user.click(await screen.findByTestId('share-api-api-1'))
    // The draft is part of the API but can't be shared; the name follows the API.
    expect(screen.getByLabelText(/^Name/)).toHaveValue('Petstore')
    expect(screen.getByText(/Address: .*\/acme\/petstore$/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Share 2 tools' }))

    await waitFor(() =>
      expect(gatewaysApi.create).toHaveBeenCalledWith({
        name: 'Petstore',
        type: 'tools',
        kind: 'tool',
        endpoint: '/petstore',
        description: undefined,
        configuration: {},
        visibility: 'org',
        teamId: null,
        toolIds: ['t1', 't2'],
      }),
    )
    await waitFor(() => expect(where()).toBe('/gateways/gw-9'))
    expect(await screen.findByTestId('initial-api-key')).toHaveTextContent('ak_secret_once')
    // The snippets carry the key, right away.
    const claudeCode = await screen.findByTestId('snippet-claude-code')
    expect(claudeCode).toHaveTextContent('claude mcp add petstore --transport http')
    expect(claudeCode).toHaveTextContent('/acme/petstore --header "x-api-key: ak_secret_once"')
    expect(screen.queryByTestId('key-placeholder-note')).toBeNull()
    expect(screen.getByRole('tab', { name: 'Cursor' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Claude Desktop' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'UTCP' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Skills' })).toBeInTheDocument()
  })

  it('says which picked tools were not shared, and why', async () => {
    const user = userEvent.setup()
    vi.mocked(gatewaysApi.create).mockResolvedValue({
      id: 'gw-9',
      initialApiKey: 'ak_secret_once',
      sharedTools: { associated: 1, skipped: [{ toolId: 't4', reason: 'Tool is paused.' }] },
    } as any)
    renderAt('/gateways/new')
    await user.click(await screen.findByLabelText(/weatherNow/))
    await user.click(screen.getByLabelText(/listPets/))
    await user.click(screen.getByRole('button', { name: 'Share 2 tools' }))

    const skipped = await screen.findByTestId('shared-tools-skipped')
    expect(skipped).toHaveTextContent("1 tool wasn't shared")
    expect(skipped).toHaveTextContent('Tool is paused.')
  })

  it('names a single-tool share after the tool', async () => {
    const user = userEvent.setup()
    renderAt('/gateways/new')
    await user.click(await screen.findByLabelText(/weatherNow/))
    expect(screen.getByLabelText(/^Name/)).toHaveValue('weatherNow')
  })

  it('keeps a draft out of reach', async () => {
    renderAt('/gateways/new')
    expect(await screen.findByLabelText(/deletePet/)).toBeDisabled()
  })

  it('makes a share private when it holds a private tool', async () => {
    const user = userEvent.setup()
    vi.mocked(gatewaysApi.create).mockResolvedValue({ id: 'gw-9' } as any)
    renderAt('/gateways/new')
    await user.click(await screen.findByLabelText(/myNotes/))
    await user.click(screen.getByRole('button', { name: 'Share 1 tool' }))
    await waitFor(() =>
      expect(gatewaysApi.create).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'private', toolIds: ['t5'] })),
    )
  })

  it('opens with an API already picked from its page', async () => {
    renderAt('/gateways/new?api=api-1')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share 2 tools' })).toBeInTheDocument())
    expect(screen.getByTestId('share-api-api-1')).toHaveAttribute('aria-pressed', 'true')
  })

  it('refuses to share nothing', async () => {
    const user = userEvent.setup()
    renderAt('/gateways/new')
    await screen.findByTestId('share-api-api-1')
    await user.click(screen.getByRole('button', { name: 'Share tools' }))
    expect(await screen.findByText('Pick at least one tool, or an API.')).toBeInTheDocument()
    expect(gatewaysApi.create).not.toHaveBeenCalled()
  })

  it('keeps path, description and who can use it under Advanced', async () => {
    const user = userEvent.setup()
    renderAt('/gateways/new')
    await screen.findByTestId('share-api-api-1')
    expect(screen.queryByLabelText(/^Path/)).toBeNull()
    expect(screen.queryByLabelText(/^Description/)).toBeNull()
    await user.click(screen.getByRole('button', { name: /^Advanced/ }))
    expect(screen.getByLabelText(/^Path/)).toBeInTheDocument()
    expect(screen.getByLabelText(/^Description/)).toBeInTheDocument()
    expect(screen.getByTestId('who-can-use')).toBeInTheDocument()
  })
})

describe('a shared-tools gateway page', () => {
  beforeEach(() => {
    vi.mocked(gatewaysApi.getById).mockResolvedValue(SHARED as any)
  })

  it('leads with the address and snippets; keys, usage and events wait under Advanced', async () => {
    const user = userEvent.setup()
    renderAt('/gateways/gw-9')
    expect(await screen.findByTestId('connect-snippets')).toBeInTheDocument()
    // No key in hand any more: a placeholder, and where a new one comes from.
    expect(screen.getByTestId('snippet-claude-code')).toHaveTextContent('<your-access-key>')
    expect(screen.getByTestId('key-placeholder-note')).toBeInTheDocument()
    expect(screen.queryByText('Authentication')).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Integrations' })).toBeNull()
    // Just the list of what is shared: no scoping presets to learn.
    expect(screen.getByRole('heading', { name: /Shared tools/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Read only' })).toBeNull()

    await user.click(screen.getByRole('button', { name: /^Advanced/ }))
    expect(await screen.findByText('Authentication')).toBeInTheDocument()
    expect(screen.getByText('Performance metrics')).toBeInTheDocument()
  })

  it('pauses and resumes with one switch', async () => {
    const user = userEvent.setup()
    vi.mocked(gatewaysApi.deactivate).mockResolvedValue({} as any)
    renderAt('/gateways/gw-9')
    const toggle = await screen.findByRole('switch', { name: 'Pause' })
    expect(within(screen.getByTestId('gateway-status-switch')).getByText('Live')).toBeInTheDocument()
    await user.click(toggle)
    await waitFor(() => expect(gatewaysApi.deactivate).toHaveBeenCalledWith('gw-9'))
    expect(gatewaysApi.update).not.toHaveBeenCalled()
  })

  it('shows a paused gateway as paused, and resumes it', async () => {
    const user = userEvent.setup()
    vi.mocked(gatewaysApi.getById).mockResolvedValue({ ...SHARED, status: 'inactive' } as any)
    vi.mocked(gatewaysApi.activate).mockResolvedValue({} as any)
    renderAt('/gateways/gw-9')
    await user.click(await screen.findByRole('switch', { name: 'Resume' }))
    await waitFor(() => expect(gatewaysApi.activate).toHaveBeenCalledWith('gw-9'))
  })
})

describe('gateway detail, edited on its own page', () => {
  it('"Edit gateway" opens /gateways/:id/edit, which saves and returns', async () => {
    const user = userEvent.setup()
    vi.mocked(gatewaysApi.update).mockResolvedValue({} as any)
    renderAt('/gateways/gw-1')

    await user.click(await screen.findByRole('button', { name: /Edit gateway/ }))
    await waitFor(() => expect(where()).toBe('/gateways/gw-1/edit'))
    const form = await screen.findByRole('form', { name: 'Edit gateway' })
    expect(screen.queryByRole('dialog')).toBeNull()

    const name = within(form).getByLabelText(/^Name/)
    await waitFor(() => expect(name).toHaveValue('Petstore'))
    await user.clear(name)
    await user.type(name, 'Petstore v2')
    await user.click(within(form).getByRole('button', { name: 'Save changes' }))

    // The stored scope did not change, so it is not sent.
    await waitFor(() =>
      expect(gatewaysApi.update).toHaveBeenCalledWith('gw-1', {
        name: 'Petstore v2',
        endpoint: '/petstore',
        description: 'Pets',
      }),
    )
    await waitFor(() => expect(where()).toBe('/gateways/gw-1'))
  })

  it('sends an old ?edit=1 link (the list row menu used it) to the edit page', async () => {
    renderAt('/gateways/gw-1?edit=1')
    await waitFor(() => expect(where()).toBe('/gateways/gw-1/edit'))
    expect(await screen.findByRole('form', { name: 'Edit gateway' })).toBeInTheDocument()
  })

  it('refuses an empty name and focuses it', async () => {
    const user = userEvent.setup()
    renderAt('/gateways/gw-1/edit')
    const form = await screen.findByRole('form', { name: 'Edit gateway' })
    const name = within(form).getByLabelText(/^Name/)
    await waitFor(() => expect(name).toHaveValue('Petstore'))
    await user.clear(name)
    await user.click(within(form).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(name).toHaveAttribute('aria-invalid', 'true'))
    await waitFor(() => expect(document.activeElement).toBe(name))
    expect(gatewaysApi.update).not.toHaveBeenCalled()
  })

  it('edits a tool security policy under its row', async () => {
    const user = userEvent.setup()
    vi.mocked(toolsApi.getAll).mockResolvedValue({ tools: [{ id: 't1', name: 'listPets', status: 'active' }] } as any)
    vi.mocked(gatewaysApi.getTools).mockResolvedValue([{ id: 'gt-1', toolId: 't1', securityPolicy: null }] as any)
    vi.mocked(gatewaysApi.updateToolConfig).mockResolvedValue({} as any)
    renderAt('/gateways/gw-1')

    await user.click(await screen.findByText('Custom Tools'))
    await user.click(await screen.findByRole('button', { name: 'Security policy for listPets' }))
    const form = screen.getByRole('form', { name: 'Security policy' })
    expect(screen.queryByRole('dialog')).toBeNull()
    await user.type(within(form).getByLabelText('Allowed domains'), 'api.pets.com')
    await user.click(within(form).getByRole('button', { name: 'Save policy' }))

    await waitFor(() =>
      expect(gatewaysApi.updateToolConfig).toHaveBeenCalledWith('gw-1', 'gt-1', {
        securityPolicy: { allowedDomains: ['api.pets.com'], requireHttps: false },
      }),
    )
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Security policy' })).toBeNull())
  })
})
