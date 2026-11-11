/**
 * Found building real agents on staging:
 *
 * - a workflow agent's runs never appeared on the Runs tab (it listed
 *   autonomous runs only), Recent runs said "--" for the model of a run
 *   whose steps were pinned to a model, and clicking a row opened nothing;
 * - an answer whose checks still failed when the revisions ran out was
 *   shown with nothing to say so;
 * - Try it joined an answer's lines and showed its tables as pipes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import { Route, Routes, useParams } from 'react-router-dom'

import { renderWithProviders } from '@/test/setup'
import { agentsApi } from '@/lib/api'
import { OverviewTab } from '../overview-tab'
import { RunsTab } from '../runs-tab'
import { unverifiedAnswer } from '../verify-step'
import { AssistantMarkdown } from '@/components/hosted-chat/assistant-markdown'
import type { Agent, AgentExecution, AgentRun } from '@/types'

// A row click navigates for real here (setup.tsx stubs useNavigate for every suite).
vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))
vi.mock('@/store/app', () => ({ useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }))
vi.mock('@/lib/api', () => ({ agentsApi: { invoke: vi.fn(), getRun: vi.fn() } }))
vi.mock('@/lib/models-api', () => ({ modelsApi: { list: vi.fn().mockResolvedValue([]) } }))
vi.mock('../integration-snippets', () => ({ IntegrationSnippets: () => null }))
vi.mock('../agent-config-panel', () => ({ AgentConfigPanel: () => null }))
vi.mock('../route-trace-timeline', () => ({ RouteTraceTimeline: () => null }))
vi.mock('@/hooks/use-live-run', () => ({ useLiveRun: (_a: string, run: AgentRun) => ({ run, connection: 'idle' }) }))

const agent = { id: 'a-1', name: 'Invoice checker', mode: 'workflow', status: 'active', pipeline: { nodes: [], edges: [] } } as unknown as Agent

const exec = (id: string, createdAt: string, over: Partial<AgentExecution> = {}): AgentExecution => ({
  id, agentId: 'a-1', organizationId: 'org-1', status: 'completed', executionTime: 1200, totalCost: 0.002, totalTokens: 300,
  input: { invoices: 'INV-1' }, output: 'All paid.', createdAt, updatedAt: createdAt,
  nodeResults: {
    input_1: { nodeId: 'input_1', nodeType: 'input', status: 'completed' },
    llm_1: { nodeId: 'llm_1', nodeType: 'llm_call', status: 'completed', output: 'All paid.', model: 'gpt-4o-mini' } as any,
  },
  ...over,
})

const run = (id: string, createdAt: string, over: Partial<AgentRun> = {}): AgentRun => ({
  id, agentId: 'a-1', organizationId: 'org-1', mode: 'autonomous', status: 'completed', thread: [], workingMemory: {},
  steps: [], currentStep: 1, maxSteps: 20, totalCost: 0, totalTokens: 0, executionTime: 1000, createdAt, updatedAt: createdAt, ...over,
})

const failedCheck = {
  metadata: { verify: { verdict: 'fail', revisions: 2, exhausted: true } },
  output: "Note: this answer's check didn't pass: the total is off.\n\nTotal: 40",
}

function OpenedRun() {
  const { runId } = useParams()
  return <p data-testid="opened">{runId}</p>
}

describe('every run, on the Runs tab and in Recent runs', () => {
  beforeEach(() => vi.clearAllMocks())

  it('lists workflow runs with autonomous ones, newest first, and opens a workflow run step by step', () => {
    renderWithProviders(
      <RunsTab runs={[run('r-1', '2026-11-10T10:00:00Z')]} executions={[exec('e-1', '2026-11-10T11:00:00Z')]} agentId="a-1" openRunId="e-1" />,
    )
    const rows = screen.getAllByRole('button').filter((r) => r.tagName === 'TR')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveAttribute('data-testid', 'execution-row-e-1')
    // Opened from a link to /agents/:id/runs/e-1.
    const detail = screen.getByTestId('execution-detail-e-1')
    expect(within(detail).getByText('gpt-4o-mini', { selector: 'span' })).toBeInTheDocument()
    expect(within(detail).getByText('Model call')).toBeInTheDocument()
  })

  it("shows the model of a workflow run whose steps were pinned, and a row opens the run", () => {
    window.history.pushState({}, '', '/agents/a-1')
    renderWithProviders(
      <Routes>
        <Route path="/agents/:id" element={<OverviewTab agent={agent} executions={[exec('e-1', '2026-11-10T11:00:00Z')]} executionsError={null}
          versions={[]} entityVersions={[]} auditLog={[]} webhookUrl="" setWebhookUrl={vi.fn()} />} />
        <Route path="/agents/:id/runs/:runId" element={<OpenedRun />} />
      </Routes>,
    )
    const row = screen.getByTestId('recent-run-e-1')
    expect(within(row).getByText('gpt-4o-mini')).toBeInTheDocument()
    fireEvent.click(row)
    expect(screen.getByTestId('opened')).toHaveTextContent('e-1')
  })
})

describe('an answer whose checks still failed', () => {
  beforeEach(() => vi.clearAllMocks())

  it('is told apart from a checked one', () => {
    expect(unverifiedAnswer({ status: 'completed', ...failedCheck })).toBe(true)
    expect(unverifiedAnswer({ status: 'completed', metadata: { verify: { verdict: 'pass' } } })).toBe(false)
    // A run checked in patch mode records the verdict on its last check only.
    expect(unverifiedAnswer({ status: 'completed', steps: [{ type: 'verify', input: { mode: 'patch' }, output: { verdict: 'fail', exhausted: true } }] })).toBe(true)
    expect(unverifiedAnswer({ status: 'completed', steps: [{ type: 'verify', input: { mode: 'mid_loop' }, output: { verdict: 'fail' } }] })).toBe(false)
  })

  it('is marked in the run list and in Recent runs', () => {
    const runs = [run('r-1', '2026-11-10T10:00:00Z', failedCheck)]
    renderWithProviders(
      <>
        <RunsTab runs={runs} agentId="a-1" />
        <OverviewTab agent={{ ...agent, mode: 'autonomous' } as Agent} executions={[]} runs={runs} executionsError={null}
          versions={[]} entityVersions={[]} auditLog={[]} webhookUrl="" setWebhookUrl={vi.fn()} />
      </>,
    )
    const badges = screen.getAllByTestId('unverified-badge')
    expect(badges).toHaveLength(2)
    expect(badges[0]).toHaveTextContent('Not verified')
  })

  it('is marked in Try it', async () => {
    vi.mocked(agentsApi.invoke).mockResolvedValue({ status: 'completed', ...failedCheck } as any)
    renderWithProviders(<OverviewTab agent={agent} executions={[]} executionsError={null} versions={[]}
      entityVersions={[]} auditLog={[]} webhookUrl="" setWebhookUrl={vi.fn()} />)
    const box = screen.getByRole('textbox', { name: 'Message' })
    fireEvent.change(box, { target: { value: 'Check March' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(await screen.findByTestId('unverified-note')).toHaveTextContent('Not verified')
  })
})

describe('Try it renders an answer like hosted chat', () => {
  it('keeps line breaks and renders tables', async () => {
    const { container } = renderWithProviders(
      <AssistantMarkdown>{'Total: 40\nDue: Friday\n\n| Invoice | Amount |\n| --- | --- |\n| INV-1 | 30 |'}</AssistantMarkdown>,
    )
    // The renderer loads off the first paint.
    expect(await screen.findByRole('table', undefined, { timeout: 15000 })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'INV-1' })).toBeInTheDocument()
    expect(container.querySelector('p br')).not.toBeNull()
  }, 20000)
})
