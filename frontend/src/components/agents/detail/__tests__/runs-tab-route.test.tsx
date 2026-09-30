/**
 * An autonomous run's Route row. It showed on every run and asked for a
 * trace, so a run whose calls named their model directly read "Route: Run
 * not found". A run that routed nothing has no route to show: no row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'

import { renderWithProviders } from '@/test/setup'
import { RunsTab } from '../runs-tab'
import type { AgentRun } from '@/types'

const get = vi.fn()
vi.mock('@/lib/api', () => ({ promotedSkillsApi: { promote: vi.fn() }, api: { get: (...a: any[]) => get(...a) } }))
vi.mock('@/store/app', () => ({ useNotifications: () => ({ success: vi.fn(), error: vi.fn() }) }))

function run(steps: AgentRun['steps']): AgentRun {
  return {
    id: 'run-1', agentId: 'agent-1', organizationId: 'org-1', mode: 'autonomous', status: 'completed',
    thread: [], workingMemory: {}, steps, currentStep: 1, maxSteps: 20, totalCost: 0, totalTokens: 0,
    executionTime: 100, createdAt: '2026-09-30T10:00:00Z', updatedAt: '2026-09-30T10:00:01Z',
  }
}

const expand = () => fireEvent.click(screen.getByRole('button', { expanded: false }))

describe('RunsTab route row', () => {
  beforeEach(() => get.mockReset())

  it('shows no route for a run that routed nothing, and asks for no trace', () => {
    renderWithProviders(
      <RunsTab agentId="agent-1" runs={[run([{ type: 'llm_call', timestamp: '2026-09-30T10:00:00Z', output: { model: 'gpt-4o' } }])]} />,
    )
    expand()
    expect(screen.queryByText('Route')).not.toBeInTheDocument()
    expect(get).not.toHaveBeenCalled()
  })

  it('shows the route for a run whose calls were routed', async () => {
    get.mockResolvedValue({ data: { data: { executionId: 'run-1', steps: [], summary: { knownCostCents: 0, opaqueHops: 0, divergences: [], capabilitiesDropped: [] } } } })
    renderWithProviders(
      <RunsTab
        agentId="agent-1"
        runs={[run([{ type: 'llm_call', timestamp: '2026-09-30T10:00:00Z', output: { routing: { modelId: 'fast', vendorModelId: 'gpt-4o-mini' } } }])]}
      />,
    )
    expand()
    expect(screen.getByText('Route')).toBeInTheDocument()
    expect(get).toHaveBeenCalledWith('/agents/agent-1/executions/run-1/trace')
  })
})
