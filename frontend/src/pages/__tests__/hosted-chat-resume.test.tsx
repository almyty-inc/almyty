import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, screen, fireEvent, waitFor } from '@testing-library/react'

import { render } from '../../test/setup'
import { HostedChatPage } from '../hosted-chat'
import { hostedChatApi, type HostedChatBranding } from '@/lib/hosted-chat'

/**
 * A visitor whose connection drops mid-answer: the page opens the reply's
 * stream again from the last frame it showed, and the reply carries on
 * where it was, with nothing missing and nothing twice (the server's half
 * is hosted-chat-resume.spec.ts). A stream that will not open is tried a
 * few times, then the page reads the transcript, as it always did.
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

// No waiting between attempts here; the delays themselves are the hook's.
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

async function sendMessage(text: string) {
  await screen.findByLabelText('Message')
  await waitFor(() => {
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: text } })
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
}

const streams = () => FakeEventSource.instances
const latest = () => streams()[streams().length - 1]

describe('HostedChatPage: picking a reply up again after the connection drops', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    FakeEventSource.instances = []
    ;(globalThis as any).EventSource = FakeEventSource
    ;(hostedChatApi.branding as any).mockResolvedValue(branding())
    ;(hostedChatApi.conversations as any).mockResolvedValue([])
    ;(hostedChatApi.send as any).mockResolvedValue({ runId: 'run-1', conversationId: 'c1' })
    ;(hostedChatApi.messages as any).mockResolvedValue({
      conversationId: 'c1',
      title: 'Where is my order?',
      messages: [
        { id: 'm1', role: 'user', content: 'Where is my order?', createdAt: '2026-10-28' },
        { id: 'm2', role: 'assistant', content: 'Your order ships Monday.', createdAt: '2026-10-28' },
      ],
    })
  })

  it('reconnects from the last frame shown and the reply carries on, nothing twice', async () => {
    render(<HostedChatPage slug="acme" />)
    await sendMessage('Where is my order?')
    await waitFor(() => expect(streams()).toHaveLength(1))
    expect(hostedChatApi.streamUrl).toHaveBeenLastCalledWith('acme', 'run-1', undefined)

    const first = streams()[0]
    await act(async () => {
      first.emit('token', { content: 'Your ' }, '1730000000000-0.0')
      first.emit('token', { content: 'order ' }, '1730000000000-1.0')
    })
    await waitFor(() => expect(screen.getByText('Your order')).toBeInTheDocument())

    // The connection drops.
    await act(async () => {
      first.onerror?.({})
    })
    await waitFor(() => expect(streams()).toHaveLength(2))
    expect(first.closed).toBe(true)
    expect(hostedChatApi.streamUrl).toHaveBeenLastCalledWith('acme', 'run-1', '1730000000000-1.0')
    // Nothing was reconciled yet: the reply is still coming.
    expect(hostedChatApi.messages).not.toHaveBeenCalled()

    // The server sends what was missed, from that frame on.
    await act(async () => {
      latest().emit('token', { content: 'ships Monday.' }, '1730000000000-2.0')
    })
    await waitFor(() => expect(screen.getByText('Your order ships Monday.')).toBeInTheDocument())

    await act(async () => {
      latest().emit('done', { reason: 'run.completed' })
    })
    await waitFor(() => expect(hostedChatApi.messages).toHaveBeenCalledTimes(1))
    expect(screen.getAllByText('Your order ships Monday.')).toHaveLength(1)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a stream that keeps failing to open is tried a few times, then the page reads the transcript', async () => {
    ;(hostedChatApi.messages as any).mockResolvedValue({
      conversationId: 'c1',
      title: 'Where is my order?',
      messages: [{ id: 'm1', role: 'user', content: 'Where is my order?', createdAt: '2026-10-28' }],
    })
    render(<HostedChatPage slug="acme" />)
    await sendMessage('Where is my order?')
    await waitFor(() => expect(streams()).toHaveLength(1))

    for (let attempt = 1; attempt <= 3; attempt++) {
      const failing = latest()
      await act(async () => {
        failing.onerror?.({})
      })
      await waitFor(() => expect(streams()).toHaveLength(attempt + 1))
    }
    await act(async () => {
      latest().onerror?.({})
    })
    expect(await screen.findByRole('alert')).toHaveTextContent("couldn't reply")
    expect(streams()).toHaveLength(4)
    expect(hostedChatApi.messages).toHaveBeenCalledTimes(1)
  })

  it('a frame that arrives resets the count, so a long reply survives many drops', async () => {
    render(<HostedChatPage slug="acme" />)
    await sendMessage('Where is my order?')
    await waitFor(() => expect(streams()).toHaveLength(1))
    for (let drop = 1; drop <= 6; drop++) {
      const current = latest()
      await act(async () => {
        current.emit('token', { content: `w${drop} ` }, `1730000000000-${drop}.0`)
        current.onerror?.({})
      })
      await waitFor(() => expect(streams()).toHaveLength(drop + 1))
    }
    expect(hostedChatApi.messages).not.toHaveBeenCalled()
    expect(hostedChatApi.streamUrl).toHaveBeenLastCalledWith('acme', 'run-1', '1730000000000-6.0')
  })

  it('the server asking it to wait: the page waits exactly that long, then resumes, and never counts it as a failure', async () => {
    render(<HostedChatPage slug="acme" />)
    await sendMessage('Where is my order?')
    await waitFor(() => expect(streams()).toHaveLength(1))
    await act(async () => {
      streams()[0].emit('token', { content: 'Your ' }, '1730000000000-0.0')
    })

    const timeout = vi.spyOn(globalThis, 'setTimeout')
    try {
      // More waits than the page has reconnect attempts: none of them is a failure.
      for (let wait = 1; wait <= 6; wait++) {
        const limited = latest()
        timeout.mockClear()
        await act(async () => {
          limited.emit('retry', { code: 'VISITOR_RATE_LIMITED', retryAfterMs: 12_000 })
          // The server then ends the stream: no second reconnect on top.
          limited.onerror?.({})
        })
        expect(limited.closed).toBe(true)
        const waits = timeout.mock.calls.filter(([, ms]) => ms === 12_000)
        expect(waits).toHaveLength(1)
        expect(streams()).toHaveLength(wait)
        await act(async () => {
          ;(waits[0][0] as () => void)()
        })
        expect(streams()).toHaveLength(wait + 1)
      }
    } finally {
      timeout.mockRestore()
    }
    // From where it was, and the reply is not given up on.
    expect(hostedChatApi.streamUrl).toHaveBeenLastCalledWith('acme', 'run-1', '1730000000000-0.0')
    expect(hostedChatApi.messages).not.toHaveBeenCalled()
  })

  it('starting a new chat stops the stream: no reconnect after it', async () => {
    // The sidebar, with its New chat button, shows once there is history.
    ;(hostedChatApi.conversations as any).mockResolvedValue([{ id: 'c0', title: 'Earlier chat' }])
    render(<HostedChatPage slug="acme" />)
    await sendMessage('Where is my order?')
    await waitFor(() => expect(streams()).toHaveLength(1))
    const first = streams()[0]
    fireEvent.click(await screen.findByRole('button', { name: /New chat/i }))
    await act(async () => {
      first.onerror?.({})
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(streams()).toHaveLength(1)
    expect(first.closed).toBe(true)
  })
})
