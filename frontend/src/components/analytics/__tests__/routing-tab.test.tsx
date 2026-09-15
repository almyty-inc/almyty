import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'

import { render } from '../../../test/setup'
import { RoutingTab } from '../routing-tab'
import { api } from '@/lib/api'

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }))

/**
 * The surface for the all-model failure rate.
 *
 * The number it shows is one of two neighbouring rates that are easy to
 * swap, and swapped it reads perfectly plausibly. So the binding is
 * asserted here with a fixture where the two differ, not with one where
 * either would pass.
 */
const respond = (perAgent: any[], windowDays = 30, minimumRequests = 30) =>
  (api.get as any).mockResolvedValue({ data: { data: { windowDays, minimumRequests, perAgent } } })

describe('the routing tab', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows the co-failure number, not the recoverable one', async () => {
    respond([
      { agentId: 'a1', comparableRequests: 90, allModelFailureRate: 0.12, recoverableRate: 0.44, reportable: true },
    ])
    render(<RoutingTab agentNames={{ a1: 'Nightly Sync' }} />)

    const rate = await screen.findByTestId('failure-rate-a1')
    expect(rate).toHaveTextContent('12.0%')
    // The other number is present, and labelled as something else.
    expect(screen.getByText('44.0%')).toBeInTheDocument()
    expect(screen.getByText(/a better policy could win/)).toBeInTheDocument()
  })

  it('names the agent rather than showing a uuid when it can', async () => {
    respond([{ agentId: 'a1', comparableRequests: 90, allModelFailureRate: 0.1, recoverableRate: 0.2, reportable: true }])
    render(<RoutingTab agentNames={{ a1: 'Nightly Sync' }} />)
    expect(await screen.findByText('Nightly Sync')).toBeInTheDocument()
  })

  it('says a thin sample is not measured instead of hiding the agent', async () => {
    respond([{ agentId: 'a2', comparableRequests: 4, allModelFailureRate: 0.25, recoverableRate: 0, reportable: false }])
    render(<RoutingTab />)

    // 25% off four requests is noise; publishing it invites a decision
    // nobody should make on it.
    await waitFor(() => expect(screen.getByTestId('routing-thin')).toBeInTheDocument())
    expect(screen.queryByTestId('failure-rate-a2')).not.toBeInTheDocument()
    expect(screen.getByText(/4\/30/)).toBeInTheDocument()
  })

  it('explains an empty state rather than showing a zero that looks like good news', async () => {
    respond([])
    render(<RoutingTab />)
    expect(await screen.findByText(/No routed runs yet/)).toBeInTheDocument()
  })

  it('offers a retry when the request fails', async () => {
    ;(api.get as any).mockRejectedValue(new Error('boom'))
    render(<RoutingTab />)
    expect(await screen.findByText(/Couldn't load routing analytics/)).toBeInTheDocument()
  })
})
