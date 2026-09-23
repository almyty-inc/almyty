/**
 * "Private (just me)" on an agent. Agents are created and edited in the
 * builder (/agents/new, /agents/:id/edit), so that is where the choice has
 * to live, reach the server on save, and survive an edit: an edit that
 * posted the org-wide default would quietly publish a private agent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
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
    // An org default route makes the starting graph's bare model call
    // saveable, so a new draft can be saved without further setup.
    const state = { currentOrganization: { id: 'org-1', name: 'Acme', settings: { defaultRouting: { policy: 'default' } } } }
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
    { id: 'llm_1', type: 'llm_call', position: { x: 200, y: 0 }, data: { providerId: 'prov-1' } },
    { id: 'output_1', type: 'output', position: { x: 400, y: 0 }, data: {} },
  ],
  edges: [
    { id: 'e1', source: 'input_1', target: 'llm_1' },
    { id: 'e2', source: 'llm_1', target: 'output_1' },
  ],
}

describe('agent visibility in the builder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete params.id
  })

  it('sends visibility "private" when a new agent is made private', async () => {
    vi.mocked(agentsApi.create).mockResolvedValue({ id: 'new-agent' } as any)
    const user = userEvent.setup()
    renderWithProviders(<AgentBuilderPage />)

    await user.click(await screen.findByRole('button', { name: 'Visibility: Org-wide' }))
    await user.click(screen.getByRole('radio', { name: /Private/ }))
    expect(screen.getByText(/Only you can see and use this agent/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Visibility: Private' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => expect(agentsApi.create).toHaveBeenCalled())
    expect(vi.mocked(agentsApi.create).mock.calls[0][0]).toMatchObject({ visibility: 'private', teamId: null })
  })

  it('loads an existing private agent as private and keeps it private on save', async () => {
    params.id = 'agent-1'
    vi.mocked(agentsApi.getById).mockResolvedValue({
      id: 'agent-1',
      name: 'Mine',
      organizationId: 'org-1',
      status: 'draft',
      version: '1.0.0',
      mode: 'workflow',
      pipeline,
      visibility: 'private',
      teamId: null,
    } as any)
    vi.mocked(agentsApi.update).mockResolvedValue({ id: 'agent-1' } as any)
    const user = userEvent.setup()
    renderWithProviders(<AgentBuilderPage />)

    expect(await screen.findByRole('button', { name: 'Visibility: Private' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: /save/i })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => expect(agentsApi.update).toHaveBeenCalled())
    expect(vi.mocked(agentsApi.update).mock.calls[0][1]).toMatchObject({ visibility: 'private', teamId: null })
  })
})
