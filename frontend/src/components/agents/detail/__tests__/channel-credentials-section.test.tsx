import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useState } from 'react'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '../../../../test/setup'
import {
  ChannelBackingConnection,
  ChannelCredentialsSection,
  backingConnectionId,
  buildChannelConnectionPatch,
  buildDeployChannelConfig,
  channelDeployFields,
} from '../channel-credentials-section'
import type { Connection, Connector } from '@/types/connections'

const connectorsListMock = vi.fn().mockResolvedValue([])
const connectionsListMock = vi.fn().mockResolvedValue([])
const connectMock = vi.fn()

vi.mock('@/lib/connections-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/connections-api')>('@/lib/connections-api')
  return {
    ...actual,
    connectorsApi: { list: (...args: any[]) => connectorsListMock(...args), create: vi.fn() },
    connectionsApi: {
      list: (...args: any[]) => connectionsListMock(...args),
      connect: (...args: any[]) => connectMock(...args),
      get: vi.fn(),
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

vi.mock('@/lib/api', () => ({
  organizationsApi: { getById: vi.fn().mockResolvedValue({ id: 'org-1', plan: 'free', settings: {} }) },
}))

vi.mock('@/store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org-1', name: 'Acme' } }),
}))

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
const otherSlackConnection: Connection = {
  ...slackConnection,
  id: 'conn-slack-2',
  name: 'Support Slack bot',
}
const webhookConnection: Connection = {
  id: 'conn-hook',
  name: 'Ops webhook',
  connectorKey: 'channel-webhook',
  kind: 'channel',
  owner: 'org',
  health: { status: 'unknown' },
  createdAt: '2026-01-01T00:00:00.000Z',
}
const inferenceConnection: Connection = {
  id: 'conn-openai',
  name: 'OpenAI',
  connectorKey: 'openai',
  kind: 'inference',
  owner: 'org',
  health: { status: 'valid' },
  createdAt: '2026-01-01T00:00:00.000Z',
}

const telegramConnector: Connector = {
  key: 'channel-telegram',
  kind: 'channel',
  displayName: 'Telegram',
  connect: [
    {
      type: 'api_key',
      label: 'Bot token',
      schema: {
        type: 'object',
        properties: { botToken: { type: 'string', title: 'Telegram bot token', 'x-secret': true } },
        required: ['botToken'],
      },
    },
  ],
}

const telegramConnection: Connection = {
  id: 'conn-telegram',
  name: 'Almyty bot',
  connectorKey: 'channel-telegram',
  connectorDisplayName: 'Telegram',
  kind: 'channel',
  owner: 'org',
  health: { status: 'valid' },
  createdAt: '2026-01-01T00:00:00.000Z',
}

/** The deploy dialog's state, so the section can be driven as it really is. */
function Harness({
  type,
  initialConfig = {},
  connections,
  onConfig,
  onConnection,
}: {
  type: string
  initialConfig?: Record<string, any>
  connections?: Connection[]
  onConfig?: (config: Record<string, any>) => void
  onConnection?: (connection: Connection | null) => void
}) {
  const [config, setConfig] = useState<Record<string, any>>(initialConfig)
  const [connection, setConnection] = useState<Connection | null>(null)
  return (
    <div>
      <ChannelCredentialsSection
        type={type}
        config={config}
        onConfigChange={(next) => {
          setConfig(next)
          onConfig?.(next)
        }}
        connection={connection}
        onConnectionChange={(next) => {
          setConnection(next)
          onConnection?.(next)
        }}
        connections={connections}
      />
      <button
        type="button"
        onClick={() => onConfig?.(buildDeployChannelConfig({ type, config, connection }))}
      >
        Deploy
      </button>
    </div>
  )
}

beforeEach(() => {
  connectorsListMock.mockResolvedValue([])
  connectionsListMock.mockResolvedValue([])
  connectMock.mockReset()
})

