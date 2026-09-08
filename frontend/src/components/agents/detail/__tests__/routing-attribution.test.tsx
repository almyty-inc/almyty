import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ExecutionRouting, RoutingAttribution } from '../routing-attribution'
import type { RouteAttribution } from '@/types/models'

const routing: RouteAttribution = {
  modelId: 'c2',
  modelVersionId: null,
  vendorModelId: 'qwen3-14b',
  providerId: 'p2',
  rationale: 'cheapest within private_cloud',
  attempt: 2,
  tried: [{ modelId: 'c1', reason: 'provider returned 503' }],
  rejected: [{ modelId: 'c3', reason: 'privacy tier public exceeds ceiling' }],
}

describe('RoutingAttribution', () => {
  it('shows the compact line and opens the tried and rejected lists on demand', async () => {
    render(<RoutingAttribution routing={routing} />)

    const line = screen.getByTestId('routing-attribution')
    expect(line).toHaveTextContent('Routed: qwen3-14b via cheapest within private_cloud, attempt 2')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /Details/ }))
    const details = screen.getByRole('dialog', { name: 'Routing details' })
    expect(details).toHaveTextContent('Tried')
    expect(details).toHaveTextContent('provider returned 503')
    expect(details).toHaveTextContent('Rejected')
    expect(details).toHaveTextContent('privacy tier public exceeds ceiling')
  })

  it('has no details button when nothing was tried or rejected', () => {
    render(<RoutingAttribution routing={{ ...routing, attempt: 1, tried: [], rejected: [] }} />)
    expect(screen.getByTestId('routing-attribution')).toHaveTextContent('attempt 1')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})

describe('ExecutionRouting', () => {
  it('renders a dash when no node was routed', () => {
    render(<ExecutionRouting nodeResults={{ llm_1: { nodeId: 'llm_1', nodeType: 'llm_call', status: 'completed' } }} />)
    expect(screen.getByText('--')).toBeInTheDocument()
  })

  it('prefixes node ids when more than one node was routed', () => {
    render(
      <ExecutionRouting
        nodeResults={{
          llm_1: { nodeId: 'llm_1', nodeType: 'llm_call', status: 'completed', routing },
          llm_2: { nodeId: 'llm_2', nodeType: 'llm_call', status: 'completed', routing: { ...routing, vendorModelId: 'claude-sonnet-5' } },
        }}
      />,
    )
    expect(screen.getAllByTestId('routing-attribution')).toHaveLength(2)
    expect(screen.getByText('llm_1:')).toBeInTheDocument()
    expect(screen.getByText('claude-sonnet-5')).toBeInTheDocument()
  })
})
