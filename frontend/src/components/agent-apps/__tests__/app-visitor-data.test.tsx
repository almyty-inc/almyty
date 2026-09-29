import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '../../../test/setup'
import { AppVisitorData, heldLine } from '../app-visitor-data'
import { visitorDataApi, type VisitorDataSummary } from '@/lib/agent-apps'
import { downloadBlob } from '@/lib/hosted-chat'

vi.mock('@/lib/agent-apps', async () => {
  const actual = await vi.importActual<typeof import('@/lib/agent-apps')>('@/lib/agent-apps')
  return { ...actual, visitorDataApi: { lookup: vi.fn(), export: vi.fn(), erase: vi.fn() } }
})

vi.mock('@/lib/hosted-chat', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hosted-chat')>('@/lib/hosted-chat')
  return { ...actual, downloadBlob: vi.fn() }
})

const app = (distributions: any[]) => ({ slug: 'acme', name: 'Acme', distributions })
const PLACES = [
  { target: 'telegram', status: 'live', gatewayId: 'gw-tg', configuration: {} },
  { target: 'sms', status: 'live', gatewayId: 'gw-sms', configuration: {} },
  { target: 'a2a', status: 'live', gatewayId: 'gw-a2a', configuration: {} },
  // Never published: nobody can have used it.
  { target: 'slack', status: 'draft', gatewayId: null, configuration: {} },
  // A download talks to nobody through us.
  { target: 'desktop', status: 'built', gatewayId: null, configuration: {} },
]

const summary = (over: Partial<VisitorDataSummary> = {}): VisitorDataSummary => ({
  found: true,
  conversations: 2,
  messages: 7,
  firstAt: '2026-09-01T10:00:00.000Z',
  lastAt: '2026-09-20T10:00:00.000Z',
  memories: 1,
  storedReplies: 3,
  files: 0,
  runs: 2,
  recent: [
    { id: 'c1', title: 'Refund for order 1182', messages: 5, firstAt: '2026-09-01T10:00:00.000Z', lastAt: '2026-09-20T10:00:00.000Z' },
    { id: 'c2', title: null, messages: 2, firstAt: '2026-09-02T10:00:00.000Z', lastAt: '2026-09-02T10:05:00.000Z' },
  ],
  ...over,
})

async function lookUp(user: ReturnType<typeof userEvent.setup>, id: string) {
  await user.type(screen.getByLabelText('Telegram user id'), id)
  await user.click(screen.getByRole('button', { name: 'Look up' }))
}

