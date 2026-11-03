/**
 * An agent that uses private (owner-only) tools, such as a runner's tools.
 *
 * The server only lets a private agent of the same owner use them, and
 * refuses the save otherwise (400 "These tools are private to their owner
 * ..."). New agents started as Everyone, so the first save failed, and the
 * refusal never reached the person. Now a new agent that uses a private
 * tool starts private, and a refused save is answered next to Save with
 * the fix: "Make it private and save".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderWithProviders } from '@/test/setup'
import { AgentBuilderPage } from '../agent-builder'
import { agentsApi, toolsApi } from '@/lib/api'
import { isPrivateReferenceRefusal, privateToolsAmong, referencedToolIds } from '@/components/agents/builder/private-tools'

const params: { id?: string } = {}
let search = new URLSearchParams()

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return {
    ...actual,
    useParams: () => params,
    useNavigate: () => vi.fn(),
    useSearchParams: () => [search, vi.fn()],
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

const REFUSAL =
  "These tools are private to their owner and can only be used by that owner's own private agent: runner.laptop.shell_exec. " +
  'Make this agent private, or share the tool with the organization first.'

const pipeline = {
  nodes: [
    { id: 'input_1', type: 'input', position: { x: 0, y: 0 }, data: {} },
    { id: 'tool_1', type: 'tool_call', position: { x: 200, y: 0 }, data: { toolId: 'tool-private' } },
    { id: 'output_1', type: 'output', position: { x: 400, y: 0 }, data: { mapping: '{{nodes.tool_1.output}}' } },
  ],
  edges: [
    { id: 'e1', source: 'input_1', target: 'tool_1' },
    { id: 'e2', source: 'tool_1', target: 'output_1' },
  ],
}
const tools = [
  { id: 'tool-private', name: 'runner.laptop.shell_exec', visibility: 'private' },
  { id: 'tool-shared', name: 'weather', visibility: 'org' },
]

describe('private tools in an agent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete params.id
    search = new URLSearchParams()
    vi.mocked(toolsApi.getAll).mockResolvedValue(tools as any)
  })

  it('answers a refused save next to Save, and makes it private and saves on one click', async () => {
    params.id = 'agent-1'
    vi.mocked(agentsApi.getById).mockResolvedValue({
      id: 'agent-1', name: 'Shell', organizationId: 'org-1', status: 'draft', version: '1.0.0',
      mode: 'workflow', pipeline, visibility: 'org', teamId: null,
    } as any)
    vi.mocked(agentsApi.update)
      .mockRejectedValueOnce({ response: { status: 400, data: { message: REFUSAL } } })
      .mockResolvedValueOnce({ id: 'agent-1' } as any)
    const user = userEvent.setup()
    renderWithProviders(<AgentBuilderPage />)

    await waitFor(() => expect(screen.getByRole('button', { name: /save/i })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /save/i }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('private to their owner')
    expect(notify.error).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Make it private and save' }))
    await waitFor(() => expect(agentsApi.update).toHaveBeenCalledTimes(2))
    expect(vi.mocked(agentsApi.update).mock.calls[1][1]).toMatchObject({ visibility: 'private', teamId: null })
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Visibility: Only you' })).toBeInTheDocument()
  })

  it('starts a new agent that uses a private tool as private', async () => {
    search = new URLSearchParams('template=tpl-1')
    vi.mocked(agentsApi.getTemplates).mockResolvedValue([{ id: 'tpl-1', name: 'Shell runner', pipeline }] as any)
    vi.mocked(agentsApi.create).mockResolvedValue({ id: 'new-agent' } as any)
    const user = userEvent.setup()
    renderWithProviders(<AgentBuilderPage />)

    expect(await screen.findByRole('button', { name: 'Visibility: Only you' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Visibility: Only you' }))
    expect(screen.getByText(/runner\.laptop\.shell_exec/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(agentsApi.create).toHaveBeenCalled())
    expect(vi.mocked(agentsApi.create).mock.calls[0][0]).toMatchObject({ visibility: 'private' })
  })

  it('leaves the choice alone once the person picked who can use it', async () => {
    search = new URLSearchParams('template=tpl-1')
    vi.mocked(agentsApi.getTemplates).mockResolvedValue([{ id: 'tpl-1', name: 'Shell runner', pipeline }] as any)
    const user = userEvent.setup()
    renderWithProviders(<AgentBuilderPage />)

    await user.click(await screen.findByRole('button', { name: 'Visibility: Only you' }))
    await user.click(screen.getByRole('radio', { name: /^Everyone/ }))
    expect(screen.getByRole('button', { name: 'Visibility: Everyone' })).toBeInTheDocument()
  })
})

describe('private-tools helpers', () => {
  it('reads tool references the way the server does, per mode', () => {
    expect(referencedToolIds('autonomous', ['a'], pipeline.nodes)).toEqual(['a'])
    expect(referencedToolIds('workflow', ['a'], [...pipeline.nodes, { type: 'llm_call', data: { toolIds: ['b'] } }])).toEqual(['tool-private', 'b'])
    expect(privateToolsAmong(['tool-private', 'tool-shared'], tools as any).map((t) => t.id)).toEqual(['tool-private'])
    expect(isPrivateReferenceRefusal(REFUSAL)).toBe(true)
    expect(isPrivateReferenceRefusal('Name the agent')).toBe(false)
  })
})
