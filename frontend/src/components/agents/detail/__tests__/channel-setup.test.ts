import { describe, it, expect } from 'vitest'

import {
  CHANNEL_SETUP_GUIDES,
  AI_DISCLOSURE_CHANNEL_TYPES,
  buildChannelWebhookUrl,
  buildWidgetEmbedSnippet,
  getGatewaySlug,
} from '../channel-setup'

describe('channel-setup helpers', () => {
  it('builds the unified-endpoint webhook URL', () => {
    expect(buildChannelWebhookUrl('https://api.almyty.dev', 'acme', 'support-bot')).toBe(
      'https://api.almyty.dev/acme/support-bot',
    )
  })

  it('tolerates a trailing slash on the api host', () => {
    expect(buildChannelWebhookUrl('https://api.almyty.dev/', 'acme', 'support-bot')).toBe(
      'https://api.almyty.dev/acme/support-bot',
    )
  })

  it('builds the widget embed snippet from the gateway id', () => {
    expect(buildWidgetEmbedSnippet('https://api.almyty.dev', 'gw-1')).toBe(
      '<script src="https://api.almyty.dev/gateways/gw-1/widget.js" async></script>',
    )
  })

  it('derives the gateway slug from the endpoint field', () => {
    expect(getGatewaySlug({ endpoint: '/support-bot' })).toBe('support-bot')
    expect(getGatewaySlug({ endpoint: 'support-bot/' })).toBe('support-bot')
  })

  it('falls back to a slugified name when there is no endpoint', () => {
    expect(getGatewaySlug({ name: 'Support Bot!' })).toBe('support-bot')
  })

  it('has a setup guide for every chat channel type', () => {
    const expected = [
      'slack', 'telegram', 'whatsapp', 'whatsapp_cloud', 'sms', 'discord',
      'google_chat', 'microsoft_teams', 'signal', 'matrix', 'irc', 'email',
      'webhook', 'chat_widget', 'a2a', 'openai_chat',
    ]
    for (const type of expected) {
      expect(CHANNEL_SETUP_GUIDES[type], `missing guide for ${type}`).toBeDefined()
      expect(CHANNEL_SETUP_GUIDES[type].steps.length).toBeGreaterThan(0)
    }
  })

  it('marks auto-registered webhooks for telegram and twilio channels', () => {
    expect(CHANNEL_SETUP_GUIDES.telegram.webhookMode).toBe('auto')
    expect(CHANNEL_SETUP_GUIDES.whatsapp.webhookMode).toBe('auto')
    expect(CHANNEL_SETUP_GUIDES.sms.webhookMode).toBe('auto')
    expect(CHANNEL_SETUP_GUIDES.discord.webhookMode).toBe('none')
    expect(CHANNEL_SETUP_GUIDES.slack.webhookMode).toBe('manual')
  })

  it('exposes the AI disclosure toggle for chat channels but not protocol endpoints', () => {
    expect(AI_DISCLOSURE_CHANNEL_TYPES.has('slack')).toBe(true)
    expect(AI_DISCLOSURE_CHANNEL_TYPES.has('sms')).toBe(true)
    expect(AI_DISCLOSURE_CHANNEL_TYPES.has('whatsapp_cloud')).toBe(true)
    expect(AI_DISCLOSURE_CHANNEL_TYPES.has('a2a')).toBe(false)
    expect(AI_DISCLOSURE_CHANNEL_TYPES.has('openai_chat')).toBe(false)
  })
})
