import { describe, it, expect, vi } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'

import { render } from '../../../test/setup'
import { HostedChatBuilder } from '../hosted-chat-builder'
import {
  HOSTED_CHAT_REFUSALS,
  canPublishHostedChat,
  hostedChatConfigFrom,
  slugError,
  type HostedChatConfig,
} from '../hosted-chat-config'

vi.mock('@/lib/api', () => ({
  gatewaysApi: { update: vi.fn().mockResolvedValue({}) },
  getApiBaseUrl: () => '',
}))

const config = (overrides: Partial<HostedChatConfig> = {}): HostedChatConfig => ({
  ...hostedChatConfigFrom(null),
  slug: 'acme',
  appName: 'Acme Assistant',
  ...overrides,
})

const SAFE_PUBLIC = { costCapCents: 500, perEndUserRateLimit: 20, perIpRateLimit: 60 }

describe('slugError', () => {
  it('accepts a normal label', () => {
    expect(slugError('acme')).toBeNull()
    expect(slugError('acme-support')).toBeNull()
  })

  it('explains each way a slug can be wrong', () => {
    expect(slugError('')).toMatch(/Pick a subdomain/)
    expect(slugError('ab')).toMatch(/at least 3/)
    expect(slugError('a'.repeat(64))).toMatch(/63 characters or fewer/)
    expect(slugError('-acme')).toMatch(/cannot start or end/)
    expect(slugError('ACME SUPPORT')).toMatch(/lowercase letters/)
    expect(slugError('www')).toMatch(/reserved/)
  })
})

describe('canPublishHostedChat mirrors the backend', () => {
  it('passes a public link with a cost cap and both limits', () => {
    expect(canPublishHostedChat(config(), SAFE_PUBLIC).publishable).toBe(true)
  })

  it('refuses a public link with no cost cap, using the backend wording', () => {
    const check = canPublishHostedChat(config(), { ...SAFE_PUBLIC, costCapCents: null })
    expect(check.publishable).toBe(false)
    // Copied verbatim so the two never disagree in front of a user.
    expect(check.refusals[0].message).toBe(HOSTED_CHAT_REFUSALS.PUBLIC_LINK_NEEDS_COST_CAP)
  })

  it('requires both rate limits, not either', () => {
    expect(
      canPublishHostedChat(config(), { ...SAFE_PUBLIC, perIpRateLimit: null }).publishable,
    ).toBe(false)
    expect(
      canPublishHostedChat(config(), { ...SAFE_PUBLIC, perEndUserRateLimit: null }).publishable,
    ).toBe(false)
  })

  it('does not demand a cost cap for a gated surface', () => {
    expect(canPublishHostedChat(config({ authMode: 'email_otp' }), {}).publishable).toBe(true)
  })

  it('gates sso and disclosure removal on entitlements', () => {
    expect(canPublishHostedChat(config({ authMode: 'sso' }), SAFE_PUBLIC).publishable).toBe(false)
    expect(
      canPublishHostedChat(config({ aiDisclosure: '' }), SAFE_PUBLIC).refusals[0].code,
    ).toBe('DISCLOSURE_REMOVAL_NOT_ENTITLED')
  })
})

describe('HostedChatBuilder', () => {
  const gateway = (overrides: any = {}) => ({
    id: 'gw-1',
    configuration: { hostedChat: config() },
    costCapCents: 500,
    rateLimits: { perEndUser: 20, perIp: 60 },
    ...overrides,
  })

  it('shows the tenant URL that a visitor will open', () => {
    render(<HostedChatBuilder gateway={gateway()} />)
    expect(screen.getByText('https://acme.almyty.app')).toBeInTheDocument()
  })

  it('names the blocker when a public link has no cost cap', () => {
    render(<HostedChatBuilder gateway={gateway({ costCapCents: null })} />)
    const blockers = screen.getByRole('list', { name: 'Publish blockers' })
    expect(blockers).toHaveTextContent(/needs a cost cap/)
  })

  it('will not let an unpublishable app be saved', () => {
    render(<HostedChatBuilder gateway={gateway({ rateLimits: { perEndUser: null, perIp: null } })} />)
    expect(screen.getByRole('button', { name: /Save chat app/ })).toBeDisabled()
  })

  it('enables save once the surface is safe', () => {
    render(<HostedChatBuilder gateway={gateway()} />)
    expect(screen.getByRole('button', { name: /Save chat app/ })).toBeEnabled()
    expect(screen.getByText('Ready to publish.')).toBeInTheDocument()
  })

  it('reports an invalid slug inline rather than on save', () => {
    render(<HostedChatBuilder gateway={gateway()} />)
    fireEvent.change(screen.getByLabelText('Subdomain'), { target: { value: 'www' } })
    expect(screen.getByText('That subdomain is reserved.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Save chat app/ })).toBeDisabled()
  })

  it('disables white-label without the entitlement', () => {
    render(<HostedChatBuilder gateway={gateway()} />)
    expect(screen.getByLabelText('Remove almyty branding')).toBeDisabled()
  })

  it('enables white-label with the entitlement', () => {
    render(<HostedChatBuilder gateway={gateway()} entitlements={{ whiteLabel: true }} />)
    expect(screen.getByLabelText('Remove almyty branding')).toBeEnabled()
  })

  it('adds and removes suggested prompts', () => {
    render(<HostedChatBuilder gateway={gateway()} />)
    const input = screen.getByLabelText('New suggested prompt')
    fireEvent.change(input, { target: { value: 'Track my order' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByText('Track my order')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Remove Track my order' }))
    expect(screen.queryByText('Track my order')).toBeNull()
  })

  it('stops at four suggested prompts', () => {
    render(
      <HostedChatBuilder
        gateway={gateway({
          configuration: { hostedChat: config({ suggestedPrompts: ['a', 'b', 'c', 'd'] }) },
        })}
      />,
    )
    expect(screen.queryByLabelText('New suggested prompt')).toBeNull()
  })
})
