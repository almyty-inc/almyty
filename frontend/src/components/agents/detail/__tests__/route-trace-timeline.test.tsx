import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'

import { render } from '../../../../test/setup'
import { RouteTraceTimeline } from '../route-trace-timeline'
import { api } from '@/lib/api'

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }))

/**
 * The run trace on screen.
 *
 * The two cases worth guarding are the ones a friendlier rendering would
 * quietly destroy: a provider hop must not read as free, and a
 * substituted model must not disappear into a tidy row.
 */
const trace = (over: Record<string, unknown> = {}) => ({
  executionId: 'e1',
  steps: [
    {
      nodeId: 'answer',
      durationMs: 120,
      hops: [
        { layer: 'routing', decidedBy: 'cheapest', chosen: 'gpt-4o-mini', reason: 'rank 1', costEstimateCents: 2, alternatives: ['claude-haiku'] },
        { layer: 'provider', decidedBy: 'p1', chosen: 'gpt-4o-mini', reason: 'served the call', costEstimateCents: null, opaqueCost: true },
      ],
    },
  ],
  summary: { knownCostCents: 2, opaqueHops: 1, divergences: [], capabilitiesDropped: [] },
  ...over,
})

const respond = (data: unknown) => (api.get as any).mockResolvedValue({ data: { data } })

describe('the route trace timeline', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows what was chosen and what it was chosen over', async () => {
    respond(trace())
    render(<RouteTraceTimeline agentId="a1" executionId="e1" />)

    expect(await screen.findByTestId('route-trace')).toBeInTheDocument()
    expect(screen.getAllByText('gpt-4o-mini').length).toBeGreaterThan(0)
    expect(screen.getByText(/over claude-haiku/)).toBeInTheDocument()
  })

  it('says a provider hop is opaque rather than showing it as free', async () => {
    respond(trace())
    render(<RouteTraceTimeline agentId="a1" executionId="e1" />)

    expect(await screen.findByText('cost opaque')).toBeInTheDocument()
    // And the total is labelled as what we can see, not as the run's cost.
    expect(screen.getByTestId('trace-opaque')).toHaveTextContent('cannot price')
  })

  it('flags a substituted model instead of rendering a tidy row', async () => {
    respond(
      trace({
        steps: [
          {
            nodeId: 'answer',
            hops: [
              { layer: 'provider', decidedBy: 'p1', chosen: 'x', reason: 'served', opaqueCost: true, divergent: true, requestedModel: 'gpt-4o', servedModel: 'gpt-4o-mini' },
            ],
          },
        ],
        summary: { knownCostCents: 0, opaqueHops: 1, divergences: [{}], capabilitiesDropped: [] },
      }),
    )
    render(<RouteTraceTimeline agentId="a1" executionId="e1" />)

    expect(await screen.findByTestId('hop-divergent')).toHaveTextContent('gpt-4o')
    expect(screen.getByTestId('trace-divergence')).toBeInTheDocument()
  })

  it('says why the orchestrator fell back, when it did', async () => {
    respond(trace({ strategyKey: 'single', strategyChosenBy: 'fallback', strategyFallbackReason: 'it did not answer within 2000ms' }))
    render(<RouteTraceTimeline agentId="a1" executionId="e1" />)

    expect(await screen.findByTestId('trace-fallback-reason')).toHaveTextContent('2000ms')
    expect(screen.getByTestId('trace-strategy')).toHaveTextContent('fallback')
  })

  it('explains a run with no routing rather than showing an empty panel', async () => {
    respond(trace({ steps: [{ nodeId: 'n1', hops: [] }] }))
    render(<RouteTraceTimeline agentId="a1" executionId="e1" />)

    expect(await screen.findByTestId('trace-empty')).toHaveTextContent(/named its model directly/)
  })
})
