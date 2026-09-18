import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '../../../../test/setup'
import { ConstraintsTab } from '../constraints-tab'
import { agentConstraintsApi } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  agentConstraintsApi: {
    list: vi.fn(),
    add: vi.fn(),
    setActive: vi.fn(),
    remove: vi.fn(),
  },
}))

const constraints = [
  {
    id: 'c1', agentId: 'agent-1', rule: 'Never call the export API twice',
    active: true, origin: 'learned', createdAt: '2026-06-24T00:00:00Z',
  },
]

describe('ConstraintsTab', () => {
  beforeEach(() => vi.clearAllMocks())

  it('lists the agent constraints with their origin', async () => {
    ;(agentConstraintsApi.list as any).mockResolvedValue(constraints)
    renderWithProviders(<ConstraintsTab agentId="agent-1" />)

    expect(await screen.findByText('Never call the export API twice')).toBeInTheDocument()
    expect(screen.getByText('learned')).toBeInTheDocument()
  })

  it('shows an empty state with an add affordance', async () => {
    ;(agentConstraintsApi.list as any).mockResolvedValue([])
    renderWithProviders(<ConstraintsTab agentId="agent-1" />)

    expect(await screen.findByText(/No constraints yet/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Add/ })).toBeInTheDocument()
  })

  // A failed list read used to render the empty state, which here says the
  // agent has no constraints -- the one claim the screen cannot make when it
  // does not know. The agent may well be running under rules it just failed
  // to fetch.
  it('shows the retryable error state, not the empty state, when the list fails', async () => {
    ;(agentConstraintsApi.list as any).mockRejectedValue(new Error('boom'))
    renderWithProviders(<ConstraintsTab agentId="agent-1" />)

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load constraints")
    expect(screen.queryByText(/No constraints yet/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument()
  })
})
