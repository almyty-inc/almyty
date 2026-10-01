/**
 * An autonomous agent's configuration, on the page.
 *
 * The work mode comes first, as one dropdown, and the model slots under it
 * follow from the mode. Memory says which account, whose memory, what is
 * saved (and never saved) and for how long. Capabilities picks tools and
 * APIs, the other agents it may call, its machine, and temporary agents.
 * These drive the real page, the real ModelPicker and the real rules,
 * with only the network mocked, and check what a save sends.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderWithProviders } from '@/test/setup'
import { AgentBuilderPage } from '../agent-builder'
import { agentsApi, memoriesApi } from '@/lib/api'

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
  toolsApi: {
    getAll: vi.fn().mockResolvedValue([
      { id: 'tool-status', name: 'orders_status', apiId: 'api-orders', description: 'Where an order is' },
      { id: 'tool-refund', name: 'orders_refund', apiId: 'api-orders' },
      { id: 'tool-weather', name: 'weather_now' },
    ]),
  },
  apisApi: { getAll: vi.fn().mockResolvedValue([{ id: 'api-orders', name: 'Orders API' }]) },
  runnersApi: {
    getAll: vi.fn().mockResolvedValue([
      { id: 'r1', name: 'build-box', state: 'online', labels: { gpu: 'yes', os: 'linux' } },
      { id: 'r2', name: 'laptop', state: 'offline', labels: { os: 'mac' } },
    ]),
  },
  memoriesApi: {
    listAccounts: vi.fn(),
    listBackends: vi.fn().mockResolvedValue([]),
    getConfig: vi.fn(),
    updateConfig: vi.fn(),
  },
  organizationsApi: { getTeams: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/lib/models-api', () => ({
  modelsApi: {
    list: vi.fn().mockResolvedValue([
      { id: 'card-gpt-4o', name: 'gpt-4o', vendorModelId: 'gpt-4o', providerId: 'prov-openai', status: 'active', selectable: true },
      { id: 'card-gpt-4o-mini', name: 'gpt-4o-mini', vendorModelId: 'gpt-4o-mini', providerId: 'prov-openai', status: 'active', selectable: true },
    ]),
  },
}))
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
  { id: 'critic', name: 'Critic', description: 'Finds the flaws' },
  { id: 'billing', name: 'Billing' },
]

const MAIN = { key: 'main', name: 'Main', purpose: 'main', kind: 'model', providerId: 'prov-openai', model: 'gpt-4o' }
const model = (key: string, purpose: string, name: string, m = 'gpt-4o-mini') => ({ key, name, purpose, kind: 'model', providerId: 'prov-openai', model: m })

function openAgent(models: any, extra: Record<string, any> = {}) {
  params.id = 'agent-1'
  vi.mocked(agentsApi.getById).mockResolvedValue({
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
  } as any)
  vi.mocked(agentsApi.update).mockResolvedValue({ id: 'agent-1' } as any)
  renderWithProviders(<AgentBuilderPage />)
}

const saveButton = () => screen.getByRole('button', { name: /save/i })
const sentUpdate = () => vi.mocked(agentsApi.update).mock.calls[0][1] as any

async function save(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => expect(saveButton()).toBeEnabled())
  await user.click(saveButton())
  await waitFor(() => expect(agentsApi.update).toHaveBeenCalled())
  return sentUpdate()
}

/** Pick from the one-box model picker inside a slot: open it, choose the option. */
async function pickModel(slot: HTMLElement, name: RegExp) {
  const trigger = await within(slot).findByRole('combobox', { name: 'Model' })
  await waitFor(() => expect(trigger).not.toBeDisabled())
  fireEvent.click(trigger)
  const list = await screen.findByRole('listbox')
  fireEvent.click(await within(list).findByRole('option', { name }))
}

async function chooseWorkMode(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(await screen.findByRole('combobox', { name: 'Work mode' }))
  await user.click(await screen.findByRole('option', { name: label }))
}

/** The slots under the work mode, as [purpose, label] in the order shown. */
const slots = () =>
  within(screen.getByTestId('work-mode-slots'))
    .getAllByTestId(/^slot-(?!.*-empty$)/)
    .filter((el) => el.hasAttribute('data-purpose'))
    .map((el) => [el.getAttribute('data-purpose'), el.querySelector('span.text-sm.font-medium')?.textContent])

