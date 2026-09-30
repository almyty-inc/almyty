import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor, within } from '@testing-library/react'

import { render } from '../../test/setup'
import { HostedChatPage } from '../hosted-chat'
import { hostedChatApi, type HostedChatBranding } from '@/lib/hosted-chat'

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => children,
}))

vi.mock('@/lib/hosted-chat', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hosted-chat')>('@/lib/hosted-chat')
  return {
    ...actual,
    hostedChatApi: {
      branding: vi.fn(),
      conversations: vi.fn(),
      messages: vi.fn(),
      send: vi.fn(),
      uploadAttachment: vi.fn(),
      streamUrl: vi.fn(() => 'http://localhost/stream'),
      me: vi.fn(),
    },
    downloadBlob: vi.fn(),
    reloadAfterVisitorDeletion: vi.fn(),
  }
})

class QuietEventSource {
  addEventListener() {}
  close() {}
}

const branding: HostedChatBranding = {
  appName: 'Acme Assistant',
  primaryColor: '#8b5cf6',
  greeting: 'How can Acme help?',
  theme: 'auto',
  logoUrl: null,
  suggestedPrompts: [],
  authMode: 'public_link',
  whiteLabel: false,
  aiDisclosure: null,
  visitorCanDelete: false,
  visitorCanExport: false,
} as HostedChatBranding

const file = (name: string, type: string, size = 64) => new File([new Uint8Array(size)], name, { type })

async function pick(...files: File[]) {
  const input = await screen.findByTestId('attachment-input')
  fireEvent.change(input, { target: { files } })
}

/**
 * Sending files from the web chat: each file is uploaded as it is picked,
 * shown above the composer, and named by id when the message is sent. The
 * API client is mocked; the page and its hook are the real ones.
 */
describe('HostedChatPage attachments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(globalThis as any).EventSource = QuietEventSource
    ;(hostedChatApi.branding as any).mockResolvedValue(branding)
    ;(hostedChatApi.conversations as any).mockResolvedValue([])
    ;(hostedChatApi.send as any).mockResolvedValue({ runId: 'run-1', conversationId: 'c1' })
  })

  it('uploads a picked file, shows it, and sends it by id with the message', async () => {
    ;(hostedChatApi.uploadAttachment as any).mockResolvedValue({ id: 'up-1', name: 'box.png', mimeType: 'image/png', size: 64 })
    render(<HostedChatPage slug="acme" />)

    await pick(file('box.png', 'image/png'))
    const chips = await screen.findByRole('list', { name: 'Attached files' })
    expect(within(chips).getByText('box.png')).toBeInTheDocument()
    expect(hostedChatApi.uploadAttachment).toHaveBeenCalledWith('acme', expect.any(File))

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Is this damaged?' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(hostedChatApi.send).toHaveBeenCalledWith('acme', 'Is this damaged?', undefined, ['up-1']))
    // Sent: the composer is empty of files again, and the turn names the file.
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Attached files' })).toBeNull())
    expect(await screen.findByText(/\[Attachment: box\.png\]/)).toBeInTheDocument()
  })

  it('sends a file on its own, with no text', async () => {
    ;(hostedChatApi.uploadAttachment as any).mockResolvedValue({ id: 'up-2', name: 'invoice.pdf', mimeType: 'application/pdf', size: 64 })
    render(<HostedChatPage slug="acme" />)
    await pick(file('invoice.pdf', 'application/pdf'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(hostedChatApi.send).toHaveBeenCalledWith('acme', '', undefined, ['up-2']))
  })

  it('waits for an upload still running before it lets the message go', async () => {
    let finish!: (value: unknown) => void
    ;(hostedChatApi.uploadAttachment as any).mockReturnValue(new Promise((resolve) => (finish = resolve)))
    render(<HostedChatPage slug="acme" />)

    await pick(file('box.png', 'image/png'))
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'look' } })
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()

    finish({ id: 'up-3', name: 'box.png', mimeType: 'image/png', size: 64 })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled())
  })

  it('tells the visitor why a file was refused, and sends without it', async () => {
    ;(hostedChatApi.uploadAttachment as any).mockRejectedValue({
      response: { status: 400, data: { message: 'Only images (PNG, JPEG, GIF, WebP), PDFs and text files can be sent.' } },
    })
    render(<HostedChatPage slug="acme" />)

    await pick(file('clip.mov', 'video/quicktime'))
    expect(await screen.findByText(/Only images \(PNG, JPEG, GIF, WebP\), PDFs and text files can be sent\./)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hi' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(hostedChatApi.send).toHaveBeenCalledWith('acme', 'hi', undefined, []))
  })

  it('refuses a file over 10 MB without uploading it, and a sixth file', async () => {
    ;(hostedChatApi.uploadAttachment as any).mockImplementation(async (_slug: string, f: File) => ({ id: f.name, name: f.name, mimeType: 'image/png', size: 1 }))
    render(<HostedChatPage slug="acme" />)

    await pick(file('huge.png', 'image/png', 10 * 1024 * 1024 + 1))
    expect(await screen.findByText(/Larger than 10 MB/)).toBeInTheDocument()
    expect(hostedChatApi.uploadAttachment).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Remove huge.png' }))
    await pick(...['1', '2', '3', '4', '5', '6'].map((n) => file(`${n}.png`, 'image/png')))
    expect(await screen.findByText(/Up to 5 files per message/)).toBeInTheDocument()
    expect(hostedChatApi.uploadAttachment).toHaveBeenCalledTimes(5)
  })

  it('takes a file back before sending', async () => {
    ;(hostedChatApi.uploadAttachment as any).mockResolvedValue({ id: 'up-4', name: 'box.png', mimeType: 'image/png', size: 64 })
    render(<HostedChatPage slug="acme" />)
    await pick(file('box.png', 'image/png'))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove box.png' }))
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'never mind' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(hostedChatApi.send).toHaveBeenCalledWith('acme', 'never mind', undefined, []))
  })
})
