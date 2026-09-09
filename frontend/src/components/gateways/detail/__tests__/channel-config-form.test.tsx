import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '../../../../test/setup'
import { ChannelConfigForm, buildChannelConfigPatch, channelConnectorKey, isChannelType } from '../channel-config-form'
import type { Connection } from '@/types/connections'

// The form lists the org's channel connections; the API is mocked so the
// existing tests (no connections) and the connection tests share one shape.
const listMock = vi.fn().mockResolvedValue([])
vi.mock('@/lib/connections-api', () => ({
  connectionsApi: { list: (...args: any[]) => listMock(...args) },
}))

const slackConnection: Connection = {
  id: 'conn-slack', name: 'Acme Slack bot', connectorKey: 'channel-slack', kind: 'channel', owner: 'org', health: { status: 'valid' }, createdAt: '2026-01-01T00:00:00.000Z',
}
const webhookConnection: Connection = {
  id: 'conn-hook', name: 'Ops webhook', connectorKey: 'channel-webhook', kind: 'channel', owner: 'org', health: { status: 'unknown' }, createdAt: '2026-01-01T00:00:00.000Z',
}
const inferenceConnection: Connection = {
  id: 'conn-openai', name: 'OpenAI', connectorKey: 'openai', kind: 'inference', owner: 'org', health: { status: 'valid' }, createdAt: '2026-01-01T00:00:00.000Z',
}

// Each test renders the form fresh with a mocked save handler / test
// handler so we can assert the UX contract: existing secrets stay
// masked, Save / Test stay disabled until required fields are filled,
// and the patch payload only contains keys the user actually edited.

describe('isChannelType', () => {
  it('accepts channel types', () => {
    expect(isChannelType('slack')).toBe(true)
    expect(isChannelType('discord')).toBe(true)
    expect(isChannelType('chat_widget')).toBe(true)
    expect(isChannelType('sms')).toBe(true)
    expect(isChannelType('whatsapp_cloud')).toBe(true)
  })

  it('rejects non-channel gateway types', () => {
    expect(isChannelType('mcp')).toBe(false)
    expect(isChannelType('a2a')).toBe(false)
    expect(isChannelType('utcp')).toBe(false)
    expect(isChannelType('skills')).toBe(false)
    expect(isChannelType('openai_chat')).toBe(false)
    expect(isChannelType(undefined)).toBe(false)
    expect(isChannelType(null)).toBe(false)
  })
})