describe('channelDeployFields', () => {
  it('asks for the adapter keys of a channel', () => {
    expect(channelDeployFields('slack').map((f) => f.key)).toEqual(['bot_token', 'signing_secret'])
    expect(channelDeployFields('email').map((f) => f.key)).toEqual(['resend_api_key', 'reply_from'])
  })

  it('leaves out the inbound webhook URL that only exists after the deploy', () => {
    expect(channelDeployFields('whatsapp').map((f) => f.key)).toEqual([
      'twilio_account_sid',
      'twilio_auth_token',
      'phone_number',
    ])
  })

  it('has nothing to ask for the widget or a protocol surface', () => {
    expect(channelDeployFields('chat_widget')).toEqual([])
    expect(channelDeployFields('a2a')).toEqual([])
  })
})

describe('buildDeployChannelConfig', () => {
  it('posts the pasted values unchanged when no connection is picked', () => {
    expect(
      buildDeployChannelConfig({
        type: 'slack',
        config: { bot_token: 'xoxb-abc', signing_secret: 'shh', client_id: 'A1' },
      }),
    ).toEqual({ bot_token: 'xoxb-abc', signing_secret: 'shh', client_id: 'A1' })
  })

  it('posts credentialId and drops every secret key when a connection is picked', () => {
    expect(
      buildDeployChannelConfig({
        type: 'whatsapp',
        config: { twilio_account_sid: 'AC1', twilio_auth_token: 'typed-anyway', phone_number: '+15551234567' },
        connection: slackConnection,
      }),
    ).toEqual({ twilio_account_sid: 'AC1', phone_number: '+15551234567', credentialId: 'conn-slack' })
  })

  it('never round-trips a server-owned credentialKeys list', () => {
    const config = buildDeployChannelConfig({
      type: 'slack',
      config: { credentialKeys: ['bot_token'], credentialId: 'stale' },
      connection: slackConnection,
    })
    expect(config).toEqual({ credentialId: 'conn-slack' })
  })
})

describe('buildChannelConnectionPatch', () => {
  it('swaps the connection and clears the keys the old one held', () => {
    expect(
      buildChannelConnectionPatch({
        type: 'slack',
        configuration: { credentialId: 'conn-old', credentialKeys: ['bot_token'], bot_token: '********', client_id: 'A1' },
        connection: otherSlackConnection,
      }),
    ).toEqual({ client_id: 'A1', credentialId: 'conn-slack-2' })
  })

  it('sends credentialId null to disconnect', () => {
    const patch = buildChannelConnectionPatch({
      type: 'slack',
      configuration: { credentialId: 'conn-slack', credentialKeys: ['bot_token'] },
      connection: null,
    })
    expect(patch).toEqual({ credentialId: null })
  })
})

describe('backingConnectionId', () => {
  it('reads the connection backing a deployed channel', () => {
    expect(backingConnectionId({ credentialId: 'conn-slack' })).toBe('conn-slack')
    expect(backingConnectionId({ credentialId: '' })).toBeNull()
    expect(backingConnectionId(null)).toBeNull()
  })
})

