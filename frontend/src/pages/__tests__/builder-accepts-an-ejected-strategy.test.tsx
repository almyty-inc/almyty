/**
 * The builder has to accept the graph eject produces.
 *
 * "Eject to an editable graph" compiles the agent's strategy and saves the
 * result. Every compiled model call carries `roleKey` and deliberately
 * never a provider or a routing policy — that is what keeps an ejected
 * graph as portable as the strategy it came from, and the backend is
 * happy with it: the executor fills the role at run time and the pipeline
 * validator has no llm_call case at all.
 *
 * The builder disagreed. It pushed "missing a provider or a routing
 * policy" for every step and disabled Save, so the one screen eject lands
 * you on could not save what eject had just written. The only way to
 * clear the banner was to pin a provider on each node, which throws away
 * the portability the layer exists for.
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

vi.mock('@/store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn() }),
}))

// The canvas is a real React Flow instance and is not what is under test.
vi.mock('@/components/agents/builder/canvas-area', () => ({ CanvasArea: () => null }))
vi.mock('@/components/agents/builder/test-panel', () => ({ TestPanel: () => null }))
vi.mock('@/lib/analytics', () => ({ captureEvent: vi.fn() }))

/** What `POST /agents/:id/execution/eject` writes for the `cascade` strategy. */
const ejectedCascade = {
  nodes: [
    { id: 'input', type: 'input', position: { x: 0, y: 0 }, data: {} },
    { id: 'draft', type: 'llm_call', position: { x: 220, y: 0 }, data: { roleKey: 'drafter', strategyKey: 'cascade' } },
    {
      id: 'check',
      type: 'verify',
      position: { x: 440, y: 0 },
      data: { roleKey: 'verifier', checkers: [{ name: 'verifier', roleKey: 'verifier' }] },
    },
    { id: 'check__gate', type: 'condition', position: { x: 570, y: 120 }, data: { expression: '{{nodes.check.output.passed}} == true' } },
    { id: 'escalate', type: 'llm_call', position: { x: 660, y: 0 }, data: { roleKey: 'principal', strategyKey: 'cascade' } },
    { id: 'output', type: 'output', position: { x: 880, y: 0 }, data: {} },
  ],
  edges: [
    { id: 'e1', source: 'input', target: 'draft' },
    { id: 'e2', source: 'draft', target: 'check' },
    { id: 'e3', source: 'check', target: 'check__gate' },
    { id: 'e4', source: 'check__gate', target: 'escalate', sourceHandle: 'false' },
    { id: 'e5', source: 'check__gate', target: 'output', sourceHandle: 'true' },
    { id: 'e6', source: 'escalate', target: 'output' },
  ],
}

const agentWith = (pipeline: any) => ({
  id: 'agent-1',
  name: 'Cascading agent',
  organizationId: 'org-1',
  status: 'draft',
  version: '1.0.0',
  mode: 'workflow',
  pipeline,
})

describe('the builder accepts a graph ejected from a strategy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const saveButton = () => screen.getByRole('button', { name: /save/i })

  it('does not complain about a model call that names a role', async () => {
    vi.mocked(agentsApi.getById).mockResolvedValue(agentWith(ejectedCascade) as any)

    renderWithProviders(<AgentBuilderPage />)

    await waitFor(() => expect(screen.getByDisplayValue('Cascading agent')).toBeInTheDocument())
    await waitFor(() => expect(saveButton()).toBeEnabled())
    expect(screen.queryByText(/is missing a provider/i)).not.toBeInTheDocument()
  })

  it('still complains about a model call that names nothing at all', async () => {
    const pinnedNothing = {
      ...ejectedCascade,
      nodes: ejectedCascade.nodes.map((n) => (n.id === 'draft' ? { ...n, data: {} } : n)),
    }
    vi.mocked(agentsApi.getById).mockResolvedValue(agentWith(pinnedNothing) as any)

    renderWithProviders(<AgentBuilderPage />)

    await waitFor(() => expect(screen.getByText(/Model Call node "draft" is missing/i)).toBeInTheDocument())
    expect(saveButton()).toBeDisabled()
  })

  it('still accepts a hand-drawn node that pins a provider, and one that routes', async () => {
    const handDrawn = {
      ...ejectedCascade,
      nodes: ejectedCascade.nodes.map((n) =>
        n.id === 'draft'
          ? { ...n, data: { providerId: 'prov-1' } }
          : n.id === 'escalate'
            ? { ...n, data: { routing: { objective: 'cheapest' } } }
            : n,
      ),
    }
    vi.mocked(agentsApi.getById).mockResolvedValue(agentWith(handDrawn) as any)

    renderWithProviders(<AgentBuilderPage />)

    await waitFor(() => expect(saveButton()).toBeEnabled())
    expect(screen.queryByText(/is missing a provider/i)).not.toBeInTheDocument()
  })
})
