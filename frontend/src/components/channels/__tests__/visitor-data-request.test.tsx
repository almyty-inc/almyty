import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'fs'
import { join } from 'path'

import { render } from '../../../test/setup'
import { VisitorDataRequestPage, heldLine } from '../visitor-data-request'
import type { AgentChannel, VisitorDataSummary } from '@/lib/agent-channels'

vi.mock('@/lib/agent-channels', async () => {
  const actual = await vi.importActual<typeof import('@/lib/agent-channels')>('@/lib/agent-channels')
  return { ...actual, visitorDataApi: { lookup: vi.fn(), export: vi.fn(), erase: vi.fn() } }
})
vi.mock('@/lib/hosted-chat', () => ({ downloadBlob: vi.fn() }))

import { visitorDataApi } from '@/lib/agent-channels'
import { downloadBlob } from '@/lib/hosted-chat'

const agent = { id: 'agent-1', name: 'Front desk' }

const channel = (over: Partial<AgentChannel>): AgentChannel =>
  ({
    id: 'c-1',
    agentId: 'agent-1',
    type: 'web',
    status: 'live',
    name: 'Web chat',
    slug: null,
    gatewayId: 'gw-1',
    endpoint: '/channels/c-1',
    branding: null,
    visitorRules: null,
    effective: {} as any,
    ...over,
  }) as AgentChannel

const channels = [
  channel({ id: 'c-web', type: 'web', name: 'Web chat', gatewayId: 'gw-web' }),
  channel({ id: 'c-wa', type: 'whatsapp', name: 'WhatsApp', gatewayId: 'gw-wa' }),
  channel({ id: 'c-slack', type: 'slack', name: 'Support Slack', gatewayId: 'gw-slack' }),
  // Never published: nobody can have talked to it.
  channel({ id: 'c-tg', type: 'telegram', name: 'Telegram', gatewayId: null }),
  // A download keeps nothing of its own.
  channel({ id: 'c-desk', type: 'desktop', name: 'Desktop app', gatewayId: 'gw-desk' }),
]

const summary: VisitorDataSummary = {
  found: true,
  conversations: 2,
  messages: 9,
  firstAt: '2026-09-01T10:00:00.000Z',
  lastAt: '2026-09-20T10:00:00.000Z',
  memories: 1,
  files: 2,
  storedReplies: 3,
  unanswered: 4,
  runs: 2,
  recent: [
    { id: 'conv-2', title: 'Refund for order 4411', messages: 5, firstAt: '2026-09-20T09:00:00.000Z', lastAt: '2026-09-20T10:00:00.000Z' },
    { id: 'conv-1', title: null, messages: 4, firstAt: '2026-09-01T10:00:00.000Z', lastAt: '2026-09-01T10:05:00.000Z' },
  ],
  channels: [{ id: 'c-wa', name: 'WhatsApp', type: 'whatsapp' }],
}

beforeEach(() => {
  vi.mocked(visitorDataApi.lookup).mockReset().mockResolvedValue(summary)
  vi.mocked(visitorDataApi.export).mockReset().mockResolvedValue({ conversations: [] })
  vi.mocked(visitorDataApi.erase).mockReset().mockResolvedValue({
    conversations: 2, messages: 9, runs: 2, toolCalls: 1, memories: 1, files: 2, storedReplies: 3, unanswered: 1, visitors: 0, memoriesPending: 0,
  })
  vi.mocked(downloadBlob).mockReset()
  // What Radix Select asks of the DOM, which jsdom does not have.
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
  if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = vi.fn()
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = vi.fn()
})

/**
 * The owner's answer to one person's data request: who they are and where,
 * what the agent keeps about them, their copy, and the deletion.
 */
