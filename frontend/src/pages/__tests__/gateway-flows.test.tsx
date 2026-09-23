import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router-dom'

import { GatewaysPage } from '../gateways'
import { GatewayNewPage } from '../gateway-new'
import { GatewayDetailPage } from '../gateway-detail'
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

describe('/gateways/new', () => {
  it('is where an old ?new=1 link lands', async () => {
    renderAt('/gateways?new=1')
    await waitFor(() => expect(where()).toBe('/gateways/new'))
    expect(screen.getByRole('heading', { level: 1, name: 'Create gateway' })).toBeInTheDocument()
  })

  it('creates an MCP gateway with its default configuration, then opens it', async () => {
    const user = userEvent.setup()
    vi.mocked(gatewaysApi.create).mockResolvedValue({ id: 'gw-9', initialApiKey: 'gw_secret_once' } as any)
    renderAt('/gateways/new')

    await user.type(screen.getByLabelText(/^Name/), 'Pet Tools')
    expect(screen.getByLabelText(/^Endpoint path/)).toHaveValue('/pet-tools')
    await user.click(screen.getByLabelText(/^Protocol/))
    await user.click(await screen.findByRole('option', { name: /^MCP/ }))
    await user.click(screen.getByRole('button', { name: 'Create gateway' }))

    await waitFor(() =>
      expect(gatewaysApi.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Pet Tools',
          type: 'mcp',
          endpoint: '/pet-tools',
          kind: 'tool',
          configuration: { transport: 'http' },
        }),
      ),
    )
    await waitFor(() => expect(where()).toBe('/gateways/gw-9'))
    // The key minted with the gateway is shown once, on its page.
    const shown = await screen.findByTestId('initial-api-key')
    expect(shown).toHaveTextContent('gw_secret_once')
    expect(shown).toHaveTextContent(/won't see it again/)
  })

  it('refuses a submit with no name or protocol and focuses the first', async () => {
    const user = userEvent.setup()
    renderAt('/gateways/new')
    await user.click(screen.getByRole('button', { name: 'Create gateway' }))

    const name = screen.getByLabelText(/^Name/)
    await waitFor(() => expect(name).toHaveAttribute('aria-invalid', 'true'))
    expect(screen.getByText('Type is required')).toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(/^Protocol/)))
    expect(gatewaysApi.create).not.toHaveBeenCalled()
  })

  it('asks for the agent when the gateway serves one', async () => {
    const user = userEvent.setup()
    renderAt('/gateways/new')
    await user.click(screen.getByRole('radio', { name: /^Agent/ }))
    await user.type(screen.getByLabelText(/^Name/), 'Helper')
    await user.click(screen.getByLabelText(/^Protocol/))
    await user.click(await screen.findByRole('option', { name: /^A2A/ }))
    await user.click(screen.getByRole('button', { name: 'Create gateway' }))

    expect(await screen.findByText(/Choose the agent/)).toBeInTheDocument()
    expect(gatewaysApi.create).not.toHaveBeenCalled()
  })
})

describe('gateway detail, edited in place', () => {
  it('opens the edit form inline from the header and saves it', async () => {
    const user = userEvent.setup()
    vi.mocked(gatewaysApi.update).mockResolvedValue({} as any)
    renderAt('/gateways/gw-1')

    await user.click(await screen.findByRole('button', { name: /Edit gateway/ }))
    const form = screen.getByRole('form', { name: 'Edit gateway' })
    expect(screen.queryByRole('dialog')).toBeNull()

    const name = within(form).getByLabelText(/^Name/)
    await user.clear(name)
    await user.type(name, 'Petstore v2')
    await user.click(within(form).getByRole('button', { name: 'Save changes' }))

    await waitFor(() =>
      expect(gatewaysApi.update).toHaveBeenCalledWith('gw-1', {
        name: 'Petstore v2',
        endpoint: '/petstore',
        description: 'Pets',
        status: 'active',
      }),
    )
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Edit gateway' })).toBeNull())
  })

  it('opens editing straight away from the list row menu (?edit=1)', async () => {
    renderAt('/gateways/gw-1?edit=1')
    expect(await screen.findByRole('form', { name: 'Edit gateway' })).toBeInTheDocument()
  })

  it('refuses an empty name and focuses it', async () => {
    const user = userEvent.setup()
    renderAt('/gateways/gw-1?edit=1')
    const form = await screen.findByRole('form', { name: 'Edit gateway' })
    await user.clear(within(form).getByLabelText(/^Name/))
    await user.click(within(form).getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(within(form).getByLabelText(/^Name/)).toHaveAttribute('aria-invalid', 'true'),
    )
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
