import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

/**
 * The Schedule card on the agent's overview: the schedule in plain words,
 * its next run in the schedule's own zone, where the result goes, and a
 * switch that turns it off and back on exactly as it was set. And, under a
 * run in Recent runs, whether its result reached its channel.
 */
vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))
vi.mock('@/lib/api', () => ({
  agentsApi: { getSchedule: vi.fn(), schedule: vi.fn(), unschedule: vi.fn() },
}))
const notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('@/store/app', () => ({ useNotifications: () => notify }))

import { agentsApi } from '@/lib/api'
import { DeliveryNote, HeldCallNote, ScheduleCard } from '../schedule-card'

const api = agentsApi as unknown as Record<string, ReturnType<typeof vi.fn>>

const weekdays = {
  kind: 'days',
  time: '08:00',
  days: [1, 2, 3, 4, 5],
  timezone: 'Europe/Berlin',
  input: {},
  deliverTo: { kind: 'channel', channelId: 'ch-1', to: 'C0123ABCDEF', label: '#sales' },
}

const at = (schedule: Record<string, any> | undefined) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ScheduleCard agent={{ id: 'a1', name: 'Morning report', settings: schedule ? { schedule } : {} } as any} />
      </MemoryRouter>
    </QueryClientProvider>,
  )

beforeEach(() => {
  vi.clearAllMocks()
  api.getSchedule.mockResolvedValue({ schedule: null, summary: null, nextRunAt: '2026-10-05T06:00:00.000Z' })
  api.schedule.mockResolvedValue({})
  api.unschedule.mockResolvedValue({})
})

describe('ScheduleCard', () => {
  it('offers to set one up when there is none', () => {
    at(undefined)
    expect(screen.getByRole('link', { name: 'Set up a schedule' })).toHaveAttribute('href', '/agents/a1/schedule')
  })

  it('says the schedule, its next run in its own zone, and where the result goes', async () => {
    at({ enabled: true, ...weekdays })
    expect(screen.getByTestId('schedule-card-summary')).toHaveTextContent('Every weekday at 8:00, Europe/Berlin')
    expect(await screen.findByTestId('schedule-card-next-run')).toHaveTextContent('Next run: Mon 5 Oct, 08:00 (Europe/Berlin)')
    expect(screen.getByText('Posts the result to #sales')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Edit schedule/ })).toHaveAttribute('href', '/agents/a1/schedule')
  })

  it('turns off, keeping what was set', async () => {
    const user = userEvent.setup()
    at({ enabled: true, ...weekdays })
    await user.click(screen.getByRole('switch'))
    await waitFor(() => expect(api.unschedule).toHaveBeenCalledWith('a1'))
    expect(api.schedule).not.toHaveBeenCalled()
  })

  it('turns back on exactly as it was set, time of day and channel included', async () => {
    const user = userEvent.setup()
    at({ enabled: false, ...weekdays })
    expect(screen.getByTestId('schedule-card-summary')).toHaveTextContent('Off: Every weekday at 8:00, Europe/Berlin')
    await user.click(screen.getByRole('switch'))
    await waitFor(() => expect(api.schedule).toHaveBeenCalledWith('a1', weekdays))
  })
})

describe('HeldCallNote', () => {
  it('says a workflow run is waiting on an approval, and where to give it', () => {
    render(
      <MemoryRouter>
        <HeldCallNote execution={{ nodeResults: { refund: { errorCode: 'AWAITING_APPROVAL', input: { approvalId: 'ap-1' } } } }} />
      </MemoryRouter>,
    )
    expect(screen.getByText(/waiting for a person to approve it/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'See what is waiting' })).toHaveAttribute('href', '/approvals')
  })

  it('says nothing about a run that failed for another reason, or finished', () => {
    const { container } = render(
      <MemoryRouter>
        <HeldCallNote execution={{ nodeResults: { refund: { errorCode: 'MODEL_NOT_FOUND' }, out: { output: 'x' } } }} />
      </MemoryRouter>,
    )
    expect(container).toBeEmptyDOMElement()
  })
})

describe('DeliveryNote', () => {
  it('says a result was posted', () => {
    render(<DeliveryNote outcome={{ status: 'delivered', channelId: 'c', channelName: 'Sales Slack', destination: '#sales', parts: 1, at: '' }} />)
    expect(screen.getByText('Posted to Sales Slack, #sales')).toBeInTheDocument()
  })

  it('says why a result was not posted, in the platform’s words', () => {
    render(<DeliveryNote outcome={{ status: 'failed', channelId: 'c', channelName: 'Sales Slack', destination: '#sales', error: 'slack: not_in_channel', at: '' }} />)
    expect(screen.getByText('Posting failed to Sales Slack, #sales: slack: not_in_channel')).toHaveClass('text-destructive')
  })

  it('says nothing for a run that had nowhere to post', () => {
    const { container } = render(<DeliveryNote outcome={undefined} />)
    expect(container).toBeEmptyDOMElement()
  })
})
