import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentAlwaysOnPage, formFromView, inputFromForm } from '../agent-always-on'
import { agentsApi } from '@/lib/api'
import { agentChannelsApi } from '@/lib/agent-channels'
import { renderAtRoute } from '../../test/render-at-route'

vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

vi.mock('@/lib/api', () => ({
  agentsApi: {
    getById: vi.fn(),
    getAlwaysOn: vi.fn(),
    setAlwaysOn: vi.fn(),
    listWakes: vi.fn().mockResolvedValue([]),
    scheduleDestinations: vi.fn().mockResolvedValue({ webhookUrl: null, channels: [] }),
  },
}))
vi.mock('@/lib/agent-channels', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  agentChannelsApi: { list: vi.fn() },
}))
vi.mock('@/components/channels/channel-page-loader', () => ({
  WithAgent: ({ children }: any) => children({ id: 'a1', name: 'Support agent', status: 'active', mode: 'autonomous' }),
}))
const success = vi.fn()
vi.mock('@/store/app', () => ({ useNotifications: () => ({ success, error: vi.fn() }) }))

const CAP = { timerFloorMinutes: 15, maxWakesPerHour: 6, includedAgents: null }
const TOOLS = [
  { id: 't-read', name: 'list_refunds', readOnly: true },
  { id: 't-write', name: 'issue_refund', readOnly: false },
]
const empty = { alwaysOn: null, capacity: CAP, effectiveTimerMinutes: null, effectiveWakesPerHour: 6, nextWakeAt: null, lastWake: null, queued: 0, liveRunId: null, tools: TOOLS }

describe('the Always on form', () => {
  it('starts off, on a 30-minute timer, asking before anything that changes something', () => {
    const form = formFromView(empty as any)
    expect(form).toMatchObject({ enabled: false, timerOn: true, every: 30, unit: 'minutes', actMode: 'propose' })
    // Ready for "act": what may change something is already on the list.
    expect(form.askFirstToolIds).toEqual(['t-write'])
  })

  it('never offers a timer under the plan floor', () => {
    expect(formFromView({ ...empty, capacity: { ...CAP, timerFloorMinutes: 60 } } as any)).toMatchObject({ every: 1, unit: 'hours' })
    const form = { ...formFromView(empty as any), brief: 'x', every: 5 }
    expect(inputFromForm(form, 15).error).toBe('On your plan the timer can wake it every 15 minutes at most.')
  })

  it('needs instructions and something that wakes it before it can be on', () => {
    const form = { ...formFromView(empty as any), enabled: true }
    expect(inputFromForm(form, 15).error).toBe('Say what it should keep doing.')
    expect(inputFromForm({ ...form, brief: 'x', timerOn: false }, 15).error).toBe('Choose at least one thing that wakes it.')
  })

  it('saves the ask-first list only when it acts on its own', () => {
    const form = { ...formFromView(empty as any), brief: 'x' }
    expect(inputFromForm(form, 15).input!.askFirstToolIds).toEqual([])
    expect(inputFromForm({ ...form, actMode: 'act' }, 15).input!.askFirstToolIds).toEqual(['t-write'])
  })

  it('needs your own address when you talk to it on a channel', () => {
    const form = { ...formFromView(empty as any), brief: 'x', ownerChannelId: 'c-slack' }
    expect(inputFromForm(form, 15).error).toBe('Enter your own address on the channel you talk to it on.')
    expect(inputFromForm({ ...form, ownerAddress: ' U123 ' }, 15).input!.ownerChannel).toEqual({ channelId: 'c-slack', address: 'U123', trustEmail: false })
  })

  it('a daily summary needs a time and a zone, and only then sends them', () => {
    const view = { ...empty, digest: { time: '09:00', timezone: 'UTC' } }
    const form = { ...formFromView(view as any), brief: 'x' }
    // Pre-filled from what the server says the defaults are.
    expect(form).toMatchObject({ digestTime: '09:00', digestTimezone: 'UTC' })
    expect(inputFromForm(form, 15).input).not.toHaveProperty('digest')
    expect(inputFromForm({ ...form, report: 'daily_digest', digestTime: '' }, 15).error).toBe('Choose when the daily summary goes out.')
    expect(inputFromForm({ ...form, report: 'daily_digest' }, 15).input).toMatchObject({ report: 'daily_digest', digest: { time: '09:00', timezone: 'UTC' } })
    // The agent's own setting wins over the defaults.
    const own = formFromView({ ...view, alwaysOn: { enabled: false, brief: 'x', wakeOn: {}, actMode: 'propose', askFirstToolIds: [], report: 'daily_digest', digest: { time: '06:00' } } } as any)
    expect(own).toMatchObject({ report: 'daily_digest', digestTime: '06:00', digestTimezone: 'UTC' })
  })
})

