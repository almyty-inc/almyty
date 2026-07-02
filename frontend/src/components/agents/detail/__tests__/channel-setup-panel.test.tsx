import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { renderWithProviders } from '../../../../test/setup'
import { ChannelSetupPanel } from '../channel-setup-panel'
import { gatewaysApi } from '@/lib/api'
import type { Gateway } from '@/types'

const copyMock = vi.fn()

vi.mock('@/lib/api', () => ({
  gatewaysApi: {
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

const makeGateway = (overrides: Partial<Gateway> = {}): Gateway =>
  ({
    id: 'gw-1',
    name: 'Support Bot',
    type: 'slack',
    kind: 'agent',
    status: 'active',
    endpoint: '/support-bot',
    configuration: {},
    ...overrides,
  }) as unknown as Gateway

describe('ChannelSetupPanel', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders the webhook URL derived from api host, org slug, and gateway slug', () => {
    renderWithProviders(<ChannelSetupPanel gateway={makeGateway()} />)

    expect(screen.getByTestId('channel-webhook-url')).toHaveTextContent(
      'https://api.example.com/acme/support-bot',
    )
  })

  it('falls back to a slugified gateway name when the gateway has no endpoint', () => {
    renderWithProviders(<ChannelSetupPanel gateway={makeGateway({ endpoint: '', name: 'My Bot' })} />)

    expect(screen.getByTestId('channel-webhook-url')).toHaveTextContent(
      'https://api.example.com/acme/my-bot',
    )
  })

  it('shows the slack setup checklist for a slack channel', () => {
    renderWithProviders(<ChannelSetupPanel gateway={makeGateway({ type: 'slack' } as any)} />)

    expect(screen.getByText('Slack setup')).toBeInTheDocument()
    expect(screen.getByText(/api\.slack\.com\/apps/)).toBeInTheDocument()
    expect(screen.getByText(/chat:write, app_mentions:read, and im:history/)).toBeInTheDocument()
    expect(screen.getByText(/Event Subscriptions/)).toBeInTheDocument()
    expect(screen.getByText(/message\.im and app_mention/)).toBeInTheDocument()
  })

  it('shows the embed snippet with a copy button for the chat widget', () => {
    renderWithProviders(<ChannelSetupPanel gateway={makeGateway({ type: 'chat_widget' } as any)} />)

    expect(screen.getByTestId('widget-embed-snippet')).toHaveTextContent(
      '<script src="https://api.example.com/gateways/gw-1/widget.js" async></script>',
    )

    fireEvent.click(screen.getByRole('button', { name: /Copy embed snippet/ }))
    expect(copyMock).toHaveBeenCalledWith(
      '<script src="https://api.example.com/gateways/gw-1/widget.js" async></script>',
      'Embed snippet',
    )
  })

  it('copies the webhook URL when the copy button is clicked', () => {
    renderWithProviders(<ChannelSetupPanel gateway={makeGateway()} />)

    fireEvent.click(screen.getByRole('button', { name: /Copy webhook URL/ }))
    expect(copyMock).toHaveBeenCalledWith('https://api.example.com/acme/support-bot', 'Webhook URL')
  })

  it('notes automatic webhook registration for telegram', () => {
    renderWithProviders(<ChannelSetupPanel gateway={makeGateway({ type: 'telegram' } as any)} />)

    expect(screen.getByText(/Registered automatically where the platform supports it/)).toBeInTheDocument()
  })

  it('runs the connection test and shows a success badge', async () => {
    ;(gatewaysApi.testChannelConnection as any).mockResolvedValue({ ok: true, detail: 'auth.test ok' })
    renderWithProviders(<ChannelSetupPanel gateway={makeGateway()} />)

    fireEvent.click(screen.getByRole('button', { name: /Test connection/ }))

    await waitFor(() => {
      expect(screen.getByTestId('test-connection-result')).toHaveTextContent('Connected')
    })
    expect(screen.getByText('auth.test ok')).toBeInTheDocument()
    expect(gatewaysApi.testChannelConnection).toHaveBeenCalledWith('gw-1')
  })

  it('shows a failure badge when the connection test fails', async () => {
    ;(gatewaysApi.testChannelConnection as any).mockResolvedValue({ ok: false, detail: 'invalid_auth' })
    renderWithProviders(<ChannelSetupPanel gateway={makeGateway()} />)

    fireEvent.click(screen.getByRole('button', { name: /Test connection/ }))

    await waitFor(() => {
      expect(screen.getByTestId('test-connection-result')).toHaveTextContent('Failed')
    })
    expect(screen.getByText('invalid_auth')).toBeInTheDocument()
  })
})
