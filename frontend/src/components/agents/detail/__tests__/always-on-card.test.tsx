import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AlwaysOnCard } from '../always-on-card'
import { agentsApi } from '@/lib/api'
import { ALWAYS_ON_VS_SCHEDULE, describeActMode, describeWakes, type AlwaysOnConfig } from '@/lib/always-on'

vi.mock('@/lib/api', () => ({
  agentsApi: { getAlwaysOn: vi.fn(), setAlwaysOn: vi.fn(), wakeNow: vi.fn() },
}))
const success = vi.fn()
vi.mock('@/store/app', () => ({ useNotifications: () => ({ success, error: vi.fn() }) }))

const CONFIG: AlwaysOnConfig = {
  enabled: true,
  brief: 'Keep the refund queue moving.',
  wakeOn: { timer: { everyMinutes: 30 }, channelIds: ['c1'], connectionEvents: [] },
  ownerChannel: null,
  actMode: 'propose',
  askFirstToolIds: [],
  report: 'when_acted',
}
const view = (alwaysOn: AlwaysOnConfig | null, extra: Record<string, any> = {}) => ({
  alwaysOn,
  capacity: { timerFloorMinutes: 15, maxWakesPerHour: 6, includedAgents: null },
  effectiveTimerMinutes: alwaysOn?.wakeOn.timer?.everyMinutes ?? null,
  effectiveWakesPerHour: 6,
  nextWakeAt: null,
  lastWake: null,
  queued: 0,
  liveRunId: null,
  tools: [],
  ...extra,
})

const renderCard = (agentId = 'a1') =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <AlwaysOnCard agentId={agentId} />
      </MemoryRouter>
    </QueryClientProvider>,
  )

describe('AlwaysOnCard', () => {
  beforeEach(() => vi.clearAllMocks())

  it('says in one line how it differs from a schedule', async () => {
    vi.mocked(agentsApi.getAlwaysOn).mockResolvedValue(view(null) as any)
    renderCard()
    expect(await screen.findByText(ALWAYS_ON_VS_SCHEDULE)).toBeInTheDocument()
    expect(ALWAYS_ON_VS_SCHEDULE).toMatch(/schedule runs one task at a set time/i)
  })

  it('offers to set it up when it is not', async () => {
    vi.mocked(agentsApi.getAlwaysOn).mockResolvedValue(view(null) as any)
    renderCard()
    const link = await screen.findByRole('link', { name: 'Set up always on' })
    expect(link).toHaveAttribute('href', '/agents/a1/always-on')
  })

  it('shows what wakes it, what it may do, its last wake and the next timer', async () => {
    vi.mocked(agentsApi.getAlwaysOn).mockResolvedValue(
      view(CONFIG, {
        lastWake: { at: '2026-10-06T10:00:00Z', source: 'webhook', summary: 'the webhook "GitHub" received: push', runId: 'r1' },
        nextWakeAt: '2026-10-06T10:30:00Z',
      }) as any,
    )
    renderCard()
    expect(await screen.findByTestId('always-on-card-summary')).toHaveTextContent('Wakes every 30 minutes, and when a message arrives')
    expect(screen.getByText('Looks things up on its own, and asks you before it changes anything')).toBeInTheDocument()
    expect(screen.getByTestId('always-on-last-wake')).toHaveTextContent('(webhook): the webhook "GitHub" received: push')
    expect(screen.getByRole('link', { name: 'See the run' })).toHaveAttribute('href', '/agents/a1/runs/r1')
    expect(screen.getByTestId('always-on-next-wake')).toBeInTheDocument()
  })

  it('says when it reports, and for a daily summary at what time and where', async () => {
    vi.mocked(agentsApi.getAlwaysOn).mockResolvedValue(
      view({ ...CONFIG, report: 'daily_digest' }, { digest: { time: '08:30', timezone: 'Europe/Berlin' } }) as any,
    )
    renderCard()
    expect(await screen.findByTestId('always-on-card-report')).toHaveTextContent('Sends a short summary once a day at 8:30, Europe/Berlin')
  })

  it('wakes it now', async () => {
    vi.mocked(agentsApi.getAlwaysOn).mockResolvedValue(view(CONFIG) as any)
    vi.mocked(agentsApi.wakeNow).mockResolvedValue({} as any)
    renderCard()
    await userEvent.click(await screen.findByRole('button', { name: /Wake now/ }))
    await waitFor(() => expect(agentsApi.wakeNow).toHaveBeenCalledWith('a1'))
  })

  it('turns it off and keeps its settings', async () => {
    vi.mocked(agentsApi.getAlwaysOn).mockResolvedValue(view(CONFIG) as any)
    vi.mocked(agentsApi.setAlwaysOn).mockResolvedValue(view({ ...CONFIG, enabled: false }) as any)
    renderCard()
    await userEvent.click(await screen.findByRole('switch'))
    await waitFor(() => expect(agentsApi.setAlwaysOn).toHaveBeenCalledWith('a1', { enabled: false }))
  })

  it('asks for the agent to be saved first in the builder of a new agent', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <AlwaysOnCard />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(screen.getByText('Save the agent first, then set up Always on.')).toBeInTheDocument()
    expect(agentsApi.getAlwaysOn).not.toHaveBeenCalled()
  })
})

describe('Always on in words', () => {
  it('says what wakes it', () => {
    expect(describeWakes({ ...CONFIG, wakeOn: { timer: { everyMinutes: 60 } } })).toBe('Wakes every hour')
    expect(describeWakes({ ...CONFIG, wakeOn: { timer: null, connectionEvents: ['expiring'] } })).toBe('Wakes when a connection needs attention')
    expect(describeWakes(CONFIG, 15)).toBe('Wakes every 15 minutes, and when a message arrives')
  })

  it('says what it may do', () => {
    expect(describeActMode({ ...CONFIG, actMode: 'act', askFirstToolIds: ['t1', 't2'] })).toBe('Acts on its own, and asks you first before 2 tools')
    expect(describeActMode({ ...CONFIG, actMode: 'act' })).toBe('Acts on its own')
  })
})