describe('ChannelCredentialsSection', () => {
  it('lists the channel connections of the adapter first', () => {
    render(<Harness type="slack" connections={[slackConnection, webhookConnection, inferenceConnection]} />)
    const select = screen.getByLabelText('Use an existing connection') as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'conn-slack'])
  })

  it('picking a connection hides every secret field and keeps the plain ones', async () => {
    const user = userEvent.setup()
    const onConfig = vi.fn()
    render(
      <Harness
        type="whatsapp"
        initialConfig={{ twilio_account_sid: 'AC1', twilio_auth_token: '', phone_number: '' }}
        connections={[slackConnection]}
        onConfig={onConfig}
      />,
    )

    await user.type(screen.getByLabelText(/From phone number/i), '+15551234567')
    await user.selectOptions(screen.getByLabelText('Use an existing connection'), 'conn-slack')

    expect(screen.getByTestId('connected-chip')).toHaveTextContent('Acme Slack bot')
    expect(screen.queryByLabelText(/Twilio auth token/i)).not.toBeInTheDocument()
    expect(screen.getByLabelText(/Twilio Account SID/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/From phone number/i)).toHaveValue('+15551234567')

    onConfig.mockClear()
    await user.click(screen.getByRole('button', { name: 'Deploy' }))
    expect(onConfig).toHaveBeenCalledWith({
      twilio_account_sid: 'AC1',
      phone_number: '+15551234567',
      credentialId: 'conn-slack',
    })
  })

  it('keeps the paste path working when no connection is picked', async () => {
    const user = userEvent.setup()
    const onConfig = vi.fn()
    render(<Harness type="telegram" initialConfig={{ bot_token: '' }} onConfig={onConfig} />)

    await user.type(screen.getByLabelText(/Bot token/i), '123456:ABC')
    onConfig.mockClear()
    await user.click(screen.getByRole('button', { name: 'Deploy' }))
    expect(onConfig).toHaveBeenCalledWith({ bot_token: '123456:ABC' })
  })

  it('opens the connect sheet on the channel connector and selects what comes back', async () => {
    const user = userEvent.setup()
    connectorsListMock.mockResolvedValue([telegramConnector])
    connectMock.mockResolvedValue({ pending: false, connection: telegramConnection })
    const onConnection = vi.fn()
    render(<Harness type="telegram" initialConfig={{ bot_token: '' }} connections={[]} onConnection={onConnection} />)

    await user.click(screen.getByRole('button', { name: /Connect an account/i }))
    expect(await screen.findByText('Connect Telegram')).toBeInTheDocument()

    await user.type(await screen.findByLabelText('Telegram bot token'), '123456:ABC')
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(onConnection).toHaveBeenCalledWith(telegramConnection))
    expect(connectMock).toHaveBeenCalledWith('channel-telegram', expect.objectContaining({ method: 'api_key' }))
    expect(await screen.findByTestId('connected-chip')).toHaveTextContent('Almyty bot')
    expect(screen.queryByLabelText(/^Bot token/i)).not.toBeInTheDocument()
  })

  it('renders nothing for a surface with no credentials', () => {
    const { container } = render(<Harness type="chat_widget" />)
    expect(container.querySelector('[data-testid="channel-credentials-chat_widget"]')).toBeNull()
  })
})

describe('ChannelBackingConnection', () => {
  it('names the connection, its connector and its health, and disconnects', async () => {
    const user = userEvent.setup()
    const onDisconnect = vi.fn()
    render(
      <ChannelBackingConnection
        type="slack"
        configuration={{ credentialId: 'conn-slack', credentialKeys: ['bot_token'] }}
        onSwap={vi.fn()}
        onDisconnect={onDisconnect}
        connections={[slackConnection]}
      />,
    )
    const backing = screen.getByTestId('channel-backing-connection')
    expect(backing).toHaveTextContent('Acme Slack bot')
    expect(backing).toHaveTextContent('Slack')
    expect(within(backing).getByTestId('connection-health')).toHaveAttribute('data-status', 'valid')

    await user.click(screen.getByRole('button', { name: 'Disconnect' }))
    expect(onDisconnect).toHaveBeenCalledTimes(1)
  })

  it('swaps to another connection', async () => {
    const user = userEvent.setup()
    const onSwap = vi.fn()
    render(
      <ChannelBackingConnection
        type="slack"
        configuration={{ credentialId: 'conn-slack' }}
        onSwap={onSwap}
        onDisconnect={vi.fn()}
        connections={[slackConnection, otherSlackConnection]}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Swap' }))
    await user.selectOptions(screen.getByLabelText('Use another connection'), 'conn-slack-2')
    expect(onSwap).toHaveBeenCalledWith(otherSlackConnection)
  })

  it('renders nothing when no connection backs the channel', () => {
    const { container } = render(
      <ChannelBackingConnection type="slack" configuration={{ bot_token: '****' }} onSwap={vi.fn()} onDisconnect={vi.fn()} connections={[]} />,
    )
    expect(container.querySelector('[data-testid="channel-backing-connection"]')).toBeNull()
  })
})
