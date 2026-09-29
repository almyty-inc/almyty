import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router-dom'

import { GatewayDetailPage } from '../gateway-detail'
import { gatewaysApi, toolsApi } from '@/lib/api'
import { appPlacesApi } from '@/lib/agent-apps'

/**
 * A gateway an app stood up says "Managed in <app>" and links to the
 * place on the app, instead of carrying a second copy of its settings.
 */
vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getApiBaseUrl: () => 'https://api.example.com',
    gatewaysApi: {
      getById: vi.fn(),
      getTools: vi.fn(),
      getAuthConfigs: vi.fn(),
      listApiKeys: vi.fn(),
      getEvents: vi.fn(),
      getCustomDomain: vi.fn(),
      getVisitorOAuth: vi.fn(),
      update: vi.fn(),
    },
    toolsApi: { getAll: vi.fn() },
    organizationsApi: { getTeams: vi.fn().mockResolvedValue([]) },
  }
})

vi.mock('@/lib/agent-apps', async () => {
  const actual = await vi.importActual<typeof import('@/lib/agent-apps')>('@/lib/agent-apps')
  return { ...actual, appPlacesApi: { usedBy: vi.fn(), appForGateway: vi.fn() } }
})

vi.mock('@/store/organization', () => {
  const ORG = { id: 'org-1', name: 'Acme Inc', slug: 'acme' }
  const useOrganizationStore: any = () => ({ currentOrganization: ORG })
  useOrganizationStore.getState = () => ({ currentOrganization: ORG })
  return { useOrganizationStore }
})
vi.mock('@/store/app', () => ({ useNotifications: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }) }))
vi.mock('@/components/ui/visibility-field', () => ({ VisibilityField: () => null }))

function Where() {
  const location = useLocation()
  return <p data-testid="where">{location.pathname}</p>
}

function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      { path: '/gateways/:id', element: <><GatewayDetailPage /><Where /></> },
      { path: '/apps/:slug/distributions/:target', element: <Where /> },
    ],
    { initialEntries: [path] },
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

const hostedChat = {
  id: 'gw-web',
  name: 'Acme Support (web)',
  type: 'hosted_chat',
  status: 'active',
  endpoint: '/apps/acme-support/web',
  configuration: { hostedChat: { slug: 'acme-support', authMode: 'oauth' }, appId: 'app-1' },
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(gatewaysApi.getTools).mockResolvedValue([] as any)
  vi.mocked(gatewaysApi.getAuthConfigs).mockResolvedValue([] as any)
  vi.mocked(gatewaysApi.listApiKeys).mockResolvedValue([] as any)
  vi.mocked(gatewaysApi.getEvents).mockResolvedValue([] as any)
  vi.mocked(gatewaysApi.getCustomDomain).mockResolvedValue(null as any)
  vi.mocked(gatewaysApi.getVisitorOAuth).mockResolvedValue({ provider: null, redirectUris: [] } as any)
  vi.mocked(toolsApi.getAll).mockResolvedValue({ tools: [] } as any)
})

describe('a gateway an app manages', () => {
  it('says which app, links to the place, and drops the settings the app owns', async () => {
    vi.mocked(gatewaysApi.getById).mockResolvedValue(hostedChat as any)
    vi.mocked(appPlacesApi.appForGateway).mockResolvedValue({
      app: { id: 'app-1', slug: 'acme-support', name: 'Acme support' },
      target: 'web',
    })
    renderAt('/gateways/gw-web')

    const banner = await screen.findByTestId('managed-by-app')
    expect(banner).toHaveTextContent('Managed in Acme support')
    const link = screen.getByRole('link', { name: /Open Web app in Acme support/ })
    expect(link).toHaveAttribute('href', '/apps/acme-support/distributions/web')
    expect(appPlacesApi.appForGateway).toHaveBeenCalledWith('gw-web')

    expect(screen.queryByText('Custom domain')).toBeNull()
    expect(screen.queryByText('Allowed sites')).toBeNull()
    expect(screen.queryByText('Visitor sign-in provider')).toBeNull()

    await userEvent.click(link)
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/apps/acme-support/distributions/web'))
  })

  it('hides the channel credential form of a channel an app manages', async () => {
    vi.mocked(gatewaysApi.getById).mockResolvedValue({
      ...hostedChat,
      id: 'gw-slack',
      type: 'slack',
      configuration: { appId: 'app-1', credentialKeys: ['bot_token'] },
    } as any)
    vi.mocked(appPlacesApi.appForGateway).mockResolvedValue({
      app: { id: 'app-1', slug: 'acme-support', name: 'Acme support' },
      target: 'slack',
    })
    renderAt('/gateways/gw-slack')
    expect(await screen.findByRole('link', { name: /Open Slack in Acme support/ })).toHaveAttribute(
      'href',
      '/apps/acme-support/distributions/slack',
    )
    expect(screen.queryByLabelText(/Bot token/i)).toBeNull()
  })

  it('shows no banner, and keeps the widget cards, for a gateway no app owns', async () => {
    vi.mocked(gatewaysApi.getById).mockResolvedValue({
      ...hostedChat,
      id: 'gw-widget',
      type: 'chat_widget',
      configuration: {},
    } as any)
    vi.mocked(appPlacesApi.appForGateway).mockResolvedValue(null)
    renderAt('/gateways/gw-widget')
    expect(await screen.findByText('Allowed sites')).toBeInTheDocument()
    await waitFor(() => expect(appPlacesApi.appForGateway).toHaveBeenCalledWith('gw-widget'))
    expect(screen.queryByTestId('managed-by-app')).toBeNull()
  })
})
