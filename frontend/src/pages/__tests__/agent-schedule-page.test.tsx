import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderAtRoute } from '../../test/render-at-route'

/**
 * /agents/:id/schedule: a time of day on chosen days, a day of the month or
 * every few minutes, in a time zone that starts as the person's own, and
 * "Send the result to" one of the agent's channels. What the page sends is
 * what the scheduler stores.
 */
vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

vi.mock('../../lib/api', () => ({
  agentsApi: {
    getById: vi.fn(),
    schedule: vi.fn(),
    previewSchedule: vi.fn(),
    scheduleDestinations: vi.fn(),
  },
  authApi: { getProfile: vi.fn() },
}))

const notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('../../store/app', () => ({ useNotifications: () => notify }))
// The JSON editor is CodeMirror, which needs a layout jsdom does not do.
vi.mock('../../components/ui/code-editor', () => ({
  CodeEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="Input JSON" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}))

import { agentsApi, authApi } from '../../lib/api'
import { AgentSchedulePage } from '../agent-schedule'

const api = agentsApi as unknown as Record<string, ReturnType<typeof vi.fn>>

const agent = (settings: Record<string, any> = {}) => ({
  id: 'a1',
  name: 'Morning report',
  status: 'active',
  mode: 'workflow',
  settings,
  webhookUrl: null,
})

const SLACK = {
  channelId: 'ch-slack',
  name: 'Sales Slack',
  type: 'slack',
  available: true,
  noun: 'Slack channel',
  choose: 'pick_or_enter',
  placeholder: 'C0123ABCDEF',
  hint: 'The bot has to be in the channel.',
  destinations: [{ to: 'C0123ABCDEF', label: '#sales' }],
}
const EMAIL = {
  channelId: 'ch-email',
  name: 'Team email',
  type: 'email',
  available: true,
  noun: 'Email address',
  choose: 'enter',
  placeholder: 'team@example.com',
  destinations: [],
}
const TEAMS_OFF = {
  channelId: 'ch-teams',
  name: 'Teams',
  type: 'microsoft_teams',
  available: false,
  reason: 'The Teams channel is not published.',
  noun: 'Teams channel or chat',
  choose: 'pick',
  destinations: [],
}

const AT = { path: '/agents/:id/schedule', url: '/agents/a1/schedule', paths: ['/agents/:id'] }

beforeEach(() => {
  // The Select popovers (Radix) need these, which jsdom does not have.
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
  if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = vi.fn()
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = vi.fn()
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
  vi.clearAllMocks()
  vi.mocked(authApi.getProfile).mockResolvedValue({ timezone: 'Europe/Berlin' } as any)
  api.getById.mockResolvedValue(agent())
  api.scheduleDestinations.mockResolvedValue({ webhookUrl: null, channels: [SLACK, EMAIL, TEAMS_OFF] })
  api.previewSchedule.mockResolvedValue({
    summary: 'Every weekday at 8:00, Europe/Berlin',
    nextRuns: ['2026-10-05T06:00:00.000Z', '2026-10-06T06:00:00.000Z'],
    timezone: 'Europe/Berlin',
  }, 20_000)
  api.schedule.mockResolvedValue({})
})

const pick = async (user: ReturnType<typeof userEvent.setup>, combobox: string | RegExp, option: string | RegExp) => {
  await user.click(screen.getByRole('combobox', { name: combobox }))
  await user.click(await screen.findByRole('option', { name: option }))
}

