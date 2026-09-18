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

// jsdom has no EventSource; nothing here streams, it only must not explode.
/**
 * A fake EventSource that actually dispatches.
 *
 * The stub it replaces swallowed listeners, which was enough for the
 * open-a-conversation tests but cannot express "the stream finished
 * after the visitor moved on" — the case where a reply used to overwrite
 * the thread now on screen.
 */
class FakeEventSource {
  static last: FakeEventSource | null = null
  private listeners = new Map<string, Array<(event: any) => void>>()
  onerror: ((event: any) => void) | null = null
  closed = false

  constructor() {
    FakeEventSource.last = this
  }

  addEventListener(type: string, handler: (event: any) => void) {
    const forType = this.listeners.get(type) ?? []
    forType.push(handler)
    this.listeners.set(type, forType)
  }

  close() {
    this.closed = true
  }

  /** Dispatch one server event, the way the real source would. */
  emit(type: string, data: string) {
    for (const handler of this.listeners.get(type) ?? []) handler({ data })
  }
}

const branding = (overrides: Partial<HostedChatBranding> = {}): HostedChatBranding => ({
  appName: 'Acme Assistant',
  primaryColor: '#8b5cf6',
  greeting: 'How can Acme help?',
  theme: 'auto',
  logoUrl: null,
  suggestedPrompts: ['Track my order'],
  authMode: 'public_link',
  whiteLabel: false,
  aiDisclosure: null,
  visitorCanDelete: true,
  visitorCanExport: true,
  ...overrides,
})

// Under a full-suite run this file shares a worker with two dozen others, and
// testing-library's 1s default for findBy* is not enough for a react-query
// round trip to land. Neither budget is load-bearing: both only bound how long
// a genuine failure takes to report.
const SLOW = 20000
const WAIT = { timeout: 10000 }

/** A promise this test resolves or rejects by hand, to hold the round trip open. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * Opening a past conversation on the public visitor surface.
 *
 * `openConversation` set the id and then awaited `hostedChatApi.messages`
 * with no pending flag and no `try`. Because `showEmpty` is
 * `messages.length === 0`, the visitor saw the greeting/empty state for the
 * whole round trip -- as if the conversation they had just clicked were
 * empty -- and if the fetch rejected, the promise went unhandled,
 * `setMessages` never ran, and the next message they sent was posted into a
 * thread whose history was invisible to them.
 */
describe('hosted chat: opening a past conversation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(globalThis as any).EventSource = FakeEventSource
    ;(hostedChatApi.branding as any).mockResolvedValue(branding())
    // A sidebar only renders once there is history to put in it.
    ;(hostedChatApi.conversations as any).mockResolvedValue([
      { id: 'c1', title: 'Where is my order', updatedAt: new Date().toISOString() },
    ])
  })

  async function clickTheConversation() {
    fireEvent.click(await screen.findByRole('button', { name: 'Where is my order' }, WAIT))
  }

  it('shows a loading state instead of the greeting while the thread is fetched', async () => {
    const thread = deferred<any>()
    ;(hostedChatApi.messages as any).mockReturnValue(thread.promise)

    render(<HostedChatPage slug="acme" />)
    await clickTheConversation()

    // Mid-flight: the page must not claim this conversation is empty.
    await screen.findByRole('status', { name: 'Loading conversation' }, WAIT)
    expect(screen.queryByText('How can Acme help?')).toBeNull()

    thread.resolve({
      conversationId: 'c1',
      title: 'Where is my order',
      messages: [
        { id: 'm1', role: 'user', content: 'Where is my order?', createdAt: new Date().toISOString() },
        { id: 'm2', role: 'assistant', content: 'It ships tomorrow.', createdAt: new Date().toISOString() },
      ],
    })

    expect(await screen.findByText('It ships tomorrow.', {}, WAIT)).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Loading conversation' })).toBeNull()
  }, SLOW)

  it('tells the visitor when the thread cannot be loaded instead of failing silently', async () => {
    const thread = deferred<any>()
    ;(hostedChatApi.messages as any).mockReturnValue(thread.promise)

    render(<HostedChatPage slug="acme" />)
    await clickTheConversation()
    await screen.findByRole('status', { name: 'Loading conversation' }, WAIT)

    thread.reject({ response: { data: { message: 'Conversation not found.' } } })

    // The rejection is handled and surfaced, not swallowed as an unhandled promise.
    expect(await screen.findByRole('alert', {}, WAIT)).toHaveTextContent('Conversation not found.')
    // And the spinner does not hang forever on the failure.
    await waitFor(
      () => expect(screen.queryByRole('status', { name: 'Loading conversation' })).toBeNull(),
      WAIT,
    )
  }, SLOW)

  it('does not leave the next message attached to a thread it could not show', async () => {
    ;(hostedChatApi.messages as any).mockRejectedValue(new Error('boom'))
    ;(hostedChatApi.send as any).mockResolvedValue({ runId: 'r1', conversationId: 'c2' })

    render(<HostedChatPage slug="acme" />)
    await clickTheConversation()
    await screen.findByRole('alert', {}, WAIT)

    // The failed open drops back to a new conversation, so `send` must not
    // carry the id of the thread whose history the visitor never saw.
    await waitFor(() => {
      fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hello' } })
      expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()
    }, WAIT)
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(hostedChatApi.send).toHaveBeenCalled(), WAIT)
    expect((hostedChatApi.send as any).mock.calls[0][2]).toBeUndefined()
  }, SLOW)
})

