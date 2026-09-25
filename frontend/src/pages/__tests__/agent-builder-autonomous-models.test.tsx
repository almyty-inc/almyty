/**
 * An autonomous agent is multi-model, and the page says how.
 *
 * The page used to show one "Model configuration" card and a separate
 * "Collaboration" card, and nothing on it explained how to build an agent
 * that uses several models. It now has a Models card (the roles) and a
 * "How they work together" card (the strategy), saved together as
 * `models`. These drive the real page, the real ModelPicker and the real
 * rules, with only the network mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
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
    getAll: vi.fn(),
    getTemplates: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    update: vi.fn(),
  },
  llmProvidersApi: {
    getAll: vi.fn().mockResolvedValue([{ id: 'prov-openai', name: 'OpenAI', type: 'openai', status: 'active' }]),
    getModels: vi.fn().mockResolvedValue([{ id: 'gpt-4o', name: 'gpt-4o' }, { id: 'gpt-4o-mini', name: 'gpt-4o-mini' }]),
  },
  toolsApi: { getAll: vi.fn().mockResolvedValue([]) },
  organizationsApi: { getTeams: vi.fn().mockResolvedValue([]) },
}))
// The picker lists the provider's synced models (one search box, no provider step).
vi.mock('@/lib/models-api', () => ({
  modelsApi: {
    list: vi.fn().mockResolvedValue([
      { id: 'card-gpt-4o', name: 'gpt-4o', vendorModelId: 'gpt-4o', providerId: 'prov-openai', status: 'active', selectable: true },
      { id: 'card-gpt-4o-mini', name: 'gpt-4o-mini', vendorModelId: 'gpt-4o-mini', providerId: 'prov-openai', status: 'active', selectable: true },
    ]),
  },
}))
// The policy editor is its own tested component; a routed role only needs the policy it starts with.
vi.mock('@/components/models/routing-policy-editor', () => ({ RoutingPolicyField: () => null }))

vi.mock('@/store/organization', () => ({
  useOrganizationStore: (selector?: (s: any) => unknown) => {
    const state = { currentOrganization: { id: 'org-1', name: 'Acme' } }
    return selector ? selector(state) : state
  },
}))
const errorNotif = vi.fn()
vi.mock('@/store/app', () => ({ useNotifications: () => ({ success: vi.fn(), error: errorNotif }) }))
vi.mock('@/components/agents/builder/canvas-area', () => ({ CanvasArea: () => null }))
vi.mock('@/components/agents/builder/test-panel', () => ({ TestPanel: () => null }))
vi.mock('@/lib/analytics', () => ({ captureEvent: vi.fn() }))

const OTHER_AGENTS = [
  { id: 'agent-1', name: 'This agent' },
  { id: 'critic', name: 'Critic' },
]

function autonomousAgent(models: any, extra: Record<string, any> = {}) {
  return {
    id: 'agent-1',
    name: 'Researcher',
    organizationId: 'org-1',
    status: 'draft',
    version: '1.0.0',
    mode: 'autonomous',
    pipeline: { nodes: [], edges: [] },
    instructions: 'Answer research questions.',
    modelConfig: { providerId: 'prov-openai', model: 'gpt-4o' },
    models,
    ...extra,
  }
}

const MAIN = { key: 'main', name: 'Main', purpose: 'main', kind: 'model', providerId: 'prov-openai', model: 'gpt-4o' }

function openAgent(models: any, extra?: Record<string, any>) {
  params.id = 'agent-1'
  vi.mocked(agentsApi.getById).mockResolvedValue(autonomousAgent(models, extra) as any)
  vi.mocked(agentsApi.update).mockResolvedValue({ id: 'agent-1' } as any)
  renderWithProviders(<AgentBuilderPage />)
}

const saveButton = () => screen.getByRole('button', { name: /save/i })


/** Pick from the one-box model picker inside a role: open it, choose the option. */
async function pickModel(role: HTMLElement, name: RegExp) {
  const trigger = await within(role).findByRole('combobox', { name: 'Model' })
  await waitFor(() => expect(trigger).not.toBeDisabled())
  fireEvent.click(trigger)
  const list = await screen.findByRole('listbox')
  fireEvent.click(await within(list).findByRole('option', { name }))
}