describe('the autonomous agent page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete params.id
    vi.mocked(agentsApi.getAll).mockResolvedValue(OTHER_AGENTS as any)
    vi.mocked(memoriesApi.listAccounts).mockResolvedValue([
      { id: 'almyty-native', name: "almyty's own memory", canExpire: true, expiresItself: true },
      { id: 'mem0', name: 'Mem0', canExpire: true, expiresItself: false },
      { id: 'vertex-memory-bank', name: 'Vertex AI Memory Bank', canExpire: false, expiresItself: false },
    ] as any)
    if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
    if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = vi.fn()
    if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = vi.fn()
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
  })

  it('shows the work mode first, above personality and instructions, then memory and capabilities, and nothing in a dialog', async () => {
    openAgent({ strategy: 'single', roles: [MAIN] })
    const headings = await screen.findAllByText(/^(Personality & style|Instructions|Work mode|Memory|Capabilities|Run limits|Heartbeat)$/, {
      selector: '.text-base',
    })
    expect(headings.map((h) => h.textContent)).toEqual([
      'Work mode',
      'Personality & style',
      'Instructions',
      'Memory',
      'Capabilities',
      'Run limits',
      'Heartbeat',
    ])
    // The old layout is gone: models before their mode, cards, "More ways".
    for (const old of ['Models', 'How they work together', 'Agent capabilities', 'More ways']) {
      expect(screen.queryByText(old)).not.toBeInTheDocument()
    }
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('offers the five work modes in one dropdown, and says what the chosen one does', async () => {
    const user = userEvent.setup()
    openAgent({ strategy: 'single', roles: [MAIN] })
    await user.click(await screen.findByRole('combobox', { name: 'Work mode' }))
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Single',
      'Cascade',
      'Best of N',
      'Panel',
      'Explore, extract, patch (experimental)',
    ])
    await user.keyboard('{Escape}')
    expect(screen.getByTestId('work-mode-description')).toHaveTextContent('One model does everything.')
  })

  it('starts a new agent on Single with one Main slot, and saves the model picked for it', async () => {
    const user = userEvent.setup()
    vi.mocked(agentsApi.create).mockResolvedValue({ id: 'new-agent' } as any)
    renderWithProviders(<AgentBuilderPage />)

    await user.click(await screen.findByRole('button', { name: 'Autonomous' }))
    expect(slots()).toEqual([['main', 'Main']])
    expect(screen.getByTestId('builder-next-steps')).toHaveTextContent('Main: pick a model, or route it by policy')

    await user.type(screen.getByPlaceholderText('You are a helpful assistant that...'), 'Answer questions.')
    await pickModel(screen.getByTestId('slot-main'), /gpt-4o(?!-mini)/)
    await waitFor(() => expect(screen.queryByTestId('builder-next-steps')).not.toBeInTheDocument())
    await user.click(saveButton())

    await waitFor(() => expect(agentsApi.create).toHaveBeenCalled())
    const sent = vi.mocked(agentsApi.create).mock.calls[0][0] as any
    expect(sent.models).toEqual({ strategy: 'single', roles: [{ ...MAIN }] })
    expect(sent.collaboration).toBeNull()
    expect(sent).not.toHaveProperty('modelConfig')
  })

  it('Cascade: choosing it shows a drafter, a checker and the main model, and Save waits for their models', async () => {
    const user = userEvent.setup()
    openAgent({ strategy: 'single', roles: [MAIN] })
    await waitFor(() => expect(saveButton()).toBeEnabled())

    await chooseWorkMode(user, 'Cascade')
    expect(slots()).toEqual([
      ['drafter', 'Drafter'],
      ['checker', 'Checker'],
      ['main', 'Main'],
    ])
    expect(screen.getByTestId('builder-validation-errors')).toHaveTextContent('Drafter: pick a model, or route it by policy')
    await user.click(saveButton())
    expect(agentsApi.update).not.toHaveBeenCalled()

    await pickModel(screen.getByTestId('slot-drafter'), /Automatic/)
    await pickModel(screen.getByTestId('slot-checker'), /gpt-4o-mini/)
    const sent = await save(user)
    expect(sent.models).toEqual({
      strategy: 'cascade',
      roles: [
        MAIN,
        { key: 'drafter', name: 'Drafter', purpose: 'drafter', kind: 'model', routing: { objective: 'cheapest' } },
        { key: 'checker', name: 'Checker', purpose: 'checker', kind: 'model', providerId: 'prov-openai', model: 'gpt-4o-mini' },
      ],
    })
  })

  it('Panel: panelists (a model or another agent), and a judge only if you add one', async () => {
    const user = userEvent.setup()
    openAgent({ strategy: 'single', roles: [MAIN] })
    await waitFor(() => expect(saveButton()).toBeEnabled())

    await chooseWorkMode(user, 'Panel')
    expect(slots()).toEqual([
      ['main', 'Main'],
      ['panelist', 'Panelist 1'],
      ['panelist', 'Panelist 2'],
    ])
    expect(screen.getByTestId('slot-judge-empty')).toHaveTextContent('Judge')
    expect(screen.getByTestId('slot-judge-empty')).toHaveTextContent('Optional')

    await pickModel(screen.getByTestId('slot-panelist_1'), /gpt-4o-mini/)
    const second = screen.getByTestId('slot-panelist_2')
    await user.click(within(second).getByRole('radio', { name: 'Another agent' }))
    await user.click(within(second).getByRole('combobox', { name: 'Panelist 2 agent' }))
    expect(screen.queryByRole('option', { name: 'This agent' })).not.toBeInTheDocument()
    await user.click(await screen.findByRole('option', { name: 'Critic' }))

    await user.click(within(screen.getByTestId('slot-judge-empty')).getByRole('button', { name: 'Add a judge' }))
    const judge = screen.getByTestId('slot-judge')
    // A judge is a model, never another agent.
    expect(within(judge).queryByRole('radio', { name: 'Another agent' })).not.toBeInTheDocument()
    await pickModel(judge, /gpt-4o(?!-mini)/)

    const sent = await save(user)
    expect(sent.models.strategy).toBe('panel')
    expect(sent.models.roles).toEqual([
      MAIN,
      { key: 'panelist_1', name: 'Panelist 1', purpose: 'panelist', kind: 'model', providerId: 'prov-openai', model: 'gpt-4o-mini' },
      { key: 'panelist_2', name: 'Panelist 2', purpose: 'panelist', kind: 'agent', agentId: 'critic' },
      { key: 'judge', name: 'Judge', purpose: 'judge', kind: 'model', providerId: 'prov-openai', model: 'gpt-4o' },
    ])
  })

  it('Best of N: the main model and a checker, and how many answers to choose from', async () => {
    const user = userEvent.setup()
    openAgent({ strategy: 'best_of_n', candidates: 3, roles: [MAIN, model('checker', 'checker', 'Checker')] })
    expect(await screen.findByTestId('slot-checker')).toBeInTheDocument()
    expect(slots()).toEqual([
      ['main', 'Main'],
      ['checker', 'Checker'],
    ])
    const n = screen.getByLabelText('Answers to choose from')
    await user.clear(n)
    await user.type(n, '4')
    expect((await save(user)).models).toMatchObject({ strategy: 'best_of_n', candidates: 4 })
  })

  it('Explore, extract, patch: explorers, a summariser, the main model and a checker', async () => {
    const user = userEvent.setup()
    openAgent({ strategy: 'single', roles: [MAIN] })
    await waitFor(() => expect(saveButton()).toBeEnabled())
    await chooseWorkMode(user, 'Explore, extract, patch (experimental)')
    expect(slots()).toEqual([
      ['explorer', 'Explorer 1'],
      ['summariser', 'Summariser'],
      ['main', 'Main'],
      ['checker', 'Checker'],
    ])
    await user.click(screen.getByRole('button', { name: 'Add an explorer' }))
    expect(slots().filter(([p]) => p === 'explorer')).toHaveLength(2)
  })

  it('switching back and forth keeps what was picked, and saves only what the mode uses', async () => {
    const user = userEvent.setup()
    openAgent({ strategy: 'cascade', roles: [MAIN, model('drafter', 'drafter', 'Drafter'), model('checker', 'checker', 'Checker')] })
    await waitFor(() => expect(saveButton()).toBeEnabled())
    await chooseWorkMode(user, 'Single')
    expect(slots()).toEqual([['main', 'Main']])
    await chooseWorkMode(user, 'Cascade')
    await waitFor(() => expect(within(screen.getByTestId('slot-drafter')).getByRole('combobox', { name: 'Model' })).toHaveTextContent('gpt-4o-mini'))
    await chooseWorkMode(user, 'Single')
    expect((await save(user)).models).toEqual({ strategy: 'single', roles: [MAIN] })
  })

  it('keeps sampling and the name under Advanced, and saves them', async () => {
    const user = userEvent.setup()
    openAgent({ strategy: 'single', roles: [MAIN] })
    const main = await screen.findByTestId('slot-main')
    expect(within(main).queryByLabelText('Temperature')).not.toBeInTheDocument()
    await user.click(within(main).getByRole('button', { name: /^Advanced/ }))
    fireEvent.change(within(main).getByLabelText('Temperature'), { target: { value: '0.2' } })
    fireEvent.change(within(main).getByLabelText('Max tokens'), { target: { value: '2000' } })
    expect((await save(user)).models.roles[0]).toMatchObject({ temperature: 0.2, maxTokens: 2000 })
  })

  it('an older agent: collaborators and agent teammates become agents it may call; model teammates stay under the work mode', async () => {
    const user = userEvent.setup()
    const agentConfig = {
      canCallAgents: false,
      verify: { enabled: true, policy: 'any_fail_blocks', maxReviseLoops: 2, triggers: ['on_final_output'], checkers: [{ name: 'GPT-4o reviewer', providerId: 'prov-openai', model: 'gpt-4o' }] },
      constraints: { enabled: true, autoLearn: true },
    }
    const collaboration = {
      strategy: 'debate',
      participants: [
        { kind: 'model', providerId: 'prov-openai', model: 'gpt-4o-mini', role: 'Skeptic', instructions: 'Push back.', temperature: 0.7 },
        { kind: 'agent', agentId: 'critic', role: 'Critic' },
      ],
    }
    openAgent(
      { strategy: 'single', roles: [MAIN, { key: 'helper', name: 'Helper', purpose: 'teammate', kind: 'agent', agentId: 'billing' }] },
      { agentConfig, collaboration },
    )

    const advanced = await screen.findByTestId('work-mode-advanced')
    expect(within(advanced).getByText('Skeptic')).toBeInTheDocument()
    const agents = screen.getByTestId('capability-agents')
    await waitFor(() => expect(within(agents).getByRole('checkbox', { name: 'Critic' })).toBeChecked())
    expect(within(agents).getByRole('checkbox', { name: 'Billing' })).toBeChecked()
    expect(within(screen.getByTestId('verifier-card')).getByText('GPT-4o reviewer')).toBeInTheDocument()

    const sent = await save(user)
    expect(sent.models).toEqual({
      strategy: 'single',
      roles: [
        MAIN,
        { key: 'teammate_1', name: 'Skeptic', purpose: 'teammate', kind: 'model', providerId: 'prov-openai', model: 'gpt-4o-mini', temperature: 0.7, instructions: 'Push back.' },
      ],
    })
    expect(sent.agentConfig).toEqual({ ...agentConfig, canCallAgents: true, callableAgentIds: ['billing', 'critic'] })
    expect(sent.collaboration).toBeNull()
  })

  describe('memory', () => {
    it('saves the account, whose memory, what is saved, what never is, and how long it is kept', async () => {
      const user = userEvent.setup()
      openAgent({ strategy: 'single', roles: [MAIN] }, { memoryConfig: { enabled: false } })
      const card = await screen.findByTestId('memory-card')
      expect(within(card).queryByLabelText('Memory account')).not.toBeInTheDocument()
      await user.click(within(card).getByRole('switch', { name: 'Remember between conversations' }))

      await user.click(within(card).getByRole('combobox', { name: 'Memory account' }))
      await user.click(await screen.findByRole('option', { name: 'Mem0' }))
      await user.click(within(card).getByRole('combobox', { name: 'Whose memory' }))
      await user.click(await screen.findByRole('option', { name: 'Each person has their own' }))
      expect(card).toHaveTextContent("A visitor's is kept only when the agent's visitor settings allow it.")
      await user.click(within(card).getByRole('combobox', { name: 'What it saves' }))
      await user.click(await screen.findByRole('option', { name: 'Whole conversations' }))
      await user.type(within(card).getByLabelText('Never save'), 'Payment details')
      await user.click(within(card).getByRole('combobox', { name: 'How long it keeps memories' }))
      await user.click(await screen.findByRole('option', { name: 'For a number of days' }))
      const days = within(card).getByLabelText('Days to keep a memory')
      await user.clear(days)
      await user.type(days, '90')
      expect(within(card).getByTestId('memory-retention-hint')).toHaveTextContent('almyty deletes them from Mem0 once they are older than that')

      expect((await save(user)).memoryConfig).toEqual({
        enabled: true,
        autoSave: false,
        account: 'mem0',
        credentialId: null,
        whose: 'person',
        save: 'conversations',
        neverSave: 'Payment details',
        retentionDays: 90,
      })
    })

    it('reads the old auto-save switch as saving facts, and offers no time limit on an account that cannot delete one memory', async () => {
      const user = userEvent.setup()
      openAgent({ strategy: 'single', roles: [MAIN] }, { memoryConfig: { enabled: true, autoSave: true, account: 'vertex-memory-bank' } })
      const card = await screen.findByTestId('memory-card')
      expect(within(card).getByRole('combobox', { name: 'What it saves' })).toHaveTextContent('Facts it learns')
      await waitFor(() => expect(within(card).getByTestId('memory-retention-hint')).toHaveTextContent('Vertex AI Memory Bank has no way to delete one memory'))
      await user.click(within(card).getByRole('combobox', { name: 'How long it keeps memories' }))
      expect(await screen.findByRole('option', { name: 'For a number of days' })).toHaveAttribute('data-disabled')
    })
  })

  describe('capabilities', () => {
    it('picks a whole API (with tools added later), single tools, the agents it may call, its machine and temporary agents', async () => {
      const user = userEvent.setup()
      openAgent({ strategy: 'single', roles: [MAIN] }, { toolIds: [], agentConfig: {} })
      const tools = await screen.findByTestId('capability-tools')
      await user.click(await within(tools).findByRole('checkbox', { name: 'All tools of Orders API, including ones added later' }))
      await user.click(within(tools).getByRole('button', { name: /Other tools/ }))
      await user.click(within(tools).getByRole('checkbox', { name: 'weather_now' }))
      expect(within(tools).getByTestId('capability-tools-chosen')).toHaveTextContent('Orders API, all tools')

      const agents = screen.getByTestId('capability-agents')
      expect(within(agents).queryByRole('checkbox', { name: 'This agent' })).not.toBeInTheDocument()
      await user.click(within(agents).getByRole('checkbox', { name: 'Billing' }))
      expect(within(agents).getByTestId('capability-agents-count')).toHaveTextContent('It can call 1 agent.')

      const machine = screen.getByTestId('capability-machine')
      await user.type(within(machine).getByLabelText('Machine labels'), 'gpu=yes')
      await waitFor(() => expect(within(machine).getByTestId('capability-machine-matches')).toHaveTextContent('1 machine with these labels: build-box (online).'))

      const temporary = screen.getByTestId('capability-temporary')
      await user.click(within(temporary).getByRole('switch', { name: 'Can create temporary agents' }))
      expect(within(temporary).getByLabelText('At most per run')).toHaveValue(3)
      expect(within(temporary).getByLabelText('At most at once')).toHaveValue(5)
      fireEvent.change(within(temporary).getByLabelText('At most per run'), { target: { value: '2' } })

      const sent = await save(user)
      expect(sent.toolIds).toEqual(['tool-weather'])
      expect(sent.agentConfig).toEqual({
        apiIds: ['api-orders'],
        callableAgentIds: ['billing'],
        canCallAgents: true,
        runnerLabels: 'gpu=yes',
        canCreateAgents: true,
        maxTemporaryAgents: 2,
        maxTemporaryAgentsAlive: 5,
      })
    })

    it('says so when no machine has the labels, and blocks a temporary agent limit out of range', async () => {
      const user = userEvent.setup()
      openAgent({ strategy: 'single', roles: [MAIN] }, { agentConfig: { runnerLabels: { gpu: 'no' }, canCreateAgents: true, maxTemporaryAgents: 3, maxTemporaryAgentsAlive: 5 } })
      const machine = await screen.findByTestId('capability-machine')
      await waitFor(() => expect(within(machine).getByTestId('capability-machine-matches')).toHaveTextContent('No machine has these labels yet'))
      fireEvent.change(within(screen.getByTestId('capability-temporary')).getByLabelText('At most per run'), { target: { value: '50' } })
      await waitFor(() => expect(screen.getByTestId('builder-validation-errors')).toHaveTextContent('Temporary agents per run: a whole number from 1 to 20'))
      await user.click(saveButton())
      expect(agentsApi.update).not.toHaveBeenCalled()
    })
  })
})
