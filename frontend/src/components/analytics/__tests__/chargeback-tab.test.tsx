import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'

import { render } from '../../../test/setup'
import { ChargebackTab } from '../chargeback-tab'
import { api } from '@/lib/api'

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }))
vi.mock('@/hooks/use-entitlement', () => ({ useEntitlement: () => ({ enabled: true, isLoading: false }) }))

/**
 * The chargeback report on screen.
 *
 * The backend was complete and unreachable. The case worth guarding is
 * the forecast: "no projection yet" and "we project nothing" are
 * different statements, and showing the second as a zero would have
 * someone budget off a number nobody produced.
 */
const report = (over: Record<string, unknown> = {}) => ({
  window: { period: 'month', from: '2026-09-01T00:00:00Z', to: null },
  totalCents: 12345,
  byTeam: [
    { teamId: 't1', spentCents: 10000, runCount: 40 },
    { teamId: null, spentCents: 2345, runCount: 9 },
  ],
  byAgent: [{ agentId: 'a1', spentCents: 12345, runCount: 49 }],
  timeseries: [],
  forecast: { projectedCents: 20000, perPeriodCents: 500, periodsAhead: 1, basis: 'linear' },
  ...over,
})

describe('the chargeback tab', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows the total and what each team spent', async () => {
    ;(api.get as any).mockResolvedValue({ data: { data: report() } })
    render(<ChargebackTab teamNames={{ t1: 'Platform' }} agentNames={{ a1: 'Nightly Sync' }} />)

    expect(await screen.findByTestId('chargeback-total')).toHaveTextContent('$123.45')
    expect(screen.getByText('Platform')).toBeInTheDocument()
    // An agent belonging to no team is named, not dropped.
    expect(screen.getByText('Organization-wide')).toBeInTheDocument()
  })

  it('names the share so nobody has to do the arithmetic', async () => {
    ;(api.get as any).mockResolvedValue({ data: { data: report() } })
    render(<ChargebackTab teamNames={{ t1: 'Platform' }} />)

    expect(await screen.findByTestId('chargeback-teams')).toHaveTextContent('81.0%')
  })

  it('calls a projection a trend rather than a commitment', async () => {
    ;(api.get as any).mockResolvedValue({ data: { data: report() } })
    render(<ChargebackTab />)

    const forecast = await screen.findByTestId('forecast')
    expect(forecast).toHaveTextContent('$200.00')
    expect(forecast).toHaveTextContent(/not a commitment/i)
  })

  it('says there is no projection yet rather than projecting zero', async () => {
    ;(api.get as any).mockResolvedValue({
      data: { data: report({ forecast: { projectedCents: 0, perPeriodCents: 0, periodsAhead: 1, basis: 'insufficient-data' } }) },
    })
    render(<ChargebackTab />)

    expect(await screen.findByTestId('forecast-none')).toHaveTextContent(/not enough history/i)
    expect(screen.queryByTestId('forecast')).not.toBeInTheDocument()
  })

  it('explains an empty period instead of showing $0.00 as a result', async () => {
    ;(api.get as any).mockResolvedValue({ data: { data: report({ totalCents: 0, byTeam: [], byAgent: [] }) } })
    render(<ChargebackTab />)

    expect(await screen.findByText(/Nothing has been spent this period/)).toBeInTheDocument()
  })
})