describe('VisitorDataRequestPage', () => {
  it('looks on every channel unless the owner picks one, and only offers channels people talk to', async () => {
    const user = userEvent.setup()
    render(<VisitorDataRequestPage agent={agent} channels={channels} />)

    const where = screen.getByRole('combobox', { name: 'Where they talked to the agent' })
    expect(where).toHaveTextContent('All channels')
    await user.click(where)
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent)
    // Each by the name the owner gave it, unique among the agent's channels.
    expect(options).toEqual(['All channels', 'Web chat', 'WhatsApp', 'Support Slack'])
    await user.click(screen.getByRole('option', { name: 'All channels' }))

    await user.type(screen.getByLabelText(/Their email address, phone number or id/), ' dana@example.com ')
    await user.click(screen.getByRole('button', { name: 'Look up' }))

    await waitFor(() => expect(visitorDataApi.lookup).toHaveBeenCalledWith('agent-1', { id: 'dana@example.com' }))
  })

  it('asks for what the picked channel knows the person by', async () => {
    const user = userEvent.setup()
    render(<VisitorDataRequestPage agent={agent} channels={channels} />)
    await user.click(screen.getByRole('combobox', { name: 'Where they talked to the agent' }))
    await user.click(await screen.findByRole('option', { name: 'WhatsApp' }))

    const phone = screen.getByLabelText(/Their phone number/)
    expect(screen.getByText('With the country code. Spaces and dashes do not matter.')).toBeInTheDocument()
    await user.type(phone, '+1 415 555 0100')
    await user.click(screen.getByRole('button', { name: 'Look up' }))
    await waitFor(() => expect(visitorDataApi.lookup).toHaveBeenCalledWith('agent-1', { id: '+1 415 555 0100', channelId: 'c-wa' }))
  })

  it('refuses to look up nobody', async () => {
    const user = userEvent.setup()
    render(<VisitorDataRequestPage agent={agent} channels={channels} />)
    await user.click(screen.getByRole('button', { name: 'Look up' }))
    expect(await screen.findByText('Say who to look up.')).toBeInTheDocument()
    expect(visitorDataApi.lookup).not.toHaveBeenCalled()
  })

  it('shows what is kept in counts and dates, with their conversations in a table', async () => {
    const user = userEvent.setup()
    render(<VisitorDataRequestPage agent={agent} channels={channels} />)
    await user.type(screen.getByRole('textbox'), 'dana@example.com')
    await user.click(screen.getByRole('button', { name: 'Look up' }))

    expect(await screen.findByText('What Front desk keeps about dana@example.com')).toBeInTheDocument()
    expect(screen.getByTestId('visitor-data-found-on')).toHaveTextContent('WhatsApp')
    const counts = screen.getByTestId('visitor-data-summary')
    expect(counts).toHaveTextContent('Conversations2')
    expect(counts).toHaveTextContent('Messages9')
    expect(counts).toHaveTextContent('Memories1')
    expect(counts).toHaveTextContent('Files2')
    // Messages the agent never answered (over a limit, refused) are theirs too.
    expect(counts).toHaveTextContent('Messages not answered4')
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1)
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/^Refund for order 44115/),
      expect.stringMatching(/^Untitled conversation4/),
    ])
  })

  it('downloads exactly the person who was looked up, even after the field changes', async () => {
    const user = userEvent.setup()
    render(<VisitorDataRequestPage agent={agent} channels={channels} />)
    await user.type(screen.getByRole('textbox'), 'dana@example.com')
    await user.click(screen.getByRole('button', { name: 'Look up' }))
    await screen.findByText('What Front desk keeps about dana@example.com')

    await user.type(screen.getByRole('textbox'), 'xx')
    await user.click(screen.getByRole('button', { name: /Download their data/ }))
    await waitFor(() => expect(visitorDataApi.export).toHaveBeenCalledWith('agent-1', { id: 'dana@example.com' }))
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'data-request.json'))
  })

  it('deletes only after a one-line confirm, then says what went', async () => {
    const user = userEvent.setup()
    render(<VisitorDataRequestPage agent={agent} channels={channels} />)
    await user.type(screen.getByRole('textbox'), 'dana@example.com')
    await user.click(screen.getByRole('button', { name: 'Look up' }))
    await screen.findByText('What Front desk keeps about dana@example.com')

    await user.click(screen.getByRole('button', { name: /Delete their data/ }))
    const confirm = await screen.findByRole('alertdialog')
    expect(within(confirm).getByText("Delete this person's data?")).toBeInTheDocument()
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    expect(visitorDataApi.erase).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: /Delete their data/ }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete their data' }))
    await waitFor(() => expect(visitorDataApi.erase).toHaveBeenCalledWith('agent-1', { id: 'dana@example.com' }))
    expect(await screen.findByTestId('visitor-data-erased')).toHaveTextContent(
      'Removed 2 conversations, 9 messages, 1 memory, 2 files, 3 saved replies, 1 message not answered, 2 runs for dana@example.com',
    )
  })

  it('says plainly when nothing is kept', async () => {
    vi.mocked(visitorDataApi.lookup).mockResolvedValue({ ...summary, found: false, recent: [], channels: [] })
    const user = userEvent.setup()
    render(<VisitorDataRequestPage agent={agent} channels={channels} />)
    await user.type(screen.getByRole('textbox'), 'nobody@example.com')
    await user.click(screen.getByRole('button', { name: 'Look up' }))
    expect(await screen.findByText('Nothing kept for nobody@example.com')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Delete their data/ })).toBeNull()
  })

  it('has nothing to look up on an agent nobody can talk to', () => {
    render(<VisitorDataRequestPage agent={agent} channels={[channels[4]]} />)
    expect(screen.getByText('Nobody can talk to this agent yet')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Look up' })).toBeNull()
  })

  it('counts in plain words', () => {
    expect(heldLine({ conversations: 1, messages: 2, memories: 2, files: 0 })).toBe('1 conversation, 2 messages, 2 memories')
    expect(heldLine({})).toBe('nothing')
  })

  it('never says "app", "place" or "distribution" to the user', () => {
    const source = readFileSync(join(__dirname, '..', 'visitor-data-request.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(source).not.toMatch(/['">][^'"<]*\b(places?|distributions?|apps?)\b/i)
  })
})
