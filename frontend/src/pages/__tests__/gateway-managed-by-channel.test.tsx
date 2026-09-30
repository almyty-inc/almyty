import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router-dom'

import { GatewayDetailPage } from '../gateway-detail'
import { gatewaysApi, toolsApi } from '@/lib/api'
import { channelLinkApi } from '@/lib/agent-channels'

/**
 * A gateway an agent channel stood up says so and links to the channel
 * on the agent, instead of carrying a second copy of its settings.
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

vi.mock('@/lib/agent-channels', async () => {
  const actual = await vi.importActual<typeof import('@/lib/agent-channels')>('@/lib/agent-channels')
  return { ...actual, channelLinkApi: { channelForGateway: vi.fn() } }
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
      { path: '/agents/:id/channels/:channelId', element: <Where /> },
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
  configuration: { hostedChat: { slug: 'acme-support', authMode: 'oauth' }, channelId: 'channel-1' },
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

describe('a gateway an agent channel manages', () => {
  it('says which agent, links to the channel, and drops the settings the channel owns', async () => {
    vi.mocked(gatewaysApi.getById).mockResolvedValue(hostedChat as any)
    vi.mocked(channelLinkApi.channelForGateway).mockResolvedValue({
      agent: { id: 'agent-1', name: 'Support agent' },
      channel: { id: 'channel-1', type: 'web' },
    })
    renderAt('/gateways/gw-web')

    const banner = await screen.findByTestId('managed-by-channel')
    expect(banner).toHaveTextContent('Web chat channel of Support agent')
    const link = screen.getByRole('link', { name: /Open the channel/ })
    expect(link).toHaveAttribute('href', '/agents/agent-1/channels/channel-1')
    expect(channelLinkApi.channelForGateway).toHaveBeenCalledWith('gw-web')

    expect(screen.queryByText('Custom domain')).toBeNull()
    expect(screen.queryByText('Allowed sites')).toBeNull()
    expect(screen.queryByText('Visitor sign-in provider')).toBeNull()

    await userEvent.click(link)
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/agents/agent-1/channels/channel-1'))
  })

  it('hides the credential form of a messaging channel', async () => {
    vi.mocked(gatewaysApi.getById).mockResolvedValue({
      ...hostedChat,
      id: 'gw-slack',
      type: 'slack',
      configuration: { channelId: 'channel-2', credentialKeys: ['bot_token'] },
    } as any)
    vi.mocked(channelLinkApi.channelForGateway).mockResolvedValue({
      agent: { id: 'agent-1', name: 'Support agent' },
      channel: { id: 'channel-2', type: 'slack' },
    })
    renderAt('/gateways/gw-slack')
    expect(await screen.findByRole('link', { name: /Open the channel/ })).toHaveAttribute('href', '/agents/agent-1/channels/channel-2')
    expect(screen.queryByLabelText(/Bot token/i)).toBeNull()
  })

  it('shows no banner, and no channel cards, for a gateway no channel owns', async () => {
    vi.mocked(gatewaysApi.getById).mockResolvedValue({
      ...hostedChat,
      id: 'gw-widget',
      type: 'chat_widget',
      configuration: {},
    } as any)
    vi.mocked(channelLinkApi.channelForGateway).mockResolvedValue(null)
    renderAt('/gateways/gw-widget')
    await waitFor(() => expect(channelLinkApi.channelForGateway).toHaveBeenCalledWith('gw-widget'))
    await waitFor(() => expect(gatewaysApi.getById).toHaveBeenCalled())
    // A web chat or widget is set up on its agent's channel page, not here.
    expect(screen.queryByText('Allowed sites')).toBeNull()
    expect(screen.queryByTestId('managed-by-channel')).toBeNull()
  })
})
