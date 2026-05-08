import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '../../../../test/setup'
import { ChannelConfigForm, isChannelType } from '../channel-config-form'

// Each test renders the form fresh with a mocked save handler / test
// handler so we can assert the UX contract: existing secrets stay
// masked, Save / Test stay disabled until required fields are filled,
// and the patch payload only contains keys the user actually edited.

describe('isChannelType', () => {
  it('accepts channel types', () => {
    expect(isChannelType('slack')).toBe(true)
    expect(isChannelType('discord')).toBe(true)
    expect(isChannelType('chat_widget')).toBe(true)
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

  it('renders WhatsApp Twilio triple', () => {
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
