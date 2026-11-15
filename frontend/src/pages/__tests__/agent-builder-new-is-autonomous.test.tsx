/**
 * A new agent starts autonomous: a goal, tools and a model, and it works out
 * the steps. Workflow is one click away on the switch at the top. A template
 * that lays out steps opens as the workflow it is.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderWithProviders } from '@/test/setup'
import { AgentBuilderPage, NEW_AGENT_MODE, templateMode } from '../agent-builder'

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
    const state = { currentOrganization: { id: 'org-1', name: 'Acme', settings: {} } }
    return selector ? selector(state) : state
  },
}))

vi.mock('@/store/app', () => ({ useNotifications: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('@/components/agents/builder/canvas-area', () => ({ CanvasArea: () => <div data-testid="canvas" /> }))
vi.mock('@/components/agents/builder/test-panel', () => ({ TestPanel: () => null }))
vi.mock('@/lib/analytics', () => ({ captureEvent: vi.fn() }))

describe('Create agent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete params.id
  })

  it('opens on Autonomous, with Workflow one click away', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AgentBuilderPage />)

    const autonomous = await screen.findByRole('button', { name: 'Autonomous' })
    expect(autonomous).toHaveAttribute('aria-pressed', 'true')
    const workflow = screen.getByRole('button', { name: 'Workflow' })
    expect(workflow).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByTestId('canvas')).toBeNull()

    await user.click(workflow)
    expect(workflow).toHaveAttribute('aria-pressed', 'true')
    expect(await screen.findByTestId('canvas')).toBeInTheDocument()
  })

  it('a template that lays out steps is a workflow; one that names its mode keeps it', () => {
    expect(NEW_AGENT_MODE).toBe('autonomous')
    expect(templateMode({ pipeline: { nodes: [{ id: 'input_1' }] } })).toBe('workflow')
    expect(templateMode({ pipeline: { nodes: [] } })).toBe('autonomous')
    expect(templateMode({ mode: 'autonomous', pipeline: { nodes: [{ id: 'input_1' }] } })).toBe('autonomous')
  })
})
