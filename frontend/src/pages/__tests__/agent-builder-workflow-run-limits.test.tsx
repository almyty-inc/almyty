/**
 * Run limits on a workflow agent.
 *
 * The Run limits card lived only in the autonomous config, so a workflow
 * agent's limits could be set through the API and nowhere on the page --
 * even though workflow runs honour them. The workflow builder's agent
 * settings now carry the same card: the one-line summary up front, the
 * fields under Advanced, saved in agentConfig like the autonomous page.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderWithProviders } from '@/test/setup'
import { AgentBuilderPage } from '../agent-builder'
import { agentsApi } from '@/lib/api'

const params: { id?: string } = {}

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return {
    ...actual,
    useParams: () => params,
    useNavigate: () => vi.fn(),
    useSearchParams: () => [new URLSearchParams(), vi.fn()],
  }
})

vi.mock('@/lib/api', () => ({
  agentsApi: {
    getById: vi.fn(),
    getAll: vi.fn().mockResolvedValue([]),
    getTemplates: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    update: vi.fn(),
  },
  llmProvidersApi: { getAll: vi.fn().mockResolvedValue([]) },
  toolsApi: { getAll: vi.fn().mockResolvedValue([]) },
  organizationsApi: { getTeams: vi.fn().mockResolvedValue([]) },
}))

vi.mock('@/store/organization', () => ({
  useOrganizationStore: (selector?: (s: any) => unknown) => {
    const state = {
      currentOrganization: {
        id: 'org-1',
        name: 'Acme',
        settings: { defaultRouting: { policy: 'default' } },
        // The organization's ceiling sits above the agent's, and the line counts it.
        agentDefaults: { maxCostPerRun: 0.5 },
      },
    }
    return selector ? selector(state) : state
  },
}))

vi.mock('@/store/app', () => ({ useNotifications: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('@/components/agents/builder/canvas-area', () => ({ CanvasArea: () => null }))
vi.mock('@/components/agents/builder/test-panel', () => ({ TestPanel: () => null }))
vi.mock('@/lib/analytics', () => ({ captureEvent: vi.fn() }))

const pipeline = {
  nodes: [
    { id: 'input_1', type: 'input', position: { x: 0, y: 0 }, data: {} },
    { id: 'llm_1', type: 'llm_call', position: { x: 200, y: 0 }, data: { providerId: 'prov-1', userPromptTemplate: '{{input.message}}' } },
    { id: 'output_1', type: 'output', position: { x: 400, y: 0 }, data: {} },
  ],
  edges: [
    { id: 'e1', source: 'input_1', target: 'llm_1' },
    { id: 'e2', source: 'llm_1', target: 'output_1' },
  ],
}

function openWorkflowAgent(agentConfig: Record<string, any>) {
  params.id = 'agent-1'
  vi.mocked(agentsApi.getById).mockResolvedValue({
    id: 'agent-1',
    name: 'Flow',
    organizationId: 'org-1',
    status: 'draft',
    version: '1.0.0',
    mode: 'workflow',
    pipeline,
    visibility: 'org',
    teamId: null,
    agentConfig,
  } as any)
  vi.mocked(agentsApi.update).mockResolvedValue({ id: 'agent-1' } as any)
  renderWithProviders(<AgentBuilderPage />)
}

describe('run limits in the workflow builder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete params.id
  })

  it('shows the same Run limits card, summary first, from the agent settings', async () => {
    const user = userEvent.setup()
    openWorkflowAgent({ runLimits: { maxSteps: 20 } })

    await user.click(await screen.findByRole('button', { name: 'Agent settings' }))
    const panel = screen.getByRole('region', { name: 'Agent settings' })
    // Inline under the toolbar, not a dialog over the canvas.
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(within(panel).getByText('Run limits')).toBeInTheDocument()
    expect(within(panel).getByTestId('run-limits-summary')).toHaveTextContent(
      'Stops after 20 steps, $0.50 or 15 minutes, whichever comes first.',
    )
    // The fields wait under Advanced.
    expect(within(panel).queryByLabelText('Max steps')).not.toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: /Advanced/ })).toHaveAttribute('aria-expanded', 'false')
  })

  it('saves what is typed there with the agent, keeping the rest of agentConfig', async () => {
    const user = userEvent.setup()
    openWorkflowAgent({ runLimits: { maxSteps: 20 }, runnerLabels: { gpu: 'yes' } })

    await user.click(await screen.findByRole('button', { name: 'Agent settings' }))
    const panel = screen.getByRole('region', { name: 'Agent settings' })
    await user.click(within(panel).getByRole('button', { name: /Advanced/ }))
    const steps = within(panel).getByLabelText('Max steps')
    await user.clear(steps)
    await user.type(steps, '10')
    expect(within(panel).getByTestId('run-limits-summary')).toHaveTextContent('Stops after 10 steps')

    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(agentsApi.update).toHaveBeenCalled())
    const payload = vi.mocked(agentsApi.update).mock.calls[0][1] as any
    expect(payload.agentConfig).toEqual({ runLimits: { maxSteps: 10 }, runnerLabels: { gpu: 'yes' } })
  })

  it('is not offered on the autonomous page, which has the card inline already', async () => {
    params.id = 'agent-1'
    vi.mocked(agentsApi.getById).mockResolvedValue({
      id: 'agent-1',
      name: 'Loop',
      organizationId: 'org-1',
      status: 'draft',
      version: '1.0.0',
      mode: 'autonomous',
      pipeline: { nodes: [], edges: [] },
      instructions: 'Answer.',
      modelConfig: { providerId: 'prov-1', model: 'gpt-4o' },
      agentConfig: {},
    } as any)
    renderWithProviders(<AgentBuilderPage />)
    expect(await screen.findByTestId('run-limits-summary')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Agent settings' })).not.toBeInTheDocument()
  })
})
