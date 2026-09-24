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

    fireEvent.click(await screen.findByRole('button', { name: /Deploy channel/ }))
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
    await user.click(await screen.findByRole('button', { name: /Deploy channel/ }))
    await user.click(screen.getByRole('combobox'))
    // Inside a <form> Radix also renders a hidden native <select>, so pick
    // the listbox option by role rather than by text.
    await user.click(await screen.findByRole('option', { name: 'Slack' }))
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
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(gatewaysApi.update).toHaveBeenCalledTimes(1))
    // Same rule as the gateway-side form: credentialId goes to null and the
    // server-owned credentialKeys list is never round-tripped.
    expect(gatewaysApi.update).toHaveBeenCalledWith('gw-1', {
      configuration: { bot_token: '********', credentialId: null },
    })
  })
})

describe('InterfacesTab channel list states', () => {
  beforeEach(() => vi.clearAllMocks())

  // Rendering the empty state over a failed read told the operator this agent
  // has no channels. Acting on that means deploying a second gateway on top of
  // one that is already live.
  it('shows the retryable error state, not the empty state, when the gateway list fails', async () => {
    ;(gatewaysApi.getAll as any).mockRejectedValue(new Error('boom'))
    renderWithProviders(<InterfacesTab agentId="agent-1" interfaces={[]} />)

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load this agent's channels")
    expect(screen.queryByText(/No channels deployed yet/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument()
  })

  it('offers a deploy action from the empty state', async () => {
    ;(gatewaysApi.getAll as any).mockResolvedValue({ gateways: [] })
    renderWithProviders(<InterfacesTab agentId="agent-1" interfaces={[]} />)

    fireEvent.click(await screen.findByRole('button', { name: /^List$/ }))
    expect(await screen.findByText('No channels deployed yet')).toBeInTheDocument()
    // The header and the empty state offer it under the same label.
    expect(screen.getAllByRole('button', { name: /Deploy channel/ })).toHaveLength(2)
  })
})

// Deploying a channel and reading its setup used to happen in two modal
// dialogs. Both are inline sections of the tab now: no dialog role, the
// rest of the tab stays in view, and Cancel/close put the tab back.
describe('InterfacesTab inline sections', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    connectionsListMock.mockResolvedValue([])
  })

  it('opens the deploy form inline, not in a dialog, and Cancel closes it without deploying', async () => {
    const user = userEvent.setup()
    ;(gatewaysApi.getAll as any).mockResolvedValue({ gateways: [] })
    renderWithProviders(<InterfacesTab agentId="agent-1" />)

    await user.click(await screen.findByRole('button', { name: /Deploy channel/ }))
    const form = await screen.findByTestId('deploy-channel-form')
    expect(form.tagName).toBe('FORM')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // The header action hides while its form is open; the view toggle stays.
    expect(screen.queryByRole('button', { name: /Deploy channel/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^List$/ })).toBeInTheDocument()

    await user.type(within(form).getByLabelText('Name'), 'Half typed')
    await user.click(within(form).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByTestId('deploy-channel-form')).not.toBeInTheDocument()
    expect(gatewaysApi.create).not.toHaveBeenCalled()
    // Reopening starts clean.
    await user.click(screen.getByRole('button', { name: /Deploy channel/ }))
    expect(within(await screen.findByTestId('deploy-channel-form')).getByLabelText('Name')).toHaveValue('')
  })

  it('submits the deploy form with Enter in the name field', async () => {
    const user = userEvent.setup()
    ;(gatewaysApi.getAll as any).mockResolvedValue({ gateways: [] })
    ;(gatewaysApi.create as any).mockResolvedValue({ id: 'gw-3', name: 'Ops', type: 'a2a', endpoint: '/ops' })
    renderWithProviders(<InterfacesTab agentId="agent-1" />)

    await user.click(await screen.findByRole('button', { name: /Deploy channel/ }))
    await user.type(screen.getByLabelText('Name'), 'Ops{Enter}')

    await waitFor(() => expect(gatewaysApi.create).toHaveBeenCalledTimes(1))
    expect((gatewaysApi.create as any).mock.calls[0][0]).toMatchObject({ name: 'Ops', endpoint: '/ops', type: 'a2a' })
    expect(await screen.findByTestId('channel-setup-section')).toBeInTheDocument()
    expect(screen.queryByTestId('deploy-channel-form')).not.toBeInTheDocument()
  })

  it('keeps the Slack OAuth client secret out of password managers', async () => {
    const user = userEvent.setup()
    ;(gatewaysApi.getAll as any).mockResolvedValue({ gateways: [] })
    renderWithProviders(<InterfacesTab agentId="agent-1" />)

    await user.click(await screen.findByRole('button', { name: /Deploy channel/ }))
    await user.click(screen.getByRole('combobox'))
    await user.click(await screen.findByRole('option', { name: 'Slack' }))

    const secret = await screen.findByLabelText('OAuth client secret')
    expect(secret).toHaveAttribute('type', 'password')
    expect(secret).toHaveAttribute('data-1p-ignore', 'true')
    expect(secret).toHaveAttribute('autocomplete', 'off')
  })

  it('shows channel setup inline and closes it', async () => {
    const user = userEvent.setup()
    ;(gatewaysApi.getAll as any).mockResolvedValue({ gateways: [slackGateway] })
    renderWithProviders(<InterfacesTab agentId="agent-1" />)

    await user.click(await screen.findByRole('button', { name: /^List$/ }))
    await user.click(await screen.findByRole('button', { name: /Setup/ }))

    const section = await screen.findByTestId('channel-setup-section')
    expect(section.tagName).toBe('SECTION')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(section).toHaveTextContent('Finish connecting Support Bot')
    // The channel cards stay on screen next to it.
    expect(screen.getByText('Support Bot')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Close channel setup' }))
    expect(screen.queryByTestId('channel-setup-section')).not.toBeInTheDocument()
  })
})