import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from '../../../../test/setup'
import { InterfacesTab } from '../interfaces-tab'
import { gatewaysApi } from '@/lib/api'
import type { Connection } from '@/types/connections'

const copyMock = vi.fn()
const connectionsListMock = vi.fn().mockResolvedValue([])

vi.mock('@/lib/api', () => ({
  gatewaysApi: {
    getAll: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    testChannelConnection: vi.fn(),
  },
  organizationsApi: { getById: vi.fn().mockResolvedValue({ id: 'org-1', plan: 'free', settings: {} }) },
  getApiBaseUrl: () => 'https://api.example.com',
}))

vi.mock('@/lib/connections-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/connections-api')>('@/lib/connections-api')
  return {
    ...actual,
    connectorsApi: { list: vi.fn().mockResolvedValue([]), create: vi.fn() },
    connectionsApi: {
      list: (...args: any[]) => connectionsListMock(...args),
      get: vi.fn(),
      connect: vi.fn(),
      complete: vi.fn(),
      validate: vi.fn(),
      rotate: vi.fn(),
      remove: vi.fn(),
      listGrants: vi.fn(),
      addGrant: vi.fn(),
      removeGrant: vi.fn(),
    },
  }
})

vi.mock('@/lib/clipboard', () => ({
  useCopy: () => copyMock,
}))

vi.mock('@/store/organization', () => ({
  useOrganizationStore: () => ({
    currentOrganization: { id: 'org-1', name: 'Acme Corp', slug: 'acme' },
  }),
}))

// Radix Select needs these in jsdom to open its listbox.
beforeEach(() => {
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
  if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = vi.fn()
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = vi.fn()
})

const slackConnection: Connection = {
  id: 'conn-slack',
  name: 'Acme Slack bot',
  connectorKey: 'channel-slack',
  connectorDisplayName: 'Slack',
  kind: 'channel',
  owner: 'org',
  health: { status: 'valid' },
  createdAt: '2026-01-01T00:00:00.000Z',
}

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

    // The canvas is the default view now; the cards live behind List.
    fireEvent.click(await screen.findByRole('button', { name: /^List$/ }))
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

describe('InterfacesTab channel connections', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    connectionsListMock.mockResolvedValue([slackConnection])
  })

  async function openSlackDeployForm() {
    const user = userEvent.setup()
    renderWithProviders(<InterfacesTab agentId="agent-1" />)
    await user.click(await screen.findByRole('button', { name: /Deploy Channel/ }))
    await user.click(screen.getByRole('combobox'))
    await user.click(await screen.findByText('Slack'))
    return user
  }

  it('deploys with the picked connection and no pasted secret', async () => {
    ;(gatewaysApi.getAll as any).mockResolvedValue({ gateways: [] })
    ;(gatewaysApi.create as any).mockResolvedValue({ id: 'gw-9', name: 'slack gateway', type: 'slack', endpoint: '/slack' })

    const user = await openSlackDeployForm()
    const select = (await screen.findByLabelText('Use an existing connection')) as HTMLSelectElement
    await waitFor(() => expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'conn-slack']))
    await user.selectOptions(select, 'conn-slack')

    // The secret inputs are gone once a connection stands in for them.
    expect(screen.queryByLabelText(/^Bot token/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/^Signing secret/i)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^Deploy$/ }))
    await waitFor(() => expect(gatewaysApi.create).toHaveBeenCalledTimes(1))
    const body = (gatewaysApi.create as any).mock.calls[0][0]
    expect(body.configuration).toEqual({ credentialId: 'conn-slack' })
    expect(body.configuration).not.toHaveProperty('bot_token')
    expect(body.configuration).not.toHaveProperty('signing_secret')
  })

  it('still deploys a pasted token when no connection is picked', async () => {
    ;(gatewaysApi.getAll as any).mockResolvedValue({ gateways: [] })
    ;(gatewaysApi.create as any).mockResolvedValue({ id: 'gw-9', name: 'slack gateway', type: 'slack', endpoint: '/slack' })

    const user = await openSlackDeployForm()
    await user.type(await screen.findByLabelText(/^Bot token/i), 'xoxb-typed')
    await user.click(screen.getByRole('button', { name: /^Deploy$/ }))

    await waitFor(() => expect(gatewaysApi.create).toHaveBeenCalledTimes(1))
    const body = (gatewaysApi.create as any).mock.calls[0][0]
    expect(body.configuration.bot_token).toBe('xoxb-typed')
    expect(body.configuration).not.toHaveProperty('credentialId')
  })

  it('shows the backing connection on a deployed channel and disconnects it', async () => {
    const user = userEvent.setup()
    ;(gatewaysApi.getAll as any).mockResolvedValue({
      gateways: [
        {
          ...slackGateway,
          configuration: { credentialId: 'conn-slack', credentialKeys: ['bot_token'], bot_token: '********' },
        },
      ],
    })
    ;(gatewaysApi.update as any).mockResolvedValue({ id: 'gw-1' })

    renderWithProviders(<InterfacesTab agentId="agent-1" />)
    await user.click(await screen.findByRole('button', { name: /^List$/ }))

    const backing = await screen.findByTestId('channel-backing-connection')
    expect(backing).toHaveTextContent('Acme Slack bot')
    expect(within(backing).getByTestId('connection-health')).toHaveAttribute('data-status', 'valid')
    // The masked token row is replaced by the account, not shown next to it.
    expect(screen.queryByText('Bot Token')).not.toBeInTheDocument()

    await user.click(within(backing).getByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(gatewaysApi.update).toHaveBeenCalledTimes(1))
    // Same rule as the gateway-side form: credentialId goes to null and the
    // server-owned credentialKeys list is never round-tripped.
    expect(gatewaysApi.update).toHaveBeenCalledWith('gw-1', {
      configuration: { bot_token: '********', credentialId: null },
    })
  })
})
