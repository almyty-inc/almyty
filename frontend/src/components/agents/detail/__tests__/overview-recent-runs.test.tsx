/**
 * Recent runs on an agent's Overview. It read workflow executions only, so
 * an autonomous agent that had run many times still said "No runs yet".
 * An autonomous agent's runs are listed there too, newest first, with the
 * models their calls went to.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, within } from '@testing-library/react'

import { renderWithProviders } from '@/test/setup'
import { OverviewTab, recentRunRows } from '../overview-tab'
import type { Agent, AgentExecution, AgentRun } from '@/types'

vi.mock('@/lib/api', () => ({
  agentsApi: { invoke: vi.fn(), rollback: vi.fn(), update: vi.fn() },
}))
vi.mock('@/lib/models-api', () => ({ modelsApi: { list: vi.fn().mockResolvedValue([]) } }))
vi.mock('@/store/app', () => ({ useNotifications: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('@/store/organization', () => ({
  useOrganizationStore: (selector?: (s: any) => unknown) => {
    const state = { currentOrganization: { id: 'org-1' } }
    return selector ? selector(state) : state
  },
}))
vi.mock('../integration-snippets', () => ({ IntegrationSnippets: () => null }))
vi.mock('../agent-config-panel', () => ({ AgentConfigPanel: () => null }))
vi.mock('@/components/ui/code-editor', () => ({ CodeEditor: () => null }))

const agent = {
  id: 'agent-1', name: 'Researcher', mode: 'autonomous', status: 'active',
  version: 1, totalExecutions: 0, totalCost: 0,
  pipeline: { nodes: [], edges: [] },
} as unknown as Agent

function run(id: string, createdAt: string, overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id, agentId: 'agent-1', organizationId: 'org-1', mode: 'autonomous', status: 'completed',
    thread: [], workingMemory: {}, steps: [], currentStep: 1, maxSteps: 20, totalCost: 0.0123, totalTokens: 1500,
    executionTime: 2500, createdAt, updatedAt: createdAt, ...overrides,
  }
}

const execution = (id: string, createdAt: string): AgentExecution => ({
  id, agentId: 'agent-1', organizationId: 'org-1', status: 'completed', executionTime: 1000,
  totalCost: 0, totalTokens: 0, createdAt, updatedAt: createdAt,
})

describe('Recent runs on Overview', () => {
  it("lists an autonomous agent's runs instead of saying it has none", () => {
    const runs = [
      run('run-1', '2026-09-30T10:00:00Z', {
        steps: [
          { type: 'llm_call', timestamp: '2026-09-30T10:00:01Z', output: { model: 'gpt-4o-mini' } },
          { type: 'llm_call', timestamp: '2026-09-30T10:00:02Z', output: { model: 'gpt-4o-mini' } },
        ],
      }),
      run('run-2', '2026-09-30T11:00:00Z', { status: 'waiting_input' }),
    ]
    renderWithProviders(
      <OverviewTab agent={agent} executions={[]} runs={runs} executionsError={null} versions={[]}
        entityVersions={[]} auditLog={[]} webhookUrl="" setWebhookUrl={vi.fn()} scheduleEnabled={false}
        setScheduleEnabled={vi.fn()} scheduleInterval={60} setScheduleInterval={vi.fn()}
        scheduleInput="{}" setScheduleInput={vi.fn()} />,
    )

    expect(screen.queryByText('No runs yet')).not.toBeInTheDocument()
    const rows = screen.getAllByRole('row').slice(1)
    expect(rows).toHaveLength(2)
    // Newest first.
    expect(within(rows[0]).getByText('Waiting for input')).toBeInTheDocument()
    expect(within(rows[1]).getByText('gpt-4o-mini')).toBeInTheDocument()
    expect(within(rows[1]).getByText('$0.0123')).toBeInTheDocument()
  })

  it('merges executions and runs, newest first', () => {
    const rows = recentRunRows(
      [execution('e-old', '2026-09-29T09:00:00Z'), execution('e-new', '2026-09-30T12:00:00Z')],
      [run('r-mid', '2026-09-30T08:00:00Z')],
    )
    expect(rows.map((r) => r.id)).toEqual(['e-new', 'r-mid', 'e-old'])
  })
})

// On a phone the overview ran to about 13,700px: twenty recent runs, then
// the pipeline, versions, change history and audit log, all open.
describe('a short overview', () => {
  const many = Array.from({ length: 12 }, (_, i) => run(`run-${i}`, `2026-09-${String(10 + i).padStart(2, '0')}T10:00:00Z`))
  const renderOverview = (onShowAllRuns = vi.fn()) =>
    renderWithProviders(
      <OverviewTab agent={agent} executions={[]} runs={many} executionsError={null} versions={[]}
        entityVersions={[{ id: 1, itemType: 'Agent', itemId: 'agent-1', event: 'INSERT', owner: 'a@b.c', object: {}, timestamp: '2026-09-01T10:00:00Z' }]}
        auditLog={[{ action: 'activated', timestamp: '2026-09-01T10:00:00Z', userId: 'user-1' } as any]}
        webhookUrl="" setWebhookUrl={vi.fn()} onShowAllRuns={onShowAllRuns} />,
    )

  it('lists the five newest runs and offers the rest on the Runs tab', async () => {
    const onShowAllRuns = vi.fn()
    renderOverview(onShowAllRuns)
    const table = screen.getByTestId('recent-run-run-11').closest('table')!
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(5)
    expect(screen.queryByTestId('recent-run-run-6')).toBeNull()
    screen.getByRole('button', { name: 'See all runs' }).click()
    expect(onShowAllRuns).toHaveBeenCalled()
  })

  it('keeps the history closed until asked for', () => {
    renderOverview()
    const history = screen.getByTestId('overview-history')
    expect(within(history).getByRole('button', { name: /History/ })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Audit log')).toBeNull()
    within(history).getByRole('button', { name: /History/ }).click()
  })
})