/**
 * A reply streams into the thread it was sent from, and the visitor can
 * open a different conversation while it is in flight.
 *
 * Nothing tied the stream to a thread, so the old run's tokens appended
 * into whatever was now on screen, and its final transcript reconcile
 * overwrote the newly opened thread outright — the visitor watched one
 * conversation turn into another. Closing the EventSource from
 * openConversation is not the fix: only these handlers clear `sending`,
 * so that would leave the composer disabled forever.
 */
describe('hosted chat: a reply that finishes after you have moved on', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(globalThis as any).EventSource = FakeEventSource
    ;(hostedChatApi.branding as any).mockResolvedValue(branding())
    ;(hostedChatApi.conversations as any).mockResolvedValue([
      { id: 'c1', title: 'Where is my order', updatedAt: new Date().toISOString() },
      { id: 'c2', title: 'Refund please', updatedAt: new Date().toISOString() },
    ])
  })

  it('does not write the finished thread over the one now on screen', async () => {
    ;(hostedChatApi.send as any).mockResolvedValue({ runId: 'r1', conversationId: 'c1' })
    ;(hostedChatApi.messages as any).mockImplementation(async (_slug: string, id: string) =>
      id === 'c1'
        ? { messages: [{ id: 'm-old', role: 'assistant', content: 'from the first thread', createdAt: '' }] }
        : { messages: [{ id: 'm-new', role: 'assistant', content: 'from the second thread', createdAt: '' }] },
    )

    render(<HostedChatPage slug="acme" />)

    // Send in the first thread, then open the second before it finishes.
    const composer = await screen.findByPlaceholderText(/message/i, {}, WAIT)
    fireEvent.change(composer, { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    await waitFor(() => expect(hostedChatApi.send).toHaveBeenCalled(), WAIT)

    fireEvent.click(await screen.findByRole('button', { name: 'Refund please' }, WAIT))
    await screen.findByText('from the second thread', {}, WAIT)

    // Now let the first thread's stream finish.
    FakeEventSource.last?.emit('done', '{}')

    await waitFor(
      () => expect(screen.queryByText('from the first thread')).not.toBeInTheDocument(),
      WAIT,
    )
    expect(screen.getByText('from the second thread')).toBeInTheDocument()
  })

  it('still releases the composer, so the visitor is not left unable to type', async () => {
    ;(hostedChatApi.send as any).mockResolvedValue({ runId: 'r1', conversationId: 'c1' })
    ;(hostedChatApi.messages as any).mockResolvedValue({ messages: [] })

    render(<HostedChatPage slug="acme" />)

    const composer = await screen.findByPlaceholderText(/message/i, {}, WAIT)
    fireEvent.change(composer, { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    await waitFor(() => expect(hostedChatApi.send).toHaveBeenCalled(), WAIT)

    fireEvent.click(await screen.findByRole('button', { name: 'Refund please' }, WAIT))
    FakeEventSource.last?.emit('done', '{}')

    await waitFor(
      () => expect(screen.getByPlaceholderText(/message/i)).not.toBeDisabled(),
      WAIT,
    )
  })
})
