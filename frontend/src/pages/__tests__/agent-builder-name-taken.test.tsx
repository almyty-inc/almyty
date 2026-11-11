/**
 * Two agents in one organization may not share a name: the server refuses
 * the save with a 409. The refusal is said beside the name, where it is
 * fixed, and goes away as soon as the name is edited.
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
    const state = { currentOrganization: { id: 'org-1', name: 'Acme', settings: { defaultRouting: { policy: 'default' } } } }
    return selector ? selector(state) : state
  },
}))

const notify = { success: vi.fn(), error: vi.fn() }
vi.mock('@/store/app', () => ({ useNotifications: () => notify }))
vi.mock('@/components/agents/builder/canvas-area', () => ({ CanvasArea: () => null }))
vi.mock('@/components/agents/builder/test-panel', () => ({ TestPanel: () => null }))
vi.mock('@/lib/analytics', () => ({ captureEvent: vi.fn() }))

const TAKEN = 'That name is already in use in this organization; pick another.'

const pipeline = {
  nodes: [
    { id: 'input_1', type: 'input', position: { x: 0, y: 0 }, data: {} },
    { id: 'output_1', type: 'output', position: { x: 200, y: 0 }, data: { mapping: '{{input.message}}' } },
  ],
  edges: [{ id: 'e1', source: 'input_1', target: 'output_1' }],
}

describe('a name another agent already has', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    params.id = 'agent-1'
    vi.mocked(agentsApi.getById).mockResolvedValue({
      id: 'agent-1', name: 'Support', organizationId: 'org-1', status: 'draft', version: '1.0.0',
      mode: 'workflow', pipeline, visibility: 'org', teamId: null,
    } as any)
  })

  it('says so beside the name instead of in a toast, and clears it once the name changes', async () => {
    vi.mocked(agentsApi.update).mockRejectedValueOnce({ response: { status: 409, data: { message: TAKEN } } })
    const user = userEvent.setup()
    renderWithProviders(<AgentBuilderPage />)

    const name = await screen.findByDisplayValue('Support')
    await user.clear(name)
    await user.type(name, 'Invoices')
    await user.click(screen.getByRole('button', { name: /save/i }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(TAKEN)
    expect(screen.getByRole('textbox', { name: 'Agent name' })).toHaveAttribute('aria-invalid', 'true')
    expect(notify.error).not.toHaveBeenCalled()

    await user.type(screen.getByRole('textbox', { name: 'Agent name' }), ' 2')
    await waitFor(() => expect(screen.queryByText(TAKEN)).not.toBeInTheDocument())
  })
})
