import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest'
import { configure, screen, fireEvent, waitFor } from '@testing-library/react'

import { render } from '../../test/setup'
import { HostedChatPage } from '../hosted-chat'
import {
  downloadBlob,
  hostedChatApi,
  reloadAfterVisitorDeletion,
  type HostedChatBranding,
} from '@/lib/hosted-chat'

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

// jsdom has no EventSource; the streaming path only needs to not explode.
//
// Each instance records the test it was opened during. A component whose
// send() is still in flight when a test ends goes on to open its stream
// during the NEXT test, and `instances[0]` then points at a stream nobody
// is watching: emitting on it does nothing and the test times out five
// seconds later with no clue why. So a test asks for the stream IT
// opened, and waits for it, rather than taking whatever is first.
class FakeEventSource {
  static instances: FakeEventSource[] = []
  listeners: Record<string, (event: any) => void> = {}
  onerror: ((event: any) => void) | null = null
  readonly bornIn = currentTest()
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

function currentTest(): string {
  return (expect as any).getState?.()?.currentTestName ?? 'unknown'
}

/** The stream this test opened, once the page has opened it. */
async function openedStream(): Promise<FakeEventSource> {
  const mine = () => FakeEventSource.instances.filter((s) => s.bornIn === currentTest())
  await waitFor(() => expect(mine().length).toBeGreaterThan(0))
  const own = mine()
  return own[own.length - 1]
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
  visitorCanDelete: true,
  visitorCanExport: true,
  ...overrides,
})