describe('AppVisitorData', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Radix Select reads pointer capture, which jsdom lacks.
    if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
    if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = vi.fn()
    if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = vi.fn()
  })

  it('says nobody can be looked up while the app is on no place that talks to people', () => {
    render(<AppVisitorData app={app(PLACES.slice(3)) as any} />)
    expect(screen.getByText('Nobody can reach this app yet')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Look up' })).not.toBeInTheDocument()
  })

  it('offers only the published places people talk to, and asks for what each knows them by', async () => {
    const user = userEvent.setup()
    render(<AppVisitorData app={app(PLACES) as any} />)

    expect(screen.getByRole('heading', { name: 'Answer a data request' })).toBeInTheDocument()
    expect(screen.getByLabelText('Telegram user id')).toBeInTheDocument()
    expect(screen.getByText('The number Telegram gives their account, not their @name.')).toBeInTheDocument()

    await user.click(screen.getByRole('combobox'))
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent)
    expect(options).toEqual(['Telegram', 'SMS', 'Other agents (A2A)'])
    await user.click(screen.getByRole('option', { name: 'SMS' }))
    expect(screen.getByLabelText('Phone number')).toHaveAttribute('placeholder', '+1 415 555 0100')
    expect(screen.getByText('With the country code. Spaces and dashes do not matter.')).toBeInTheDocument()
  })

  it('looks the person up and shows what is held in counts and dates', async () => {
    const user = userEvent.setup()
    ;(visitorDataApi.lookup as any).mockResolvedValue(summary())
    render(<AppVisitorData app={app(PLACES) as any} />)

    await lookUp(user, '  1001  ')

    expect(visitorDataApi.lookup).toHaveBeenCalledWith('acme', { place: 'telegram', id: '1001' })
    const card = await screen.findByTestId('visitor-data-summary')
    expect(card).toHaveTextContent('What this app holds for 1001 on Telegram')
    expect(within(card).getByText('Conversations').nextSibling).toHaveTextContent('2')
    expect(within(card).getByText('Messages').nextSibling).toHaveTextContent('7')
    expect(within(card).getByText('Memories written for them').nextSibling).toHaveTextContent('1')
    expect(within(card).getByText('Stored replies').nextSibling).toHaveTextContent('3')
    const conversations = within(card).getByRole('list', { name: 'Their conversations' })
    expect(conversations).toHaveTextContent('Refund for order 1182')
    expect(conversations).toHaveTextContent('5 messages')
    expect(conversations).toHaveTextContent('Untitled conversation')
  })

  it('says plainly when nothing is held, with what to check', async () => {
    const user = userEvent.setup()
    ;(visitorDataApi.lookup as any).mockResolvedValue(summary({ found: false, conversations: 0, messages: 0, runs: 0, memories: 0, storedReplies: 0, recent: [] }))
    render(<AppVisitorData app={app(PLACES) as any} />)

    await lookUp(user, '9999')

    expect(await screen.findByTestId('visitor-data-none')).toHaveTextContent('Nothing held for 9999 on Telegram')
    expect(screen.queryByRole('button', { name: 'Delete their data' })).not.toBeInTheDocument()
  })

  it('downloads the data of the person looked up, even after the field changed', async () => {
    const user = userEvent.setup()
    ;(visitorDataApi.lookup as any).mockResolvedValue(summary())
    ;(visitorDataApi.export as any).mockResolvedValue({ conversations: [] })
    render(<AppVisitorData app={app(PLACES) as any} />)

    await lookUp(user, '1001')
    await screen.findByTestId('visitor-data-summary')
    await user.type(screen.getByLabelText('Telegram user id'), '-typo')
    await user.click(screen.getByRole('button', { name: 'Download their data' }))

    await waitFor(() => expect(visitorDataApi.export).toHaveBeenCalledWith('acme', { place: 'telegram', id: '1001' }))
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'acme-telegram-request.json'))
  })

  it('deletes only after the one-line confirm, then says what was removed', async () => {
    const user = userEvent.setup()
    ;(visitorDataApi.lookup as any).mockResolvedValue(summary())
    ;(visitorDataApi.erase as any).mockResolvedValue({ conversations: 2, messages: 7, runs: 2, memories: 1, storedReplies: 3, files: 0, visitors: 0 })
    render(<AppVisitorData app={app(PLACES) as any} />)

    await lookUp(user, '1001')
    await screen.findByTestId('visitor-data-summary')

    await user.click(screen.getByRole('button', { name: 'Delete their data' }))
    const question = await screen.findByRole('alertdialog')
    expect(question).toHaveTextContent("Delete this person's data?")
    expect(question).toHaveTextContent('Everything this app holds for 1001 on Telegram is deleted: 2 conversations, 7 messages, 1 memory, 3 stored replies, 2 runs.')
    await user.click(within(question).getByRole('button', { name: 'Cancel' }))
    expect(visitorDataApi.erase).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Delete their data' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete data' }))

    await waitFor(() => expect(visitorDataApi.erase).toHaveBeenCalledWith('acme', { place: 'telegram', id: '1001' }))
    expect(await screen.findByTestId('visitor-data-erased')).toHaveTextContent(
      'Removed 2 conversations, 7 messages, 1 memory, 3 stored replies, 2 runs for 1001 on Telegram. The deletion is in the audit log.',
    )
    expect(screen.queryByTestId('visitor-data-summary')).not.toBeInTheDocument()
  })

  it('shows the server refusal in words', async () => {
    const user = userEvent.setup()
    ;(visitorDataApi.lookup as any).mockRejectedValue({ response: { data: { error: { message: 'This app is not on that place.' } } } })
    render(<AppVisitorData app={app(PLACES) as any} />)

    await lookUp(user, '1001')

    expect(await screen.findByRole('alert')).toHaveTextContent('This app is not on that place.')
  })
})

describe('heldLine', () => {
  it('counts what is there, with the right plural, and says nothing when empty', () => {
    expect(heldLine({ conversations: 1, messages: 1, memories: 2, files: 1, storedReplies: 1, runs: 1 })).toBe(
      '1 conversation, 1 message, 2 memories, 1 file, 1 stored reply, 1 run',
    )
    expect(heldLine({ conversations: 0, visitors: 1 })).toBe('nothing')
  })
})
