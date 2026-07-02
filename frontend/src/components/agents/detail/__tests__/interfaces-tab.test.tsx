import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { renderWithProviders } from '../../../../test/setup'
import { InterfacesTab } from '../interfaces-tab'
import { gatewaysApi } from '@/lib/api'

const copyMock = vi.fn()

vi.mock('@/lib/api', () => ({
  gatewaysApi: {
    getAll: vi.fn(),
    create: vi.fn(),
    testChannelConnection: vi.fn(),
  },
  getApiBaseUrl: () => 'https://api.example.com',
}))

vi.mock('@/lib/clipboard', () => ({
  useCopy: () => copyMock,
}))

vi.mock('@/store/organization', () => ({
  useOrganizationStore: () => ({
    currentOrganization: { id: 'org-1', name: 'Acme Corp', slug: 'acme' },
  }),
}))

const slackGateway = {
  id: 'gw-1',
  name: 'Support Bot',
  type: 'slack',
  kind: 'agent',
  status: 'active',
  endpoint: '/support-bot',
  configuration: { botToken: 'xoxb-secret', signingSecret: 'shh' },
  totalRequests: 3,
}

describe('InterfacesTab channel setup', () => {
  beforeEach(() => vi.clearAllMocks())

  it('opens the setup panel with the webhook URL from a deployed channel card', async () => {
    ;(gatewaysApi.getAll as any).mockResolvedValue({ gateways: [slackGateway] })
    renderWithProviders(<InterfacesTab agentId="agent-1" interfaces={[]} />)

    fireEvent.click(await screen.findByRole('button', { name: /Setup/ }))

    expect(await screen.findByTestId('channel-setup-panel')).toBeInTheDocument()
    expect(screen.getByTestId('channel-webhook-url')).toHaveTextContent(
      'https://api.example.com/acme/support-bot',
    )
    expect(screen.getByText('Slack setup')).toBeInTheDocument()
  })

  it('opens the setup panel automatically after deploying a channel', async () => {
    ;(gatewaysApi.getAll as any).mockResolvedValue({ gateways: [] })
    ;(gatewaysApi.create as any).mockResolvedValue({
      id: 'gw-2',
      name: 'a2a gateway',
      type: 'a2a',
      endpoint: '/a2a',
    })
    renderWithProviders(<InterfacesTab agentId="agent-1" interfaces={[]} />)

    fireEvent.click(await screen.findByRole('button', { name: /Deploy Channel/ }))
    fireEvent.click(await screen.findByRole('button', { name: /^Deploy$/ }))

    await waitFor(() => {
      expect(screen.getByTestId('channel-setup-panel')).toBeInTheDocument()
    })
    expect(screen.getByTestId('channel-webhook-url')).toHaveTextContent(
      'https://api.example.com/acme/a2a',
    )
    expect(gatewaysApi.create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'agent', type: 'a2a', agentId: 'agent-1' }),
    )
  })
})