describe('HostedChatPage', () => {
  // This file renders the heaviest page in the suite (full chat shell,
  // sidebar, markdown) 28 times, and every assertion sits behind a
  // mocked promise chain. The library defaults -- 5s a test, 1s an async
  // query -- are comfortable when this file runs alone and are not when
  // four workers share the machine, which is why it failed roughly one
  // full run in three while passing on its own every time.
  //
  // Measured rather than assumed: across five instrumented full runs no
  // test ever saw more than one EventSource, so nothing was leaking
  // between tests, and the failing assertion moved from one test to
  // another. That is a wall-clock budget, not a race in the page.
  const budgets = { testTimeout: 20_000, asyncUtil: 5_000 }
  beforeAll(() => {
    vi.setConfig({ testTimeout: budgets.testTimeout })
    configure({ asyncUtilTimeout: budgets.asyncUtil })
  })
  afterAll(() => {
    vi.resetConfig()
    configure({ asyncUtilTimeout: 1_000 })
  })

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
    ;(hostedChatApi.deleteConversation as any).mockResolvedValue({})
    ;(hostedChatApi.deleteMe as any).mockResolvedValue({})
    ;(hostedChatApi.exportData as any).mockResolvedValue({
      blob: new Blob(['{}'], { type: 'application/json' }),
      filename: 'acme-my-data.json',
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

  it('hides visitor-data controls when the tenant disabled both rights', async () => {
    ;(hostedChatApi.branding as any).mockResolvedValue(
      branding({ visitorCanDelete: false, visitorCanExport: false }),
    )
    render(<HostedChatPage slug="acme" />)

    await screen.findByLabelText('Message')
    expect(screen.queryByRole('button', { name: /Privacy and visitor data/i })).toBeNull()
  })

  it('downloads the visitor export without navigating away from the chat', async () => {
    ;(hostedChatApi.branding as any).mockResolvedValue(branding())
    render(<HostedChatPage slug="acme" />)

    fireEvent.pointerDown(await screen.findByRole('button', { name: /Privacy and visitor data/i }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Download my data/i }))

    await waitFor(() => expect(hostedChatApi.exportData).toHaveBeenCalledWith('acme'))
    expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'acme-my-data.json')
  })

  it('deletes only the selected conversation after confirmation', async () => {
    ;(hostedChatApi.branding as any).mockResolvedValue(branding())
    ;(hostedChatApi.conversations as any).mockResolvedValue([
      { id: 'c1', title: 'Order 123', createdAt: '2026-01-01' },
    ])
    ;(hostedChatApi.messages as any).mockResolvedValue({
      conversationId: 'c1',
      title: 'Order 123',
      messages: [{ id: 'm1', role: 'user', content: 'Where is it?', createdAt: '2026-01-01' }],
    })
    render(<HostedChatPage slug="acme" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Order 123' }))
    await screen.findByText('Where is it?')
    fireEvent.pointerDown(screen.getByRole('button', { name: /Privacy and visitor data/i }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Delete this conversation/i }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete conversation' }))

    await waitFor(() =>
      expect(hostedChatApi.deleteConversation).toHaveBeenCalledWith('acme', 'c1'),
    )
    expect(hostedChatApi.deleteMe).not.toHaveBeenCalled()
  })

  it('deletes the whole visitor record and reloads with a fresh identity', async () => {
    ;(hostedChatApi.branding as any).mockResolvedValue(branding())
    render(<HostedChatPage slug="acme" />)

    fireEvent.pointerDown(await screen.findByRole('button', { name: /Privacy and visitor data/i }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Delete everything about me/i }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete my data' }))

    await waitFor(() => expect(hostedChatApi.deleteMe).toHaveBeenCalledWith('acme'))
    expect(reloadAfterVisitorDeletion).toHaveBeenCalled()
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

    const source = await openedStream()
    source.emit('token', { token: 'hi ' })
    source.emit('done', { reason: 'run.completed' })

    // The transcript is the source of truth, so the finished reply
    // replaces whatever the stream accumulated.
    expect(await screen.findByText('hi there')).toBeInTheDocument()
  })

  it('tells the visitor when the run failed instead of going quiet', async () => {
    ;(hostedChatApi.branding as any).mockResolvedValue(branding())
    ;(hostedChatApi.send as any).mockResolvedValue({ runId: 'run-1', conversationId: 'c1' })
    // A failed run persists only the visitor's turn.
    ;(hostedChatApi.messages as any).mockResolvedValue({
      conversationId: 'c1',
      title: 'New chat',
      messages: [{ id: 'm1', role: 'user', content: 'hello', createdAt: '2026-01-01' }],
    })

    render(<HostedChatPage slug="acme" />)
    fireEvent.change(await screen.findByLabelText('Message'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(hostedChatApi.send).toHaveBeenCalled())

    ;(await openedStream()).emit('done', { reason: 'run.failed' })

    expect(await screen.findByRole('alert')).toHaveTextContent("The assistant couldn't reply just now")
    // The visitor's own turn stays: it was delivered, the reply is what failed.
    expect(screen.getByText('hello')).toBeInTheDocument()
  })

  it('flags an unanswered turn even when the stream ends without a reason', async () => {
    ;(hostedChatApi.branding as any).mockResolvedValue(branding())
    ;(hostedChatApi.send as any).mockResolvedValue({ runId: 'run-1', conversationId: 'c1' })
    ;(hostedChatApi.messages as any).mockResolvedValue({
      conversationId: 'c1',
      title: 'New chat',
      messages: [{ id: 'm1', role: 'user', content: 'hello', createdAt: '2026-01-01' }],
    })

    render(<HostedChatPage slug="acme" />)
    fireEvent.change(await screen.findByLabelText('Message'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(hostedChatApi.send).toHaveBeenCalled())

    ;(await openedStream()).emit('done', { reason: 'stream_ended' })

    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })

  it('shows no error when the run completed with a reply', async () => {
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
    fireEvent.change(await screen.findByLabelText('Message'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(hostedChatApi.send).toHaveBeenCalled())

    ;(await openedStream()).emit('done', { reason: 'run.completed' })

    expect(await screen.findByText('hi there')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('renders safe Markdown in assistant replies while leaving visitor text literal', async () => {
    ;(hostedChatApi.branding as any).mockResolvedValue(branding())
    ;(hostedChatApi.send as any).mockResolvedValue({ runId: 'run-1', conversationId: 'c1' })
    ;(hostedChatApi.messages as any).mockResolvedValue({
      conversationId: 'c1',
      title: 'New chat',
      messages: [
        { id: 'm1', role: 'user', content: '**literal**', createdAt: '2026-01-01' },
        {
          id: 'm2',
          role: 'assistant',
          content: '**Documentation**\n\n1. Read the [guide](https://example.com).',
          createdAt: '2026-01-01',
        },
      ],
    })

    render(<HostedChatPage slug="acme" />)
    fireEvent.change(await screen.findByLabelText('Message'), {
      target: { value: '**literal**' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(hostedChatApi.send).toHaveBeenCalled())
    ;(await openedStream()).emit('done', { reason: 'run.completed' })

    expect(await screen.findByText('Documentation')).toHaveProperty('tagName', 'STRONG')
    expect(screen.getByText('**literal**')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'guide' })).toHaveAttribute(
      'rel',
      'noopener noreferrer',
    )
  })

  it('does not render raw HTML from assistant replies', async () => {
    ;(hostedChatApi.branding as any).mockResolvedValue(branding())
    ;(hostedChatApi.send as any).mockResolvedValue({ runId: 'run-1', conversationId: 'c1' })
    ;(hostedChatApi.messages as any).mockResolvedValue({
      conversationId: 'c1',
      title: 'New chat',
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content:
            '<img src=x onerror="alert(1)"><script>alert(1)</script>Safe [link](javascript:alert(1))',
          createdAt: '2026-01-01',
        },
      ],
    })

    render(<HostedChatPage slug="acme" />)
    fireEvent.change(await screen.findByLabelText('Message'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(hostedChatApi.send).toHaveBeenCalled())
    ;(await openedStream()).emit('done', { reason: 'run.completed' })

    expect(await screen.findByText(/Safe/)).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('script')).toBeNull()
    expect(screen.getByText('link').closest('a')).toHaveAttribute('href', '')
  })

  it('surfaces a rate limit in words a visitor understands', async () => {
    ;(hostedChatApi.branding as any).mockResolvedValue(branding())
    ;(hostedChatApi.send as any).mockRejectedValue({ response: { status: 429 } })

    render(<HostedChatPage slug="acme" />)
    fireEvent.change(await screen.findByLabelText('Message'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/busy right now/)
  })

  it('tells a visitor when it is their own share that ran out, not the assistant', async () => {
    ;(hostedChatApi.branding as any).mockResolvedValue(branding())
    ;(hostedChatApi.send as any).mockRejectedValue({
      response: { status: 429, data: { error: { code: 'VISITOR_RATE_LIMITED', message: 'Too many messages from you (60 per hour). Please wait 40 seconds.' } } },
    })

    render(<HostedChatPage slug="acme" />)
    fireEvent.change(await screen.findByLabelText('Message'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many messages from you (60 per hour). Please wait 40 seconds.')
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

  it('reconciles once even when done and onerror both fire', async () => {
    ;(hostedChatApi.branding as any).mockResolvedValue(branding())
    ;(hostedChatApi.send as any).mockResolvedValue({ runId: 'run-1', conversationId: 'c1' })
    ;(hostedChatApi.messages as any).mockResolvedValue({
      conversationId: 'c1',
      title: 'New chat',
      messages: [{ id: 'm1', role: 'user', content: 'hello', createdAt: '2026-01-01' }],
    })

    render(<HostedChatPage slug="acme" />)
    fireEvent.change(await screen.findByLabelText('Message'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(hostedChatApi.send).toHaveBeenCalled())

    const source = (await openedStream()) as any
    source.emit('done', { reason: 'run.failed' })
    source.onerror?.()
    source.emit('done', { reason: 'run.failed' })

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    // One transcript reconcile for the send; the branding/conversation
    // loads do not go through messages().
    expect(hostedChatApi.messages).toHaveBeenCalledTimes(1)
  })

  it('still tells the visitor something went wrong when the transcript fetch itself fails', async () => {
    ;(hostedChatApi.branding as any).mockResolvedValue(branding())
    ;(hostedChatApi.send as any).mockResolvedValue({ runId: 'run-1', conversationId: 'c1' })
    ;(hostedChatApi.messages as any).mockRejectedValue(new Error('network down'))

    render(<HostedChatPage slug="acme" />)
    fireEvent.change(await screen.findByLabelText('Message'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(hostedChatApi.send).toHaveBeenCalled())

    ;(await openedStream()).emit('done', { reason: 'run.completed' })

    expect(await screen.findByRole('alert')).toHaveTextContent("couldn't reply")
    // The visitor's turn survives; only the empty streaming placeholder goes.
    expect(screen.getByText('hello')).toBeInTheDocument()
  })

  describe('surfaces that require sign-in', () => {
    it('never asks who the visitor is on a public-link surface', async () => {
      ;(hostedChatApi.branding as any).mockResolvedValue(branding())
      render(<HostedChatPage slug="acme" />)
      await screen.findByLabelText('Message')
      expect(hostedChatApi.me).not.toHaveBeenCalled()
    })

    it('shows a tenant-branded SSO sign-in instead of the composer until the visitor is signed in', async () => {
      ;(hostedChatApi.branding as any).mockResolvedValue(branding({ authMode: 'sso' }))
      ;(hostedChatApi.me as any).mockResolvedValue({ authMode: 'sso', available: true, authenticated: false, email: null, displayName: null })

      render(<HostedChatPage slug="acme" />)

      expect(await screen.findByRole('heading', { name: 'Sign in to Acme Assistant' })).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Continue with single sign-on' })).toHaveAttribute('href', '/api/public/chat/acme/auth/sso/login')
      expect(screen.queryByLabelText('Message')).toBeNull()
      expect(hostedChatApi.conversations).not.toHaveBeenCalled()
    })

    it('opens the chat once the backend says the visitor is signed in', async () => {
      ;(hostedChatApi.branding as any).mockResolvedValue(branding({ authMode: 'sso' }))
      ;(hostedChatApi.me as any).mockResolvedValue({ authMode: 'sso', available: true, authenticated: true, email: 'ava@northwind.example', displayName: 'Ava' })

      render(<HostedChatPage slug="acme" />)

      expect(await screen.findByLabelText('Message')).toBeInTheDocument()
      expect(screen.queryByRole('heading', { name: /Sign in to/ })).toBeNull()
    })

    it('says the surface is closed when its organization cannot offer the sign-in method', async () => {
      ;(hostedChatApi.branding as any).mockResolvedValue(branding({ authMode: 'sso' }))
      ;(hostedChatApi.me as any).mockResolvedValue({ authMode: 'sso', available: false, authenticated: false, email: null, displayName: null })

      render(<HostedChatPage slug="acme" />)

      expect(await screen.findByText(/not accepting sign-ins right now/)).toBeInTheDocument()
      expect(screen.queryByRole('link', { name: /single sign-on/ })).toBeNull()
    })

    it('is honest about a sign-in method that is not built yet', async () => {
      ;(hostedChatApi.branding as any).mockResolvedValue(branding({ authMode: 'email_otp' }))
      ;(hostedChatApi.me as any).mockResolvedValue({ authMode: 'email_otp', available: true, authenticated: false, email: null, displayName: null })

      render(<HostedChatPage slug="acme" />)

      expect(await screen.findByText(/not set up yet/)).toBeInTheDocument()
    })
  })
})