describe('ChannelConfigForm', () => {
  const baseGateway = { id: 'gw-1', type: 'slack', configuration: {} }

  it('renders Slack fields and disables Save until required filled', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    const onTestConnection = vi
      .fn()
      .mockResolvedValue({ ok: true, detail: 'auth ok' })

    render(
      <ChannelConfigForm
        gateway={baseGateway}
        type="slack"
        onSave={onSave}
        onTestConnection={onTestConnection}
      />,
    )

    // Bot token is required, signing_secret is optional.
    expect(screen.getByLabelText(/Bot token/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Signing secret/i)).toBeInTheDocument()

    const saveBtn = screen.getByRole('button', { name: /^Save$/ })
    const testBtn = screen.getByRole('button', { name: /Test connection/i })
    expect(saveBtn).toBeDisabled()
    expect(testBtn).toBeDisabled()

    await user.type(screen.getByLabelText(/Bot token/i), 'xoxb-abc')
    expect(saveBtn).not.toBeDisabled()
    expect(testBtn).not.toBeDisabled()
  })

  it('only sends edited keys in the save payload (existing token stays masked)', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    const onTestConnection = vi.fn().mockResolvedValue({ ok: true, detail: '' })

    const gateway = {
      id: 'gw-2',
      type: 'slack',
      configuration: { bot_token: 'xoxb-already-set', signing_secret: 'secret' },
    }
    render(
      <ChannelConfigForm
        gateway={gateway}
        type="slack"
        onSave={onSave}
        onTestConnection={onTestConnection}
      />,
    )

    // Existing values: masked placeholder + Edit button, NOT plaintext.
    const masked = screen.getAllByDisplayValue('••••••••')
    expect(masked.length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByDisplayValue('xoxb-already-set')).toBeNull()

    // Edit signing_secret only — bot_token stays untouched.
    const editButtons = screen.getAllByRole('button', { name: 'Edit' })
    // Slack has 2 secret fields. Click the second (signing_secret).
    await user.click(editButtons[1])
    const sigInput = screen.getByLabelText(/Signing secret/i)
    await user.clear(sigInput)
    await user.type(sigInput, 'new-signing-secret')

    await user.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))

    const payload = onSave.mock.calls[0][0]
    // bot_token stayed at the existing value; signing_secret got replaced.
    expect(payload.bot_token).toBe('xoxb-already-set')
    expect(payload.signing_secret).toBe('new-signing-secret')
  })

  it('runs test-connection and renders the result inline', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    const onTestConnection = vi
      .fn()
      .mockResolvedValue({ ok: false, detail: 'invalid_auth' })

    const gateway = {
      id: 'gw-3',
      type: 'discord',
      configuration: { bot_token: 'mtok' },
    }
    render(
      <ChannelConfigForm
        gateway={gateway}
        type="discord"
        onSave={onSave}
        onTestConnection={onTestConnection}
      />,
    )

    await user.click(screen.getByRole('button', { name: /Test connection/i }))
    await waitFor(() => {
      expect(onTestConnection).toHaveBeenCalled()
      expect(screen.getByText(/Connection failed/i)).toBeInTheDocument()
      expect(screen.getByText(/invalid_auth/)).toBeInTheDocument()
    })
  })

  it('renders WhatsApp Twilio triple plus the URL that turns signature checks on', () => {
    render(
      <ChannelConfigForm
        gateway={{ id: 'gw-4', type: 'whatsapp', configuration: {} }}
        type="whatsapp"
        onSave={vi.fn()}
        onTestConnection={vi.fn()}
      />,
    )
    expect(screen.getByLabelText(/Twilio Account SID/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Twilio auth token/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/From phone number/i)).toBeInTheDocument()
    // Twilio signs the exact URL it calls, so without webhook_url the
    // adapter skips verification entirely. The field has to be here or
    // the only way to get a verified WhatsApp channel is auto-registration.
    expect(screen.getByLabelText(/Inbound webhook URL/i)).toBeInTheDocument()
  })

  it('renders SMS fields', () => {
    render(
      <ChannelConfigForm
        gateway={{ id: 'gw-6', type: 'sms', configuration: {} }}
        type="sms"
        onSave={vi.fn()}
        onTestConnection={vi.fn()}
      />,
    )
    expect(screen.getByLabelText(/Twilio Account SID/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/From phone number/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Inbound webhook URL/i)).toBeInTheDocument()
  })

  it('renders WhatsApp Cloud (Meta) fields', () => {
    render(
      <ChannelConfigForm
        gateway={{ id: 'gw-7', type: 'whatsapp_cloud', configuration: {} }}
        type="whatsapp_cloud"
        onSave={vi.fn()}
        onTestConnection={vi.fn()}
      />,
    )
    expect(screen.getByLabelText(/Access token/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Phone number ID/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Verify token/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/App secret/i)).toBeInTheDocument()
  })

  it('renders no fields for chat_widget', () => {
    render(
      <ChannelConfigForm
        gateway={{ id: 'gw-5', type: 'chat_widget', configuration: {} }}
        type="chat_widget"
        onSave={vi.fn()}
        onTestConnection={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: /^Save$/ })).toBeNull()
    expect(screen.getByText(/no extra credentials/i)).toBeInTheDocument()
  })
})

