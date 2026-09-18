import { describe, it, expect, vi } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'
import { readFileSync } from 'fs'
import { join } from 'path'

import { render } from '../../../test/setup'
import { HostedChatBuilder } from '../hosted-chat-builder'
import {
  SERVER_ENFORCED_REFUSALS,
  hostedChatSaveCheck,
  HOSTED_CHAT_DEFAULTS,
} from '../hosted-chat-config'

/**
 * A hosted chat app could never be saved.
 *
 * The builder gated Save on canPublishHostedChat, and fed it
 * `gateway.costCapCents` and `gateway.rateLimits.requestsPerMinute` --
 * two properties a Gateway does not have, reached through `as any`. Both
 * were always undefined, so PUBLIC_LINK_NEEDS_COST_CAP and
 * PUBLIC_LINK_NEEDS_RATE_LIMIT always fired, and no screen in the product
 * had a field that could clear either one.
 *
 * The server already knew this was unjudgeable and filtered both out. The
 * browser is now the same shape, and the last test here pins the two
 * lists to each other so they cannot drift apart again.
 */

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, gatewaysApi: { ...actual.gatewaysApi, update: vi.fn().mockResolvedValue({}) } }
})

vi.mock('@/store/app', () => ({
  useNotifications: () => ({
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}))

const gateway = (hostedChat: Record<string, any>) => ({
  id: 'gw-1',
  configuration: { hostedChat: { ...HOSTED_CHAT_DEFAULTS, ...hostedChat } },
})

describe('hosted chat save gate', () => {
  it('lets a public-link app with a valid subdomain be saved', () => {
    render(<HostedChatBuilder gateway={gateway({ slug: 'acme', authMode: 'public_link' })} />)

    expect(screen.getByRole('button', { name: 'Save chat app' })).toBeEnabled()
    expect(screen.getByText('Ready to publish.')).toBeInTheDocument()
  })

  it('never shows a blocker an operator has no field for', () => {
    render(<HostedChatBuilder gateway={gateway({ slug: 'acme', authMode: 'public_link' })} />)

    expect(screen.queryByText(/needs a cost cap/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/per-visitor and a per-IP rate limit/i)).not.toBeInTheDocument()
  })

  it('still blocks on the subdomain, which is a field on this screen', () => {
    render(<HostedChatBuilder gateway={gateway({ slug: 'acme' })} />)

    fireEvent.change(screen.getByLabelText('Subdomain'), { target: { value: 'no' } })

    expect(screen.getByRole('button', { name: 'Save chat app' })).toBeDisabled()
  })

  it('still blocks on an entitlement the server enforces', () => {
    const check = hostedChatSaveCheck(
      { ...HOSTED_CHAT_DEFAULTS, slug: 'acme', authMode: 'sso' },
      { hasEnterpriseAuth: false },
    )

    expect(check.publishable).toBe(false)
    expect(check.refusals.map((r) => r.code)).toEqual(['AUTH_MODE_NOT_ENTITLED'])
  })

  it('enforces exactly the refusals the server enforces', () => {
    // Read the server's own list rather than restating it, so a change
    // on either side fails here instead of silently disabling Save again.
    const source = readFileSync(
      join(__dirname, '../../../../../backend/src/modules/gateways/gateways.service.ts'),
      'utf8',
    )
    const block = source.match(/const ENTITLEMENT_REFUSALS = new Set\(\[([\s\S]*?)\]\)/)
    expect(block, 'ENTITLEMENT_REFUSALS not found in gateways.service.ts').toBeTruthy()

    const serverCodes = [...block![1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort()

    expect([...SERVER_ENFORCED_REFUSALS].sort()).toEqual(serverCodes)
  })
})
