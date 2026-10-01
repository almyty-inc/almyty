import { describe, it, expect } from 'vitest'

import {
  ADDABLE_CHANNEL_TYPES,
  CHANNEL_INBOUND,
  CHANNEL_LABELS,
  MESSAGING_CHANNEL_TYPES as CHANNEL_TARGETS,
  carriesDisclosure,
  channelCallbackUrl,
  channelConnectorKey,
  webChatAddressError,
  type ChannelType,
} from '../agent-channels'

/**
 * A channel's keys are a credential, so the page asks for nothing but the
 * credential; these are the rules the page still holds itself.
 */
describe('webChatAddressError', () => {
  it('mirrors the backend: 3 to 63 lowercase letters, numbers and inner hyphens, not reserved', () => {
    expect(webChatAddressError('acme-help')).toBeNull()
    expect(webChatAddressError('Acme-Help')).toBeNull()
    expect(webChatAddressError('')).toBe('Pick an address.')
    expect(webChatAddressError('ab')).toBe('Must be at least 3 characters.')
    expect(webChatAddressError('a'.repeat(64))).toBe('Must be 63 characters or fewer.')
    expect(webChatAddressError('-acme')).toBe('Use lowercase letters, numbers and hyphens. It cannot start or end with a hyphen.')
    expect(webChatAddressError('api')).toBe('That address is reserved.')
  })
})

describe('carriesDisclosure', () => {
  it.each(CHANNEL_TARGETS)('%s, a messaging channel, carries the AI disclosure switch', (target) => {
    expect(carriesDisclosure(target)).toBe(true)
  })

  it('is on the web chat and the widget, and not where no person talks', () => {
    expect(carriesDisclosure('web')).toBe(true)
    expect(carriesDisclosure('widget')).toBe(true)
    for (const type of ['a2a', 'tui', 'desktop'] as ChannelType[]) expect(carriesDisclosure(type)).toBe(false)
  })
})

const channel = (type: ChannelType, endpoint = '/channels/c-1') => ({ type, endpoint })

describe('channelCallbackUrl', () => {
  it("is the channel's endpoint on the unified endpoint", () => {
    expect(channelCallbackUrl('https://api.x.com/', 'acme', channel('whatsapp_cloud'))).toBe('https://api.x.com/acme/channels/c-1')
  })


  it('is the shared inbound route for email', () => {
    expect(channelCallbackUrl('https://api.x.com', 'acme', channel('email'))).toBe('https://api.x.com/channels/email/inbound')
  })

  it('is absent where nothing calls back, and each says why', () => {
    for (const type of ['web', 'tui', 'desktop', 'discord'] as const) {
      expect(channelCallbackUrl('https://api.x.com', 'acme', channel(type))).toBeNull()
      expect(CHANNEL_INBOUND[type].why).toBeTruthy()
    }
  })

  it('tells the operator what to do with every URL it shows', () => {
    for (const type of CHANNEL_TARGETS) {
      const inbound = CHANNEL_INBOUND[type]
      if (inbound.mode !== 'none') expect(inbound.where).toBeTruthy()
    }
  })
})

describe('the channels offered', () => {
  it('are the ones the owner listed, in that order, each with a plain name', () => {
    expect(ADDABLE_CHANNEL_TYPES.map((t) => CHANNEL_LABELS[t])).toEqual([
      'Web chat',
      'Website widget',
      'Slack',
      'WhatsApp (Twilio)',
      'WhatsApp (Meta Cloud)',
      'iMessage (Sendblue)',
      'iMessage (LoopMessage)',
      'Microsoft Teams',
      'Telegram',
      'Discord',
      'Google Chat',
      'Signal',
      'Matrix',
      'IRC',
      'Email',
      'SMS',
      'Webhook',
      'Desktop app',
      'Terminal app',
      'Other agents (A2A)',
    ])
  })

  it('file their keys under the same connector the backend tags them with', () => {
    expect(channelConnectorKey('slack')).toBe('channel-slack')
    expect(channelConnectorKey('whatsapp_cloud')).toBe('channel-whatsapp-cloud')
    expect(channelConnectorKey('microsoft_teams')).toBe('channel-microsoft-teams')
    expect(channelConnectorKey('imessage_sendblue')).toBe('channel-imessage-sendblue')
    expect(channelConnectorKey('imessage_loopmessage')).toBe('channel-imessage-loopmessage')
  })
})
