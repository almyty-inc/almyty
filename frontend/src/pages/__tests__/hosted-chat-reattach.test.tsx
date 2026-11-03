import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, screen, fireEvent, waitFor } from '@testing-library/react'

import { render } from '../../test/setup'
import { HostedChatPage } from '../hosted-chat'
import { hostedChatApi, type HostedChatBranding } from '@/lib/hosted-chat'

/**
 * A reply still being written when the visitor reloads the page, or comes
 * back to the conversation from the list: the page picks it up live. The
 * transcript names the open run (`openRunId`), and the page opens its stream
 * with no position, so the server sends the reply from its start, then
 * live; the composer waits for it, as it does after sending. A finished
 * conversation opens as before, from the transcript, with no stream.
 */
vi.mock('@/lib/hosted-chat', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hosted-chat')>('@/lib/hosted-chat')
  return {
    ...actual,
    hostedChatApi: {
      branding: vi.fn(),
      conversations: vi.fn(),
      messages: vi.fn(),
      send: vi.fn(),
      streamUrl: vi.fn((_slug: string, runId: string, after?: string) => `http://localhost/stream?runId=${runId}${after ? `&after=${after}` : ''}`),
      me: vi.fn(),
    },
  }
})

vi.mock('@/lib/reconnect', () => ({ STREAM_RECONNECT_DELAYS_MS: [0, 0, 0] }))

class FakeEventSource {
  static instances: FakeEventSource[] = []
  listeners: Record<string, (event: any) => void> = {}
  onerror: ((event: any) => void) | null = null
  closed = false
  constructor(public url: string) {
    FakeEventSource.instances.push(this)
  }
  addEventListener(type: string, handler: (event: any) => void) {
    this.listeners[type] = handler
  }
  emit(type: string, data: unknown, lastEventId = '') {
    this.listeners[type]?.({ data: JSON.stringify(data), lastEventId })
  }
  close() {
    this.closed = true
  }
}

const WAIT = { timeout: 5000 }
const OPEN_KEY = 'almyty-chat-open-acme'

const branding = (): HostedChatBranding => ({
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
})

const asked = { id: 'm1', role: 'user', content: 'Where is my order?', createdAt: '2026-10-28' }
const answered = { id: 'm2', role: 'assistant', content: 'Your order ships Monday.', createdAt: '2026-10-28' }
const streams = () => FakeEventSource.instances

describe('HostedChatPage: a reply still being written is picked up when the conversation opens', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    FakeEventSource.instances = []
    ;(globalThis as any).EventSource = FakeEventSource
    ;(hostedChatApi.branding as any).mockResolvedValue(branding())
    ;(hostedChatApi.conversations as any).mockResolvedValue([{ id: 'c1', title: 'Where is my order', createdAt: '2026-10-28' }])
  })

  it('reopened from the list: the reply streams in live, from its start, and the composer waits for it', async () => {
    ;(hostedChatApi.messages as any)
      .mockResolvedValueOnce({ conversationId: 'c1', title: 'Where is my order', messages: [asked], openRunId: 'run-5' })
      .mockResolvedValue({ conversationId: 'c1', title: 'Where is my order', messages: [asked, answered], openRunId: null })
    render(<HostedChatPage slug="acme" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Where is my order' }, WAIT))

    await waitFor(() => expect(streams()).toHaveLength(1), WAIT)
    // No position: the reply from its start, replies only.
    expect(hostedChatApi.streamUrl).toHaveBeenLastCalledWith('acme', 'run-5', undefined)
    expect(await screen.findByText('Where is my order?', {}, WAIT)).toBeInTheDocument()

    await act(async () => {
      streams()[0].emit('token', { content: 'Your order ' }, '1730000000000-0.0')
      streams()[0].emit('token', { content: 'ships Monday.' }, '1730000000000-1.0')
    })
    await waitFor(() => expect(screen.getByText('Your order ships Monday.')).toBeInTheDocument(), WAIT)
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Thanks' } })
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()

    await act(async () => {
      streams()[0].emit('done', { reason: 'run.completed' })
    })
    await waitFor(() => expect(hostedChatApi.messages).toHaveBeenCalledTimes(2), WAIT)
    expect(screen.getAllByText('Your order ships Monday.')).toHaveLength(1)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled(), WAIT)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('after a reload: the page comes back to the conversation the tab had open, and to its reply', async () => {
    window.sessionStorage.setItem(OPEN_KEY, 'c1')
    ;(hostedChatApi.messages as any).mockResolvedValue({ conversationId: 'c1', title: 'Where is my order', messages: [asked], openRunId: 'run-5' })
    render(<HostedChatPage slug="acme" />)

    await waitFor(() => expect(hostedChatApi.messages).toHaveBeenCalledWith('acme', 'c1'), WAIT)
    await waitFor(() => expect(streams()).toHaveLength(1), WAIT)
    expect(hostedChatApi.streamUrl).toHaveBeenLastCalledWith('acme', 'run-5', undefined)
    await act(async () => {
      streams()[0].emit('token', { content: 'Your order ships Monday.' }, '1730000000000-0.0')
    })
    await waitFor(() => expect(screen.getByText('Your order ships Monday.')).toBeInTheDocument(), WAIT)
  })

  it('a finished conversation opens from its transcript, with no stream', async () => {
    ;(hostedChatApi.messages as any).mockResolvedValue({ conversationId: 'c1', title: 'Where is my order', messages: [asked, answered], openRunId: null })
    render(<HostedChatPage slug="acme" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Where is my order' }, WAIT))
    await waitFor(() => expect(screen.getByText('Your order ships Monday.')).toBeInTheDocument(), WAIT)
    expect(streams()).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Send' })).toBeDefined()
  })

  it('the tab remembers what it has open, and forgets it on a new chat', async () => {
    ;(hostedChatApi.messages as any).mockResolvedValue({ conversationId: 'c1', title: 'Where is my order', messages: [asked, answered], openRunId: null })
    render(<HostedChatPage slug="acme" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Where is my order' }, WAIT))
    await screen.findByText('Your order ships Monday.', {}, WAIT)
    await waitFor(() => expect(window.sessionStorage.getItem(OPEN_KEY)).toBe('c1'), WAIT)

    fireEvent.click(await screen.findByRole('button', { name: /New chat/i }, WAIT))
    await waitFor(() => expect(window.sessionStorage.getItem(OPEN_KEY)).toBeNull(), WAIT)
  })

  it('a remembered conversation that is gone: a fresh page, and no error', async () => {
    window.sessionStorage.setItem(OPEN_KEY, 'deleted')
    ;(hostedChatApi.messages as any).mockRejectedValue({ response: { status: 404, data: { message: 'Conversation not found' } } })
    render(<HostedChatPage slug="acme" />)
    await waitFor(() => expect(hostedChatApi.messages).toHaveBeenCalledWith('acme', 'deleted'), WAIT)
    expect(await screen.findByText('How can Acme help?', {}, WAIT)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(streams()).toHaveLength(0)
    await waitFor(() => expect(window.sessionStorage.getItem(OPEN_KEY)).toBeNull(), WAIT)
  })
})
