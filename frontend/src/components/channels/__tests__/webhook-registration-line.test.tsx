import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

import { WebhookRegistrationLine } from '../channel-settings'
import { notReceivingReason } from '@/lib/agent-channels'

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
    expect(line).toHaveTextContent('Not receiving messages: public address not configured')
    expect(line).toHaveTextContent('Telegram has nowhere to deliver them')
    expect(line).not.toHaveTextContent('Add the URL above there yourself')
  })
})
