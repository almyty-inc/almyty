import { describe, it, expect } from 'vitest'

import {
  CHANNEL_CREDENTIAL_FIELDS,
  CHANNEL_TARGETS,
  CREDENTIAL_ALTERNATIVES,
  missingChannelFields,
  DISTRIBUTION_INBOUND,
  appSlugError,
  distributionCallbackUrl,
  isDistributionTarget,
  slugify,
} from '../agent-apps'

/**
 * Mirrors REQUIRED_CREDENTIALS in backend distribution-publish.ts. A
 * required field missing here is a distribution the backend will refuse
 * to publish with no field on the page to fix it.
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

describe('distributionCallbackUrl', () => {
  it('is the app surface on the unified endpoint', () => {
    expect(distributionCallbackUrl('https://api.x.com/', 'acme', 'support', 'whatsapp_cloud')).toBe(
      'https://api.x.com/acme/apps/support/whatsapp_cloud',
    )
  })

  it('is the shared inbound route for email', () => {
    expect(distributionCallbackUrl('https://api.x.com', 'acme', 'support', 'email')).toBe(
      'https://api.x.com/channels/email/inbound',
    )
  })

  it('is absent where nothing calls back, and each says why', () => {
    for (const target of ['web', 'tui', 'desktop', 'binary', 'discord'] as const) {
      expect(distributionCallbackUrl('https://api.x.com', 'acme', 'support', target)).toBeNull()
      expect(DISTRIBUTION_INBOUND[target].why).toBeTruthy()
    }
  })

  it('tells the operator what to do with every URL it shows', () => {
    for (const target of CHANNEL_TARGETS) {
      const inbound = DISTRIBUTION_INBOUND[target]
      if (inbound.mode !== 'none') expect(inbound.where).toBeTruthy()
    }
  })
})

describe('isDistributionTarget', () => {
  it('accepts known targets and nothing else', () => {
    expect(isDistributionTarget('whatsapp_cloud')).toBe(true)
    expect(isDistributionTarget('toString')).toBe(false)
    expect(isDistributionTarget(undefined)).toBe(false)
  })
})


describe('slugify', () => {
  it('turns a display name into a usable address', () => {
    expect(slugify('Acme Support')).toBe('acme-support')
    expect(slugify('  Acme   Support  ')).toBe('acme-support')
  })

  it('drops characters that cannot appear in a hostname', () => {
    expect(slugify('Acme & Co. Support!')).toBe('acme-co-support')
  })

  it('never leaves a leading or trailing hyphen', () => {
    // Those are the two forms a hostname label cannot take.
    expect(slugify('!!!Acme!!!')).toBe('acme')
    expect(slugify('-Acme-')).toBe('acme')
  })

  it('caps at the hostname label limit', () => {
    expect(slugify('a'.repeat(120)).length).toBe(63)
  })

  it('returns empty for a name with nothing usable in it', () => {
    expect(slugify('!!!')).toBe('')
  })
})

describe('appSlugError', () => {
  it('accepts a usable address', () => {
    expect(appSlugError('acme-support')).toBeNull()
    expect(appSlugError('a1b2')).toBeNull()
  })

  it('explains each way an address is unusable', () => {
    expect(appSlugError('')).toMatch(/Pick a name/)
    expect(appSlugError('ab')).toMatch(/at least 3/)
    expect(appSlugError('a'.repeat(64))).toMatch(/63 characters/)
    expect(appSlugError('-acme')).toMatch(/cannot start or end/)
    expect(appSlugError('acme-')).toMatch(/cannot start or end/)
    expect(appSlugError('Acme Support')).toMatch(/lowercase/)
    expect(appSlugError('acme_support')).toMatch(/lowercase/)
  })

  it('refuses names the platform routes itself', () => {
    for (const reserved of ['www', 'api', 'app', 'docs', 'download']) {
      expect(appSlugError(reserved)).toMatch(/reserved/)
    }
  })

  it('matches what slugify produces, so the default never fails validation', () => {
    // If these disagreed, typing a normal product name would produce an
    // address the form immediately rejects.
    for (const name of ['Acme Support', 'Northwind AI', 'Support Bot 2']) {
      expect(appSlugError(slugify(name))).toBeNull()
    }
  })
})
