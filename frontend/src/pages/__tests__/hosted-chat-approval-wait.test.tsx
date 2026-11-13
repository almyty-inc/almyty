import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, screen, fireEvent, waitFor } from '@testing-library/react'

import { render } from '../../test/setup'
import { APPROVAL_EXPIRED, APPROVAL_REJECTED, HostedChatPage, WAITING_FOR_APPROVAL } from '../hosted-chat'
import { hostedChatApi, type HostedChatBranding } from '@/lib/hosted-chat'

/**
 * A reply that waits on a person on the team approving one of its steps.
 * The visitor used to see "thinking" dots for as long as that took (up to
 * the approval's expiry, about a day) and then, on a rejection, nothing.
 * The stream now says the run is waiting (`waiting`), that it is working
 * again (`resumed`), or why it stopped (`done` with an approval reason).
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
      streamUrl: vi.fn((_slug: string, runId: string) => `http://localhost/stream?runId=${runId}`),
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

const asked = { id: 'm1', role: 'user', content: 'Refund order 42', createdAt: '2026-11-13' }
const answered = { id: 'm2', role: 'assistant', content: 'Refunded.', createdAt: '2026-11-13' }
const stream = () => FakeEventSource.instances[FakeEventSource.instances.length - 1]

async function sendAndWait() {
  render(<HostedChatPage slug="acme" />)
  fireEvent.change(await screen.findByLabelText('Message', {}, WAIT), { target: { value: 'Refund order 42' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1), WAIT)
  await act(async () => {
    stream().emit('waiting', { for: 'approval' })
  })
  await waitFor(() => expect(screen.getByText(WAITING_FOR_APPROVAL)).toBeInTheDocument(), WAIT)
  expect(screen.queryByLabelText('Thinking')).toBeNull()
}

describe('HostedChatPage: a reply waiting for a person to approve a step', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    FakeEventSource.instances = []
    ;(globalThis as any).EventSource = FakeEventSource
    ;(hostedChatApi.branding as any).mockResolvedValue(branding())
    ;(hostedChatApi.conversations as any).mockResolvedValue([])
    ;(hostedChatApi.send as any).mockResolvedValue({ runId: 'run-1', conversationId: 'c1' })
  })

  it('says it is waiting, then carries on with the reply once approved', async () => {
    ;(hostedChatApi.messages as any).mockResolvedValue({ conversationId: 'c1', title: 'Refund', messages: [asked, answered], openRunId: null })
    await sendAndWait()

    await act(async () => {
      stream().emit('resumed', { after: 'approval' })
    })
    await waitFor(() => expect(screen.queryByText(WAITING_FOR_APPROVAL)).toBeNull(), WAIT)
    expect(screen.getByLabelText('Thinking')).toBeInTheDocument()

    await act(async () => {
      stream().emit('token', { content: 'Refunded.' }, '1-0.0')
      stream().emit('done', { reason: 'run.completed' })
    })
    await waitFor(() => expect(screen.getByText('Refunded.')).toBeInTheDocument(), WAIT)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says plainly when the step was turned down', async () => {
    ;(hostedChatApi.messages as any).mockResolvedValue({ conversationId: 'c1', title: 'Refund', messages: [asked], openRunId: null })
    await sendAndWait()
    await act(async () => {
      stream().emit('done', { reason: 'approval.rejected' })
    })
    expect(await screen.findByText(APPROVAL_REJECTED, {}, WAIT)).toBeInTheDocument()
    expect(screen.queryByText(WAITING_FOR_APPROVAL)).toBeNull()
  })

  it('says plainly when nobody approved in time', async () => {
    ;(hostedChatApi.messages as any).mockResolvedValue({ conversationId: 'c1', title: 'Refund', messages: [asked], openRunId: null })
    await sendAndWait()
    await act(async () => {
      stream().emit('done', { reason: 'approval.expired' })
    })
    expect(await screen.findByText(APPROVAL_EXPIRED, {}, WAIT)).toBeInTheDocument()
  })
})
