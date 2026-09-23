/**
 * The builder has to refuse what the server refuses, on the canvas rather
 * than in a toast after the round trip.
 *
 * `AgentValidationHelper.validatePipeline` rejects a second Input node and
 * any node not reachable from the input -- "an unconnected node still runs,
 * in the first layer, before anything else", so the bill is real. The
 * builder checked neither: Save stayed enabled and the answer arrived as a
 * 400 with the graph still on screen and nothing marking which node.
 *
 * This is the wiring test for validate-graph.ts. Its own rules are covered
 * in components/agents/builder/__tests__/validate-graph.test.ts; what is
 * under test here is that the page actually calls it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'

import { renderWithProviders } from '@/test/setup'
import { AgentBuilderPage } from '../agent-builder'
import { agentsApi } from '@/lib/api'

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return {
    ...actual,
    useParams: () => ({ id: 'agent-1' }),
    useNavigate: () => vi.fn(),
    useSearchParams: () => [new URLSearchParams(), vi.fn()],
  }
})

vi.mock('@/lib/api', () => ({
  agentsApi: { getById: vi.fn(), getTemplates: vi.fn().mockResolvedValue([]), update: vi.fn() },
  llmProvidersApi: { getAll: vi.fn().mockResolvedValue([]) },
  toolsApi: { getAll: vi.fn().mockResolvedValue([]) },
}))

vi.mock('@/store/organization', () => ({
  useOrganizationStore: (selector?: (s: any) => unknown) => {
    const state = { currentOrganization: { id: 'org-1', name: 'Acme' } }
    return selector ? selector(state) : state
  },
}))

vi.mock('@/store/app', () => ({ useNotifications: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('@/components/agents/builder/canvas-area', () => ({ CanvasArea: () => null }))
vi.mock('@/components/agents/builder/test-panel', () => ({ TestPanel: () => null }))
vi.mock('@/lib/analytics', () => ({ captureEvent: vi.fn() }))

const agentWith = (pipeline: any) => ({
  id: 'agent-1',
  name: 'Drafting agent',
  organizationId: 'org-1',
  status: 'draft',
  version: '1.0.0',
  mode: 'workflow',
  pipeline,
})

const straightLine = {
  nodes: [
    { id: 'input_1', type: 'input', position: { x: 0, y: 0 }, data: {} },
    { id: 'llm_1', type: 'llm_call', position: { x: 200, y: 0 }, data: { providerId: 'prov-1' } },
    { id: 'output_1', type: 'output', position: { x: 400, y: 0 }, data: {} },
  ],
  edges: [
    { id: 'e1', source: 'input_1', target: 'llm_1' },
    { id: 'e2', source: 'llm_1', target: 'output_1' },
  ],
}

describe('the builder refuses the graphs the server refuses', () => {
  beforeEach(() => vi.clearAllMocks())

  const saveButton = () => screen.getByRole('button', { name: /save/i })

  it('blocks Save on a node that is connected to nothing', async () => {
    vi.mocked(agentsApi.getById).mockResolvedValue(
      agentWith({
        ...straightLine,
        nodes: [
          ...straightLine.nodes,
          { id: 'orphan_1', type: 'transform', position: { x: 200, y: 200 }, data: { expression: '' } },
        ],
      }) as any,
    )

    renderWithProviders(<AgentBuilderPage />)

    await waitFor(() => expect(screen.getByText(/Transform: connect it, or delete it/)).toBeInTheDocument())
    expect(saveButton()).toBeDisabled()
  })

  it('blocks Save on a second Input node', async () => {
    vi.mocked(agentsApi.getById).mockResolvedValue(
      agentWith({
        nodes: [
          ...straightLine.nodes,
          { id: 'input_2', type: 'input', position: { x: 0, y: 200 }, data: {} },
        ],
        edges: [...straightLine.edges, { id: 'e3', source: 'input_2', target: 'llm_1' }],
      }) as any,
    )

    renderWithProviders(<AgentBuilderPage />)

    await waitFor(() =>
      expect(screen.getByText(/Keep one Input step and delete the others/)).toBeInTheDocument(),
    )
    expect(saveButton()).toBeDisabled()
  })

  it('leaves a well-formed pipeline saveable', async () => {
    vi.mocked(agentsApi.getById).mockResolvedValue(agentWith(straightLine) as any)

    renderWithProviders(<AgentBuilderPage />)

    await waitFor(() => expect(screen.getByDisplayValue('Drafting agent')).toBeInTheDocument())
    await waitFor(() => expect(saveButton()).toBeEnabled())
  })
})