describe('the autonomous page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete params.id
    vi.mocked(agentsApi.getAll).mockResolvedValue(OTHER_AGENTS as any)
    // Radix Select uses pointer capture, absent in jsdom.
    if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
    if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = vi.fn()
    if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = vi.fn()
  })

  it('has Models and How they work together, and no Model configuration or Collaboration', async () => {
    openAgent({ strategy: 'single', roles: [MAIN] })

    expect(await screen.findByText('Models')).toBeInTheDocument()
    expect(screen.getByText('How they work together')).toBeInTheDocument()
    expect(screen.queryByText('Model configuration')).not.toBeInTheDocument()
    expect(screen.queryByText('Collaboration')).not.toBeInTheDocument()
    expect(screen.queryByText(/enable collaboration/i)).not.toBeInTheDocument()
    // The rest of the page is still there.
    for (const heading of ['Personality & style', 'Instructions', 'Tools', 'Memory', 'Agent capabilities', 'Heartbeat']) {
      expect(screen.getByText(heading)).toBeInTheDocument()
    }
    // Everything inline: nothing here opens a dialog.
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('starts a new agent on one Main role and Single, and saves the model picked for it', async () => {
    const user = userEvent.setup()
    vi.mocked(agentsApi.create).mockResolvedValue({ id: 'new-agent' } as any)
    renderWithProviders(<AgentBuilderPage />)

    await user.click(await screen.findByRole('button', { name: 'Autonomous' }))
    const roles = within(screen.getByTestId('models-card')).getAllByRole('listitem')
    expect(roles).toHaveLength(1)
    expect(screen.getByLabelText('Role 1 name')).toHaveValue('Main')
    expect(screen.getByTestId('strategy-option-single')).toHaveAttribute('aria-checked', 'true')
    // Not ready yet, and saying what to do.
    expect(screen.getByTestId('builder-next-steps')).toHaveTextContent('Main: pick a model, or route it by policy')

    await user.type(screen.getByPlaceholderText('You are a helpful assistant that...'), 'Answer questions.')
    const main = screen.getByTestId('role-main')
    await pickModel(main, /gpt-4o(?!-mini)/)

    await waitFor(() => expect(screen.queryByTestId('builder-next-steps')).not.toBeInTheDocument())
    await user.click(saveButton())

    await waitFor(() => expect(agentsApi.create).toHaveBeenCalled())
    const sent = vi.mocked(agentsApi.create).mock.calls[0][0] as any
    expect(sent.models).toEqual({
      strategy: 'single',
      roles: [{ key: 'main', name: 'Main', purpose: 'main', kind: 'model', providerId: 'prov-openai', model: 'gpt-4o' }],
    })
    expect(sent.collaboration).toBeNull()
    // The roles are the source of truth; the server mirrors main into modelConfig.
    expect(sent).not.toHaveProperty('modelConfig')
  })

  it('says what a strategy is missing, blocks Save, and fills the slots from the quick-adds', async () => {
    const user = userEvent.setup()
    openAgent({ strategy: 'single', roles: [MAIN] })
    await waitFor(() => expect(saveButton()).toBeEnabled())

    await user.click(await screen.findByTestId('strategy-option-cascade'))
    expect(screen.getByTestId('strategy-option-cascade')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('strategy-option-single')).toHaveAttribute('aria-checked', 'false')

    const missing = screen.getByTestId('missing-slots')
    expect(missing).toHaveTextContent('Cascade needs a drafter and a checker')
    const banner = screen.getByTestId('builder-validation-errors')
    expect(banner).toHaveTextContent('Cascade needs a drafter and a checker')

    // Save is refused while the slots are empty.
    await user.click(saveButton())
    expect(agentsApi.update).not.toHaveBeenCalled()

    await user.click(within(missing).getByRole('button', { name: 'Add drafter' }))
    expect(screen.getByTestId('role-drafter')).toBeInTheDocument()
    expect(screen.getByTestId('missing-slots')).toHaveTextContent('Cascade needs a checker')
    await user.click(within(screen.getByTestId('missing-slots')).getByRole('button', { name: 'Add checker' }))
    expect(screen.queryByTestId('missing-slots')).not.toBeInTheDocument()

    // Filled slots still need their models.
    expect(screen.getByTestId('builder-validation-errors')).toHaveTextContent('Drafter: pick a model, or route it by policy')
    await pickModel(screen.getByTestId('role-drafter'), /Automatic/)
    await pickModel(screen.getByTestId('role-checker'), /Automatic/)

    await waitFor(() => expect(screen.queryByTestId('builder-validation-errors')).not.toBeInTheDocument())
    await waitFor(() => expect(saveButton()).toBeEnabled())
    await user.click(saveButton())

    await waitFor(() => expect(agentsApi.update).toHaveBeenCalled())
    const sent = vi.mocked(agentsApi.update).mock.calls[0][1] as any
    expect(sent.models).toEqual({
      strategy: 'cascade',
      roles: [
        MAIN,
        { key: 'drafter', name: 'Drafter', purpose: 'drafter', kind: 'model', routing: { objective: 'cheapest' } },
        { key: 'checker', name: 'Checker', purpose: 'checker', kind: 'model', routing: { objective: 'cheapest' } },
      ],
    })
    expect(sent.collaboration).toBeNull()
  })

  it('asks for N on Best of N and saves it', async () => {
    const user = userEvent.setup()
    openAgent({ strategy: 'best_of_n', roles: [MAIN, { key: 'checker', name: 'Checker', purpose: 'checker', kind: 'model', providerId: 'prov-openai', model: 'gpt-4o-mini' }] })

    const n = await screen.findByLabelText('Candidates (N)')
    expect(n).toHaveValue(3)
    await user.clear(n)
    await user.type(n, '4')
    await waitFor(() => expect(saveButton()).toBeEnabled())
    await user.click(saveButton())

    await waitFor(() => expect(agentsApi.update).toHaveBeenCalled())
    expect((vi.mocked(agentsApi.update).mock.calls[0][1] as any).models).toMatchObject({ strategy: 'best_of_n', candidates: 4 })
  })

  it('lets only panelists and teammates be another agent', async () => {
    const user = userEvent.setup()
    openAgent({ strategy: 'single', roles: [MAIN] })

    await user.click(await screen.findByRole('button', { name: 'Add role' }))
    await user.click(within(screen.getByTestId('add-role-choices')).getByRole('button', { name: /^Teammate/ }))
    const teammate = screen.getByTestId('role-teammate_1')
    expect(within(teammate).getByLabelText('Role 2 name')).toHaveValue('Teammate 1')
    // A teammate is read by every strategy, so it is never "not used".
    expect(within(teammate).queryByTestId('role-teammate_1-unused')).not.toBeInTheDocument()

    await user.click(within(teammate).getByRole('radio', { name: 'Another agent' }))
    await user.click(within(teammate).getByRole('combobox', { name: 'Teammate 1 agent' }))
    // This agent is not on offer as its own teammate.
    expect(screen.queryByRole('option', { name: 'This agent' })).not.toBeInTheDocument()
    await user.click(await screen.findByRole('option', { name: 'Critic' }))

    // Main is never an agent.
    const main = screen.getByTestId('role-main')
    expect(within(main).getByRole('radio', { name: 'Another agent' })).toBeDisabled()
    expect(screen.getByTestId('role-main-kind-hint')).toHaveTextContent('Only panelists and teammates can be another agent')

    // Turning the teammate into a checker makes it a model again.
    await user.click(within(teammate).getByRole('combobox', { name: 'Teammate 1 purpose' }))
    await user.click(await screen.findByRole('option', { name: 'Checker' }))
    const checker = screen.getByTestId('role-teammate_1')
    expect(within(checker).getByLabelText('Role 2 name')).toHaveValue('Checker')
    expect(within(checker).getByRole('radio', { name: 'A model' })).toHaveAttribute('aria-checked', 'true')
    expect(within(checker).getByRole('radio', { name: 'Another agent' })).toBeDisabled()
    // Single does not read a checker, and the page says so rather than dropping it.
    expect(within(checker).getByTestId('role-teammate_1-unused')).toHaveTextContent('Not used by Single')
  })

  it('saves an agent teammate as an agent role', async () => {
    const user = userEvent.setup()
    openAgent({
      strategy: 'single',
      roles: [MAIN, { key: 'teammate_1', name: 'Critic', purpose: 'teammate', kind: 'agent', agentId: 'critic', instructions: 'Find the flaws.' }],
    })
    await waitFor(() => expect(saveButton()).toBeEnabled())
    await user.click(saveButton())
    await waitFor(() => expect(agentsApi.update).toHaveBeenCalled())
    expect((vi.mocked(agentsApi.update).mock.calls[0][1] as any).models.roles[1]).toEqual({
      key: 'teammate_1',
      name: 'Critic',
      purpose: 'teammate',
      kind: 'agent',
      agentId: 'critic',
      instructions: 'Find the flaws.',
    })
  })

  it('keeps one main role: Main is not offered to a second role, and the only main cannot be removed', async () => {
    const user = userEvent.setup()
    openAgent({
      strategy: 'cascade',
      roles: [MAIN, { key: 'drafter', name: 'Drafter', purpose: 'drafter', kind: 'model', providerId: 'prov-openai' }],
    })

    const main = await screen.findByTestId('role-main')
    expect(within(main).queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument()

    const drafter = screen.getByTestId('role-drafter')
    await user.click(within(drafter).getByRole('combobox', { name: 'Drafter purpose' }))
    expect(await screen.findByRole('option', { name: 'Main' })).toHaveAttribute('aria-disabled', 'true')
    await user.keyboard('{Escape}')

    await user.click(within(drafter).getByRole('button', { name: 'Remove Drafter' }))
    expect(screen.queryByTestId('role-drafter')).not.toBeInTheDocument()
    expect(screen.getByTestId('missing-slots')).toHaveTextContent('Cascade needs a drafter and a checker')
  })

  it('opens an agent saved before models on its one model, as Single', async () => {
    openAgent(null)
    const main = await screen.findByTestId('role-main')
    expect(screen.getByTestId('strategy-option-single')).toHaveAttribute('aria-checked', 'true')
    await waitFor(() => expect(within(main).getByRole('combobox', { name: 'Model' })).toHaveTextContent('gpt-4o'))
  })

  it('keeps advanced settings behind a disclosure, and saves them', async () => {
    const user = userEvent.setup()
    openAgent({ strategy: 'single', roles: [MAIN] })
    const main = await screen.findByTestId('role-main')
    expect(within(main).queryByLabelText('Temperature')).not.toBeInTheDocument()

    await user.click(within(main).getByRole('button', { name: 'Advanced' }))
    fireEvent.change(within(main).getByLabelText('Temperature'), { target: { value: '0.2' } })
    fireEvent.change(within(main).getByLabelText('Max tokens'), { target: { value: '2000' } })
    await waitFor(() => expect(saveButton()).toBeEnabled())
    await user.click(saveButton())
    await waitFor(() => expect(agentsApi.update).toHaveBeenCalled())
    expect((vi.mocked(agentsApi.update).mock.calls[0][1] as any).models.roles[0]).toMatchObject({ temperature: 0.2, maxTokens: 2000 })
  })
})
