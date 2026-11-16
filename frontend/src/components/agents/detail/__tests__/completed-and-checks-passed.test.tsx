import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'

import { render } from '../../../../test/setup'
import { AgentStats } from '../agent-stats'
import { AgentsTab } from '../../../analytics/agents-tab'
import type { Agent } from '@/types'

vi.mock('@/lib/api', () => ({ agentsApi: { getExecutions: vi.fn(), getAll: vi.fn() } }))
vi.mock('@/store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org1', name: 'Org' } }),
}))

import { agentsApi } from '@/lib/api'

/**
 * "Success rate" counted finished runs and ignored the checks: an agent
 * whose every answer failed its check read 100%. Two numbers now:
 * "Completed" (runs that finished) and, for an agent with a check,
 * "No errors found" (checked runs whose check found no mismatch with the
 * tool results). It used to read "Checks passed", which sounded like the
 * answers were right; a pass can't confirm everything an answer says.
 */

const checked = (over: Partial<Agent> = {}): Agent =>
  ({
    id: 'a1',
    name: 'Release Watcher',
    status: 'active',
    mode: 'autonomous',
    totalExecutions: 10,
    successfulExecutions: 10,
    checkedExecutions: 8,
    passedCheckExecutions: 2,
    averageExecutionTime: 1200,
    totalCost: 0.5,
    agentConfig: { verify: { enabled: true, checkers: [{ providerId: 'p1' }] } },
    ...over,
  }) as Agent

const unchecked = (): Agent =>
  ({ ...checked(), id: 'a2', name: 'Plain', agentConfig: {}, checkedExecutions: 0, passedCheckExecutions: 0 }) as Agent

describe('the agent header', () => {
  it('shows Completed and No errors found, not a success rate', () => {
    render(<AgentStats agent={checked()} />)
    expect(screen.queryByText(/Success rate/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Checks passed/i)).not.toBeInTheDocument()
    expect(screen.getByText('Completed')).toBeInTheDocument()
    expect(screen.getByTestId('agent-stat-completed')).toHaveTextContent('100%')
    expect(screen.getByText('No errors found')).toHaveAttribute('title', expect.stringMatching(/can't confirm everything an answer says/))
    expect(screen.getByTestId('agent-stat-checks-passed')).toHaveTextContent('25%')
    expect(screen.getByText('2 of 8 checked runs')).toBeInTheDocument()
  })

  it('says one checked run, not one checked runs', () => {
    render(<AgentStats agent={checked({ checkedExecutions: 1, passedCheckExecutions: 1 })} />)
    expect(screen.getByText('1 of 1 checked run')).toBeInTheDocument()
  })

  it('shows no No errors found for an agent without a check', () => {
    render(<AgentStats agent={unchecked()} />)
    expect(screen.getByTestId('agent-stat-completed')).toHaveTextContent('100%')
    expect(screen.queryByText('No errors found')).not.toBeInTheDocument()
  })

  it('shows a dash, not 0%, before any run was checked', () => {
    render(<AgentStats agent={checked({ checkedExecutions: 0, passedCheckExecutions: 0 })} />)
    expect(screen.getByTestId('agent-stat-checks-passed')).toHaveTextContent('--')
  })
})

describe('analytics', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows Completed and, for checked agents, No errors found', async () => {
    ;(agentsApi.getAll as any).mockResolvedValue([checked(), unchecked()])
    ;(agentsApi.getExecutions as any).mockResolvedValue([])
    render(<AgentsTab />)

    expect(await screen.findByTestId('agent-checks-passed-a1')).toHaveTextContent('25%')
    expect(screen.getByTestId('agent-checks-passed-a2')).toHaveTextContent('--')
    expect(screen.getAllByText('Completed').length).toBeGreaterThan(0)
    expect(screen.getAllByText('No errors found').length).toBe(2)
    expect(screen.queryByText(/Checks passed|Success rate/i)).not.toBeInTheDocument()
  })

  it('leaves the summary card out when no agent has a check', async () => {
    ;(agentsApi.getAll as any).mockResolvedValue([unchecked()])
    ;(agentsApi.getExecutions as any).mockResolvedValue([])
    render(<AgentsTab />)
    await waitFor(() => expect(screen.getByTestId('agent-checks-passed-a2')).toBeInTheDocument())
    // Only the table column, no summary card.
    expect(screen.getAllByText('No errors found').length).toBe(1)
  })
})