describe('buildChannelConfigPatch', () => {
  const fields = [
    { key: 'bot_token', secret: true },
    { key: 'signing_secret', secret: true },
    { key: 'webhook_url' },
  ]

  it('applies typed edits and drops a key cleared to empty', () => {
    const patch = buildChannelConfigPatch({ existing: { bot_token: '********', webhook_url: 'https://a' }, fields, edits: { bot_token: 'xoxb-new', webhook_url: '' } })
    expect(patch).toEqual({ bot_token: 'xoxb-new' })
  })

  it('replaces every secret key with credentialId when a connection is picked', () => {
    const patch = buildChannelConfigPatch({
      existing: { bot_token: '********', signing_secret: '********', credentialKeys: ['bot_token', 'signing_secret', 'client_secret'], client_secret: '********', webhook_url: 'https://a', credentialId: 'conn-old' },
      fields,
      edits: { bot_token: 'typed-anyway', webhook_url: 'https://b' },
      connection: slackConnection,
    })
    expect(patch).toEqual({ webhook_url: 'https://b', credentialId: 'conn-slack' })
  })

  it('sends credentialId null to clear the backing connection and never round-trips credentialKeys', () => {
    const patch = buildChannelConfigPatch({ existing: { credentialId: 'conn-old', credentialKeys: ['bot_token'], bot_token: '********' }, fields, edits: {}, clearConnection: true })
    expect(patch).toEqual({ bot_token: '********', credentialId: null })
  })

  it('names the managed connector of an adapter', () => {
    expect(channelConnectorKey('slack')).toBe('channel-slack')
  })
})

describe('ChannelConfigForm connections', () => {
  const onTestConnection = vi.fn().mockResolvedValue({ ok: true, detail: 'ok' })

  it('lists channel connections of the adapter first, hides the secret fields and sends credentialId', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(
      <ChannelConfigForm
        gateway={{ id: 'gw-10', type: 'slack', configuration: {} }}
        type="slack"
        onSave={onSave}
        onTestConnection={onTestConnection}
        connections={[slackConnection, webhookConnection, inferenceConnection]}
      />,
    )
    const select = screen.getByLabelText('Use an existing connection') as HTMLSelectElement
    // The slack connector has a connection, so the webhook and inference rows stay out.
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'conn-slack'])
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeDisabled()

    await user.selectOptions(select, 'conn-slack')
    expect(screen.getByTestId('connected-chip')).toHaveTextContent('Acme Slack bot')
    // Secret inputs are gone; the required bot token is satisfied by the connection.
    expect(screen.queryByLabelText(/Bot token/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/Signing secret/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Save$/ })).not.toBeDisabled()

    await user.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0]).toEqual({ credentialId: 'conn-slack' })
  })

  it('falls back to every channel connection when the adapter has none of its own', () => {
    render(
      <ChannelConfigForm
        gateway={{ id: 'gw-11', type: 'discord', configuration: {} }}
        type="discord"
        onSave={vi.fn()}
        onTestConnection={onTestConnection}
        connections={[slackConnection, webhookConnection, inferenceConnection]}
      />,
    )
    const select = screen.getByLabelText('Use an existing connection') as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'conn-slack', 'conn-hook'])
  })

  it('shows the backing connection with its health, and Disconnect sends credentialId null', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(
      <ChannelConfigForm
        gateway={{ id: 'gw-12', type: 'slack', configuration: { credentialId: 'conn-slack', credentialKeys: ['bot_token'], bot_token: '********' } }}
        type="slack"
        onSave={onSave}
        onTestConnection={onTestConnection}
        connections={[slackConnection]}
      />,
    )
    const backing = screen.getByTestId('channel-backing-connection')
    expect(backing).toHaveTextContent('Acme Slack bot')
    expect(within(backing).getByTestId('connection-health')).toHaveAttribute('data-status', 'valid')
    // The masked token counts as an existing value: Save waits for a change.
    expect(screen.getByDisplayValue('••••••••')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Disconnect' }))
    expect(screen.getByTestId('channel-connection-cleared')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const payload = onSave.mock.calls[0][0]
    expect(payload.credentialId).toBeNull()
    expect(payload).not.toHaveProperty('credentialKeys')
  })

  it('fetches the connections when none are passed in', async () => {
    listMock.mockResolvedValueOnce([webhookConnection])
    render(
      <ChannelConfigForm
        gateway={{ id: 'gw-13', type: 'webhook', configuration: {} }}
        type="webhook"
        onSave={vi.fn()}
        onTestConnection={onTestConnection}
      />,
    )
    const select = screen.getByLabelText('Use an existing connection') as HTMLSelectElement
    await waitFor(() => expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'conn-hook']))
  })
})
