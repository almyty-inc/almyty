import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'

import { render } from '../../test/setup'
import { HostedChatPage } from '../hosted-chat'
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
      streamUrl: vi.fn(() => 'http://localhost/stream'),
    },
  }
})

// jsdom has no EventSource; the streaming path only needs to not explode.
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
  emit(type: string, data: unknown) {
    this.listeners[type]?.({ data: JSON.stringify(data) })
  }
  close() {}
}

const branding = (overrides: Partial<HostedChatBranding> = {}): HostedChatBranding => ({
  appName: 'Acme Assistant',
  primaryColor: '#8b5cf6',
  greeting: 'How can Acme help?',
  theme: 'auto',
  logoUrl: null,
  suggestedPrompts: ['Track my order', 'Start a return'],
  authMode: 'public_link',
  whiteLabel: false,
  aiDisclosure: null,
  ...overrides,
})

describe('HostedChatPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    FakeEventSource.instances = []
    ;(globalThis as any).EventSource = FakeEventSource
    ;(hostedChatApi.conversations as any).mockResolvedValue([])
    ;(hostedChatApi.messages as any).mockResolvedValue({
      conversationId: 'c1',
      title: 'New chat',
      messages: [],
    })
  })

  it('renders the tenant name and greeting, not almyty branding', async () => {
    ;(hostedChatApi.branding as any).mockResolvedValue(branding())
    render(<HostedChatPage slug="acme" />)

    // The mark renders in both the header and the sidebar by design.
    expect((await screen.findAllByText('Acme Assistant')).length).toBeGreaterThan(0)
    expect(screen.getByText('How can Acme help?')).toBeInTheDocument()
  })

  it('shows the Art. 50 disclosure by default', async () => {
    ;(hostedChatApi.branding as any).mockResolvedValue(branding())
    render(<HostedChatPage slug="acme" />)
    expect(await screen.findByText('You are chatting with an AI assistant.')).toBeInTheDocument()
  })

  it('uses a custom disclosure when the tenant set one', async () => {
    ;(hostedChatApi.branding as any).mockResolvedValue(
      branding({ aiDisclosure: 'Replies are automated.' }),
    )
    render(<HostedChatPage slug="acme" />)
    expect(await screen.findByText('Replies are automated.')).toBeInTheDocument()
  })

  it('omits the disclosure only when it was deliberately cleared', async () => {
    // Publishing already gated this on the white-label entitlement.
    ;(hostedChatApi.branding as any).mockResolvedValue(
      branding({ aiDisclosure: '', whiteLabel: true }),
    )
    render(<HostedChatPage slug="acme" />)
    await screen.findAllByText('Acme Assistant')
    expect(screen.queryByText(/chatting with an AI assistant/)).toBeNull()
  })

  it('shows the almyty mark unless white-labelled', async () => {
    ;(hostedChatApi.branding as any).mockResolvedValue(branding())
    render(<HostedChatPage slug="acme" />)
    expect(await screen.findByText(/Powered by/)).toBeInTheDocument()
  })

  it('drops the almyty mark when white-labelled', async () => {
    ;(hostedChatApi.branding as any).mockResolvedValue(branding({ whiteLabel: true }))
    render(<HostedChatPage slug="acme" />)
    await screen.findAllByText('Acme Assistant')
    expect(screen.queryByText(/Powered by/)).toBeNull()
  })

  it('fills the composer from a suggested prompt', async () => {
    ;(hostedChatApi.branding as any).mockResolvedValue(branding())
    render(<HostedChatPage slug="acme" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Track my order' }))
    expect(screen.getByLabelText('Message')).toHaveValue('Track my order')
  })

  it('sends a message and streams the reply into place', async () => {
    ;(hostedChatApi.branding as any).mockResolvedValue(branding())
    ;(hostedChatApi.send as any).mockResolvedValue({ runId: 'run-1', conversationId: 'c1' })
    ;(hostedChatApi.messages as any).mockResolvedValue({
      conversationId: 'c1',
      title: 'New chat',
      messages: [
        { id: 'm1', role: 'user', content: 'hello', createdAt: '2026-01-01' },
        { id: 'm2', role: 'assistant', content: 'hi there', createdAt: '2026-01-01' },
      ],
    })

    render(<HostedChatPage slug="acme" />)
    const input = await screen.findByLabelText('Message')
    fireEvent.change(input, { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(hostedChatApi.send).toHaveBeenCalledWith('acme', 'hello', undefined))

    const source = FakeEventSource.instances[0]
    source.emit('token', { token: 'hi ' })
    source.emit('done', { reason: 'run.completed' })

    // The transcript is the source of truth, so the finished reply
    // replaces whatever the stream accumulated.
    expect(await screen.findByText('hi there')).toBeInTheDocument()
  })

  it('surfaces a rate limit in words a visitor understands', async () => {
    ;(hostedChatApi.branding as any).mockResolvedValue(branding())
    ;(hostedChatApi.send as any).mockRejectedValue({ response: { status: 429 } })

    render(<HostedChatPage slug="acme" />)
    fireEvent.change(await screen.findByLabelText('Message'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/busy right now/)
  })

  it('removes the optimistic turn when sending failed', async () => {
    ;(hostedChatApi.branding as any).mockResolvedValue(branding())
    ;(hostedChatApi.send as any).mockRejectedValue({ response: { status: 500 } })

    render(<HostedChatPage slug="acme" />)
    fireEvent.change(await screen.findByLabelText('Message'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await screen.findByRole('alert')
    // Leaving it on screen would imply the message was delivered.
    expect(screen.queryByText('hello')).toBeNull()
  })

  it('explains an unknown slug without leaking whether it exists', async () => {
    ;(hostedChatApi.branding as any).mockRejectedValue(new Error('404'))
    render(<HostedChatPage slug="nope" />)
    expect(await screen.findByText('This chat is not available')).toBeInTheDocument()
  })
})
