import { describe, it, expect } from 'vitest'

import {
  ADDABLE_CHANNEL_TYPES,
  CHANNEL_CREDENTIAL_FIELDS,
  CHANNEL_INBOUND,
  CHANNEL_LABELS,
  CREDENTIAL_ALTERNATIVES,
  MESSAGING_CHANNEL_TYPES as CHANNEL_TARGETS,
  channelCallbackUrl,
  channelConnectorKey,
  missingChannelFields,
  type ChannelType,
} from '../agent-channels'

/**
 * Mirrors REQUIRED_CREDENTIALS in backend channel-publish.ts. A required
 * field missing here is a channel the backend will refuse to publish with
 * no field on the page to fix it.
 */
const BACKEND_REQUIRED: Record<string, string[]> = {
  slack: ['bot_token', 'signing_secret'],
  discord: ['bot_token'],
  telegram: ['bot_token'],
  whatsapp: ['twilio_account_sid', 'twilio_auth_token', 'phone_number'],
  whatsapp_cloud: ['access_token', 'phone_number_id', 'app_secret', 'verify_token'],
  sms: ['twilio_account_sid', 'twilio_auth_token', 'phone_number'],
  email: ['resend_api_key', 'inbound_address', 'reply_from'],
  webhook: ['callback_url', 'secret'],
  google_chat: ['webhook_url', 'verification_token'],
  microsoft_teams: ['bot_id', 'bot_password', 'service_url'],
  signal: ['api_url', 'phone_number'],
  matrix: ['homeserver_url', 'access_token', 'room_id'],
  irc: ['webhook_url', 'bridge_token', 'nick', 'channel'],
}

describe('channel settings', () => {
  it.each(CHANNEL_TARGETS)('%s asks for exactly what the backend requires', (target) => {
    // A field an alternative can stand in for (Slack's bot token) is still
    // one the backend requires; it is just not the only way to meet it.
    const replaceable = CREDENTIAL_ALTERNATIVES[target]?.instead ?? []
    const required = (CHANNEL_CREDENTIAL_FIELDS[target] ?? [])
      .filter((f) => f.required || replaceable.includes(f.key))
      .map((f) => f.key)
    expect(required.sort()).toEqual([...BACKEND_REQUIRED[target]].sort())
  })

  it('leads Slack with Add to Slack and keeps the bot token under Advanced', () => {
    const slack = CHANNEL_CREDENTIAL_FIELDS.slack ?? []
    expect(slack.map((f) => f.key)).toEqual(['client_id', 'client_secret', 'signing_secret', 'bot_token'])
    expect(slack.filter((f) => f.advanced).map((f) => f.key)).toEqual(['bot_token'])
  })

  it('counts the Slack app credentials in place of a bot token, as the backend does', () => {
    const has = (keys: string[]) => (key: string) => keys.includes(key)
    expect(missingChannelFields('slack', has(['client_id', 'client_secret', 'signing_secret']))).toEqual([])
    expect(missingChannelFields('slack', has(['signing_secret', 'bot_token']))).toEqual([])
    expect(missingChannelFields('slack', has(['client_id', 'signing_secret']))).toEqual(['bot_token'])
    expect(missingChannelFields('discord', has(['client_id', 'client_secret']))).toEqual(['bot_token'])
  })

  it.each(CHANNEL_TARGETS)('%s says where to find every value', (target) => {
    for (const field of CHANNEL_CREDENTIAL_FIELDS[target] ?? []) {
      expect(field.hint.length).toBeGreaterThan(10)
      // A human label, not the config key.
      expect(field.label).not.toMatch(/_/)
    }
  })
})

const channel = (type: ChannelType, endpoint = '/channels/c-1') => ({ type, endpoint })

describe('channelCallbackUrl', () => {
  it("is the channel's endpoint on the unified endpoint", () => {
    expect(channelCallbackUrl('https://api.x.com/', 'acme', channel('whatsapp_cloud'))).toBe('https://api.x.com/acme/channels/c-1')
  })

  it('keeps the address a channel moved from an app was published at', () => {
    expect(channelCallbackUrl('https://api.x.com', 'acme', channel('slack', '/apps/support/slack'))).toBe(
      'https://api.x.com/acme/apps/support/slack',
    )
  })

  it('is the shared inbound route for email', () => {
    expect(channelCallbackUrl('https://api.x.com', 'acme', channel('email'))).toBe('https://api.x.com/channels/email/inbound')
  })

  it('is absent where nothing calls back, and each says why', () => {
    for (const type of ['web', 'tui', 'desktop', 'binary', 'discord'] as const) {
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
  })
})