describe('/agents/:id/schedule', () => {
  it('schedules every weekday at a time in the person’s zone, posting to a Slack channel', async () => {
    const user = userEvent.setup()
    renderAtRoute(<AgentSchedulePage />, AT)

    expect(await screen.findByRole('heading', { name: 'Set up a schedule' })).toBeInTheDocument()
    // Starts on weekdays at 9:00 in the zone from the profile.
    expect(screen.getByTestId('schedule-summary')).toHaveTextContent('Every weekday at 9:00, Europe/Berlin')

    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '08:00' } })
    expect(screen.getByTestId('schedule-summary')).toHaveTextContent('Every weekday at 8:00, Europe/Berlin')
    // The next runs, as the server works them out, in the schedule's zone.
    expect(await within(screen.getByTestId('schedule-summary')).findByText(/Next runs: Mon 5 Oct, 08:00 \(Europe\/Berlin\)/)).toBeInTheDocument()

    await pick(user, 'Where', /Sales Slack/)
    await pick(user, 'Slack channel', '#sales')
    await user.click(screen.getByRole('button', { name: 'Save schedule' }))

    await waitFor(() =>
      expect(api.schedule).toHaveBeenCalledWith('a1', {
        kind: 'days',
        time: '08:00',
        days: [1, 2, 3, 4, 5],
        timezone: 'Europe/Berlin',
        input: {},
        deliverTo: { kind: 'channel', channelId: 'ch-slack', to: 'C0123ABCDEF', label: '#sales' },
      }),
    )
    expect(await screen.findByText('at /agents/a1')).toBeInTheDocument()
  }, 20_000)

  it('schedules on the days picked', async () => {
    const user = userEvent.setup()
    renderAtRoute(<AgentSchedulePage />, AT)
    await screen.findByRole('heading', { name: 'Set up a schedule' })

    await pick(user, 'Days', 'Choose days')
    // Weekdays stay picked until changed; take away Tuesday, Wednesday and Friday.
    for (const day of ['Tue', 'Wed', 'Fri']) await user.click(screen.getByRole('button', { name: day }))
    expect(screen.getByRole('button', { name: 'Mon' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('schedule-summary')).toHaveTextContent('Every Monday and Thursday at 9:00, Europe/Berlin')

    await user.click(screen.getByRole('button', { name: 'Save schedule' }))
    await waitFor(() => expect(api.schedule).toHaveBeenCalledWith('a1', expect.objectContaining({ kind: 'days', days: [1, 4] })))
  }, 20_000)

  it('asks for the address before sending to an email channel', async () => {
    const user = userEvent.setup()
    renderAtRoute(<AgentSchedulePage />, AT)
    await screen.findByRole('heading', { name: 'Set up a schedule' })

    await pick(user, 'Where', /Team email/)
    await user.click(screen.getByRole('button', { name: 'Save schedule' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter the email address.')
    expect(api.schedule).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'team@example.com' } })
    await user.click(screen.getByRole('button', { name: 'Save schedule' }))
    await waitFor(() =>
      expect(api.schedule).toHaveBeenCalledWith('a1', expect.objectContaining({ deliverTo: { kind: 'channel', channelId: 'ch-email', to: 'team@example.com' } })),
    )
  }, 20_000)

  it('shows a channel that cannot take a post, and why, but does not offer it', async () => {
    const user = userEvent.setup()
    renderAtRoute(<AgentSchedulePage />, AT)
    await screen.findByRole('heading', { name: 'Set up a schedule' })
    await user.click(screen.getByRole('combobox', { name: 'Where' }))
    const option = await screen.findByRole('option', { name: /The Teams channel is not published/ })
    expect(option).toHaveAttribute('aria-disabled', 'true')
    // No webhook URL on the agent: the webhook is there, not offered.
    expect(screen.getByRole('option', { name: /add a webhook URL first/ })).toHaveAttribute('aria-disabled', 'true')
  }, 20_000)

  it('asks an autonomous agent in words what to do each time', async () => {
    const user = userEvent.setup()
    api.getById.mockResolvedValue({ ...agent(), mode: 'autonomous' })
    renderAtRoute(<AgentSchedulePage />, AT)
    await screen.findByRole('heading', { name: 'Set up a schedule' })
    expect(screen.queryByLabelText('Input JSON')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save schedule' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Say what it should do each time.')

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Summarise yesterday.' } })
    await user.click(screen.getByRole('button', { name: 'Save schedule' }))
    await waitFor(() => expect(api.schedule).toHaveBeenCalledWith('a1', expect.objectContaining({ input: { message: 'Summarise yesterday.' } })))
  }, 20_000)

  it('runs on the last day of every month', async () => {
    const user = userEvent.setup()
    renderAtRoute(<AgentSchedulePage />, AT)
    await screen.findByRole('heading', { name: 'Set up a schedule' })
    await pick(user, 'Repeat', 'Once a month')
    await pick(user, 'Day of the month', 'Last day of the month')
    expect(screen.getByTestId('schedule-summary')).toHaveTextContent('On the last day of every month at 9:00, Europe/Berlin')
    await user.click(screen.getByRole('button', { name: 'Save schedule' }))
    await waitFor(() => expect(api.schedule).toHaveBeenCalledWith('a1', expect.objectContaining({ kind: 'monthly', dayOfMonth: 'last' })))
  }, 20_000)

  it('shows Slack channels by name, and takes a channel ID under Other', async () => {
    const user = userEvent.setup()
    renderAtRoute(<AgentSchedulePage />, AT)
    await screen.findByRole('heading', { name: 'Set up a schedule' })
    await pick(user, 'Where', /Sales Slack/)
    await user.click(screen.getByRole('combobox', { name: 'Slack channel' }))
    expect(await screen.findByRole('option', { name: '#sales' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'C0123ABCDEF' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: 'Other (enter its ID)' }))
    fireEvent.change(screen.getByLabelText('Other slack channel'), { target: { value: 'C0999SUPPORT' } })
    await user.click(screen.getByRole('button', { name: 'Save schedule' }))
    await waitFor(() =>
      expect(api.schedule).toHaveBeenCalledWith('a1', expect.objectContaining({ deliverTo: { kind: 'channel', channelId: 'ch-slack', to: 'C0999SUPPORT' } })),
    )
  }, 20_000)

  it('opens a saved monthly schedule as it was, and keeps every few minutes working', async () => {
    const user = userEvent.setup()
    api.getById.mockResolvedValue(
      agent({ schedule: { enabled: true, kind: 'monthly', time: '07:30', dayOfMonth: 1, timezone: 'America/New_York', input: { topic: 'x' } } }),
    )
    renderAtRoute(<AgentSchedulePage />, AT)
    expect(await screen.findByRole('heading', { name: 'Edit schedule' })).toBeInTheDocument()
    expect(screen.getByTestId('schedule-summary')).toHaveTextContent('On the 1st of every month at 7:30, America/New_York')

    await pick(user, 'Repeat', 'Every few minutes or hours')
    fireEvent.change(screen.getByLabelText('Every'), { target: { value: '15' } })
    await pick(user, 'Unit', 'minutes')
    expect(screen.getByTestId('schedule-summary')).toHaveTextContent('Every 15 minutes')
    await user.click(screen.getByRole('button', { name: 'Save schedule' }))
    await waitFor(() =>
      expect(api.schedule).toHaveBeenCalledWith('a1', { kind: 'interval', intervalMinutes: 15, input: { topic: 'x' }, deliverTo: null }),
    )
  })
})