describe('/agents/:id/always-on', () => {
  beforeAll(() => {
    if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
  })
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(agentsApi.getAlwaysOn).mockResolvedValue(empty as any)
    vi.mocked(agentChannelsApi.list).mockResolvedValue([
      { id: 'c-slack', type: 'slack', name: 'Support Slack' },
      { id: 'c-hook', type: 'webhook', name: 'GitHub' },
      { id: 'c-web', type: 'web', name: 'Web chat' },
    ] as any)
  })

  const open = () => renderAtRoute(<AgentAlwaysOnPage />, { path: '/agents/:id/always-on', url: '/agents/a1/always-on', paths: ['/agents/:id'] })

  it('is a page, not a dialog, and offers the agent\'s messaging channels with what each one does', async () => {
    open()
    expect(await screen.findByText('Set up always on')).toBeInTheDocument()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(screen.getAllByText('Support Slack (Slack)').length).toBeGreaterThan(0)
    expect(screen.getByText('People keep their own chats. It is told someone wrote, never what they said.')).toBeInTheDocument()
    expect(screen.getByText('Each delivery wakes it, with what was sent.')).toBeInTheDocument()
    // A web chat is not a channel that wakes it.
    expect(screen.queryByText(/Web chat/)).toBeNull()
    expect(screen.getByTestId('always-on-floor')).toHaveTextContent('every 15 minutes at most')
  })

  it('saves what was set and goes back to the agent', async () => {
    vi.mocked(agentsApi.setAlwaysOn).mockResolvedValue({ ...empty, alwaysOn: { enabled: true } } as any)
    open()
    await userEvent.type(await screen.findByLabelText('Standing instructions'), 'Keep the refund queue moving.')
    await userEvent.click(screen.getByLabelText(/Always on/, { selector: 'button' }))
    await userEvent.click(screen.getByLabelText(/GitHub/))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(agentsApi.setAlwaysOn).toHaveBeenCalled())
    const [, input] = vi.mocked(agentsApi.setAlwaysOn).mock.calls[0]
    expect(input).toMatchObject({
      enabled: true,
      brief: 'Keep the refund queue moving.',
      wakeOn: { timer: { everyMinutes: 30 }, channelIds: ['c-hook'], connectionEvents: [] },
      actMode: 'propose',
      ownerChannel: null,
      reportTo: null,
    })
    expect(await screen.findByText('at /agents/a1')).toBeInTheDocument()
  })

  it('starts the ask-first list with what may change something when it switches to acting on its own', async () => {
    vi.mocked(agentsApi.getAlwaysOn).mockResolvedValue({
      ...empty,
      alwaysOn: { enabled: true, brief: 'x', wakeOn: { timer: { everyMinutes: 30 } }, actMode: 'propose', askFirstToolIds: [], report: 'when_acted' },
    } as any)
    open()
    await userEvent.click(await screen.findByLabelText('On its own, it'))
    await userEvent.click(await screen.findByRole('option', { name: /Does things, and asks you first/ }))
    const list = await screen.findByTestId('always-on-ask-first')
    expect(list).toBeInTheDocument()
    expect(screen.getByLabelText('issue_refund')).toBeChecked()
    expect(screen.getByLabelText(/list_refunds/)).not.toBeChecked()
  })

  it('offers "treat email from my address as me" only for an email channel, off, with why', async () => {
    vi.mocked(agentChannelsApi.list).mockResolvedValue([
      { id: 'c-slack', type: 'slack', name: 'Support Slack' },
      { id: 'c-mail', type: 'email', name: 'Inbox' },
    ] as any)
    vi.mocked(agentsApi.getAlwaysOn).mockResolvedValue({
      ...empty,
      alwaysOn: {
        enabled: true, brief: 'x', wakeOn: { timer: { everyMinutes: 30 } }, actMode: 'propose', askFirstToolIds: [], report: 'when_acted',
        ownerChannel: { channelId: 'c-slack', address: 'U1' },
      },
    } as any)
    vi.mocked(agentsApi.setAlwaysOn).mockResolvedValue(empty as any)
    open()
    await screen.findByText('Talk to it yourself')
    expect(screen.queryByTestId('always-on-trust-email')).toBeNull()
    await userEvent.click(screen.getByLabelText('Channel'))
    await userEvent.click(await screen.findByRole('option', { name: 'Inbox (Email)' }))
    const box = screen.getByLabelText('Treat email from my address as me')
    expect(box).not.toBeChecked()
    expect(screen.getByTestId('always-on-trust-email')).toHaveTextContent("Slack and Teams messages can't be faked this way")
    await userEvent.click(box)
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(agentsApi.setAlwaysOn).toHaveBeenCalled())
    expect(vi.mocked(agentsApi.setAlwaysOn).mock.calls[0][1].ownerChannel).toEqual({ channelId: 'c-mail', address: 'U1', trustEmail: true })
  })

  it('offers a daily summary in the report picker; choosing it asks when, pre-filled with the defaults, and saves them', async () => {
    vi.mocked(agentsApi.getAlwaysOn).mockResolvedValue({
      ...empty,
      digest: { time: '18:30', timezone: 'Europe/Berlin' },
      alwaysOn: { enabled: true, brief: 'x', wakeOn: { timer: { everyMinutes: 30 } }, actMode: 'propose', askFirstToolIds: [], report: 'when_acted' },
    } as any)
    vi.mocked(agentsApi.setAlwaysOn).mockResolvedValue(empty as any)
    open()
    await screen.findByText('Reports')
    expect(screen.queryByTestId('always-on-digest')).toBeNull()
    await userEvent.click(screen.getByLabelText('When'))
    expect(await screen.findByRole('option', { name: 'Only when it did something' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'After every wake' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('option', { name: 'Once a day, a short summary of what it did' }))

    const digest = await screen.findByTestId('always-on-digest')
    expect(screen.getByLabelText('Send the summary at')).toHaveValue('18:30')
    expect(digest).toHaveTextContent('Europe/Berlin')
    expect(digest).toHaveTextContent('A day it did nothing sends nothing.')
    expect(within(digest).getByRole('link', { name: 'Approvals' })).toHaveAttribute('href', '/approvals')
    expect(document.querySelector('[role="dialog"]')).toBeNull()

    await userEvent.clear(screen.getByLabelText('Send the summary at'))
    await userEvent.type(screen.getByLabelText('Send the summary at'), '07:45')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(agentsApi.setAlwaysOn).toHaveBeenCalled())
    expect(vi.mocked(agentsApi.setAlwaysOn).mock.calls[0][1]).toMatchObject({
      report: 'daily_digest',
      digest: { time: '07:45', timezone: 'Europe/Berlin' },
    })
  })

  it('says how many always-on agents the plan includes and how many are on', async () => {
    vi.mocked(agentsApi.getAlwaysOn).mockResolvedValue({ ...empty, capacity: { ...CAP, includedAgents: 3 }, agentsOn: 2 } as any)
    open()
    expect(await screen.findByTestId('always-on-included')).toHaveTextContent('Your plan includes 3 always-on agents; 2 are on.')
  })

  it('says nothing about a count on a plan with no limit', async () => {
    open()
    await screen.findByText('Set up always on')
    expect(screen.queryByTestId('always-on-included')).toBeNull()
  })
})
