import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

import { WebhookRegistrationLine, callbackUrlDescription } from '../channel-settings'
import { CHANNEL_INBOUND, notReceivingReason } from '@/lib/agent-channels'

/**
 * Publishing a Telegram channel on a server with no PUBLIC_API_URL skipped
 * the webhook registration silently: the channel read Live and no message
 * ever arrived. The channel now says it receives nothing, and why.
 */
const skipped = { action: 'register', status: 'skipped', error: 'the public address of this server is not configured (PUBLIC_API_URL)', code: 'PUBLIC_URL_NOT_CONFIGURED', at: null } as const

describe('a channel on a server with no public address', () => {
  it('is not receiving messages while live, and only then', () => {
    expect(notReceivingReason({ status: 'live', webhookRegistration: skipped })).toBe('Public address not configured')
    expect(notReceivingReason({ status: 'draft', webhookRegistration: skipped })).toBeNull()
    expect(notReceivingReason({ status: 'live', webhookRegistration: { ...skipped, code: null } })).toBeNull()
    expect(notReceivingReason({ status: 'live', webhookRegistration: { ...skipped, status: 'registered', code: null } })).toBeNull()
  })

  it('says on the channel page that nothing can reach it, not "add the URL yourself"', () => {
    render(<WebhookRegistrationLine registration={skipped} platform="Telegram" />)
    const line = screen.getByTestId('webhook-registration')
    expect(line).toHaveTextContent('Not receiving messages: this server has no public address (PUBLIC_API_URL)')
    expect(line).toHaveTextContent('Telegram has nowhere to deliver them')
    expect(line).not.toHaveTextContent('Add the URL above there yourself')
  })

  it('does not tell the Callback URL card it was "registered for you" when it could not be', () => {
    const where = CHANNEL_INBOUND.telegram.where!
    expect(where).toContain('Registered with Telegram for you when you publish')
    const said = callbackUrlDescription(where, skipped, 'Telegram')
    expect(said).toBe('Telegram will be told this address when this server has a public address and you publish.')
    expect(said).not.toContain('Registered with Telegram')
    // Registered, or not tried yet: the usual words.
    expect(callbackUrlDescription(where, { ...skipped, status: 'registered', code: null }, 'Telegram')).toBe(where)
    expect(callbackUrlDescription(where, null, 'Telegram')).toBe(where)
  })
})
