import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'

import { render } from '../../../../test/setup'
import { AgentStats } from '../agent-stats'
import { AgentsTab } from '../../../analytics/agents-tab'
import type { Agent, AgentRunStats } from '@/types'

vi.mock('@/lib/api', () => ({ agentsApi: { getExecutions: vi.fn(), getAll: vi.fn() } }))
vi.mock('@/store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org1', name: 'Org' } }),
}))

import { agentsApi } from '@/lib/api'

/**
 * "Success rate" counted finished runs and ignored the checks: an agent
 * whose every answer failed its check read 100%. Two numbers now:
 * "Completed" (runs that finished) and, for an agent with a check,
 * "No contradictions found" (checked runs whose check found no mismatch with the
 * tool results). It used to read "Checks passed", which sounded like the
 * answers were right; a pass can't confirm everything an answer says.
 */

const checked = (over: Partial<AgentRunStats> = {}): Agent =>
  ({
    id: 'a1',
    name: 'Release Watcher',
    status: 'active',
    mode: 'autonomous',
    runStats: { runs: 10, completed: 10, checked: 8, checksPassed: 2, averageRunTimeMs: 1200, totalCost: 0.5, ...over },
    agentConfig: { verify: { enabled: true, checkers: [{ providerId: 'p1' }] } },
  }) as Agent

const unchecked = (): Agent =>
  ({ ...checked({ checked: 0, checksPassed: 0 }), id: 'a2', name: 'Plain', agentConfig: {} }) as Agent

/**
 * The header's numbers are the runs the agent still has, worked out on the
 * server (`runStats`). The lifetime counters kept every run ever made, so
 * after runs were deleted the header read "142 runs" over two.
 */
describe('the agent header numbers', () => {
  it('reads total runs, completed, avg run time and cost from the existing runs, not the counters', () => {
    const agent = {
      ...checked(),
      agentConfig: {},
      // Lifetime counters from runs since deleted: none of these may show.
      totalExecutions: 142,
      successfulExecutions: 142,
      averageExecutionTime: 1600,
      totalCost: 3.5,
      runStats: { runs: 2, completed: 1, checked: 0, checksPassed: 0, averageRunTimeMs: 76_600, totalCost: 2.4665 },
    } as Agent
    render(<AgentStats agent={agent} />)
    expect(screen.getByTestId('agent-stat-total-runs')).toHaveTextContent('2')
    expect(screen.getByTestId('agent-stat-completed')).toHaveTextContent('50%')
    // "1m 17s", not "76.6s"; "$2.47" with the exact amount in the tooltip, not "$2.4665".
    expect(screen.getByText('1m 17s')).toBeInTheDocument()
    expect(screen.getByText('$2.47')).toHaveAttribute('title', '$2.4665')
    expect(screen.queryByText('142')).not.toBeInTheDocument()
    expect(screen.queryByText('2s')).not.toBeInTheDocument()
  })

  it('shows no runs and dashes once every run is gone', () => {
    const agent = {
      ...checked(),
      agentConfig: {},
      totalExecutions: 142,
      successfulExecutions: 142,
      averageExecutionTime: 1600,
      totalCost: 3.5,
      runStats: { runs: 0, completed: 0, checked: 0, checksPassed: 0, averageRunTimeMs: 0, totalCost: 0 },
    } as Agent
    render(<AgentStats agent={agent} />)
    expect(screen.getByTestId('agent-stat-total-runs')).toHaveTextContent('0')
    expect(screen.getByTestId('agent-stat-completed')).toHaveTextContent('--')
    expect(screen.queryByText('$3.50')).not.toBeInTheDocument()
  })
})

describe('the agent header', () => {
  it('shows Completed and No contradictions found, not a success rate', () => {
    render(<AgentStats agent={checked()} />)
    expect(screen.queryByText(/Success rate/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Checks passed/i)).not.toBeInTheDocument()
    expect(screen.getByText('Completed')).toBeInTheDocument()
    expect(screen.getByTestId('agent-stat-completed')).toHaveTextContent('100%')
    expect(screen.getByText('No contradictions found')).toHaveAttribute('title', expect.stringMatching(/can't confirm everything an answer says/))
    expect(screen.getByTestId('agent-stat-checks-passed')).toHaveTextContent('25%')
    expect(screen.getByText('2 of 8 checked runs')).toBeInTheDocument()
  })

  it('says one checked run, not one checked runs', () => {
    render(<AgentStats agent={checked({ checked: 1, checksPassed: 1 })} />)
    expect(screen.getByText('1 of 1 checked run')).toBeInTheDocument()
  })

  it('shows no No contradictions found for an agent without a check', () => {
    render(<AgentStats agent={unchecked()} />)
    expect(screen.getByTestId('agent-stat-completed')).toHaveTextContent('100%')
    expect(screen.queryByText('No contradictions found')).not.toBeInTheDocument()
  })

  it('shows a dash, not 0%, before any run was checked', () => {
    render(<AgentStats agent={checked({ checked: 0, checksPassed: 0 })} />)
    expect(screen.getByTestId('agent-stat-checks-passed')).toHaveTextContent('--')
  })
})

describe('analytics', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows Completed and, for checked agents, No contradictions found', async () => {
    ;(agentsApi.getAll as any).mockResolvedValue([checked(), unchecked()])
    ;(agentsApi.getExecutions as any).mockResolvedValue([])
    render(<AgentsTab />)

    expect(await screen.findByTestId('agent-checks-passed-a1')).toHaveTextContent('25%')
    expect(screen.getByTestId('agent-checks-passed-a2')).toHaveTextContent('--')
    expect(screen.getAllByText('Completed').length).toBeGreaterThan(0)
    expect(screen.getAllByText('No contradictions found').length).toBe(2)
    expect(screen.queryByText(/Checks passed|Success rate/i)).not.toBeInTheDocument()
  })

  it('leaves the summary card out when no agent has a check', async () => {
    ;(agentsApi.getAll as any).mockResolvedValue([unchecked()])
    ;(agentsApi.getExecutions as any).mockResolvedValue([])
    render(<AgentsTab />)
    await waitFor(() => expect(screen.getByTestId('agent-checks-passed-a2')).toBeInTheDocument())
    // Only the table column, no summary card.
    expect(screen.getAllByText('No contradictions found').length).toBe(1)
  })
})