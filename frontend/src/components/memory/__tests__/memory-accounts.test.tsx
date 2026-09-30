/**
 * Memory accounts on the Memory page, adding one, and moving memories
 * between them.
 *
 *  - The Accounts tab lists almyty's own memory and every account at a
 *    memory service, several per service, with its health. A service with
 *    no account says "Not set up" and offers Add account; nothing reads
 *    "unreachable" for want of a key.
 *  - Moving memories: pick the accounts and whose memories, check first,
 *    move; an account can be added in place; the move's page shows its
 *    progress and resumes it when it stopped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderAtRoute } from '@/test/render-at-route'
import { MemoriesPage } from '@/pages/memories'
import { MemoryAccountNewPage, MemoryMoveDetailPage, MemoryMovePage } from '@/pages/memory-accounts'
import { agentsApi, memoriesApi } from '@/lib/api'
import { connectionsApi } from '@/lib/connections-api'

vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

vi.mock('@/lib/api', () => ({
  memoriesApi: {
    list: vi.fn(async () => ({ items: [] })),
    listBackends: vi.fn(async () => []),
    accountsOverview: vi.fn(),
    listMoves: vi.fn(async () => []),
    getMove: vi.fn(),
    startMove: vi.fn(),
    previewMove: vi.fn(),
    resumeMove: vi.fn(),
    moveAgents: vi.fn(async () => []),
    getConfig: vi.fn(async () => null),
  },
  agentsApi: { getAll: vi.fn(async () => [{ id: 'ag-1', name: 'Support bot' }]) },
  organizationsApi: { getById: vi.fn(async () => ({})) },
}))

vi.mock('@/lib/connections-api', () => ({
  connectorsApi: {
    list: vi.fn(async () => [
      { key: 'mem0', kind: 'memory', displayName: 'Mem0', connect: [], validation: { kind: 'http' } },
      { key: 'zep', kind: 'memory', displayName: 'Zep', connect: [], validation: { kind: 'http' } },
      // No adapter behind it: never offered as a memory account.
      { key: 'memory-custom', kind: 'memory', displayName: 'Memory backend (HTTP)', connect: [], validation: { kind: 'http' } },
      { key: 'openai', kind: 'inference', displayName: 'OpenAI', connect: [], validation: { kind: 'http' } },
    ]),
  },
  connectionsApi: { validate: vi.fn(async () => ({})) },
  matchesConnectorSearch: (c: any, q: string) => !q || c.displayName.toLowerCase().includes(q.toLowerCase()),
}))

// The connect form itself is the shared one (tested with Credentials); here it connects straight away.
vi.mock('@/components/connections/connect-flow', async () => {
  const actual: any = await vi.importActual('@/components/connections/connect-flow')
  return {
    ...actual,
    ConnectServiceForm: ({ connector, onConnected }: any) => (
      <button
        type="button"
        onClick={() =>
          onConnected({ id: 'cred-new', name: `New ${connector.displayName}`, connectorKey: connector.key, connectorDisplayName: connector.displayName, kind: 'memory', owner: 'org', health: { status: 'valid', checkedAt: null, error: null }, createdAt: '' })
        }
      >
        Connect {connector.displayName}
      </button>
    ),
  }
})

const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
vi.mock('@/store/app', () => ({ useNotifications: () => notify }))
vi.mock('@/store/organization', () => ({
  useOrganizationStore: (selector?: (s: any) => any) => {
    const state = { currentOrganization: { id: 'org-1', name: 'Org' } }
    return selector ? selector(state) : state
  },
}))

const account = (over: Record<string, any>) => ({
  accountLabel: null, owner: 'org', isDefault: false, canMoveFrom: true, canMoveTo: true,
  health: { status: 'valid', checkedAt: null, error: null }, ...over,
})

const OVERVIEW = {
  accounts: [
    account({ id: 'almyty-native', service: 'almyty-native', serviceName: 'almyty', name: "almyty's own memory", isDefault: true }),
    account({ id: 'c1', service: 'mem0', serviceName: 'Mem0', name: 'Mem0 production' }),
    account({ id: 'c2', service: 'mem0', serviceName: 'Mem0', name: 'Mem0 staging', health: { status: 'failed', checkedAt: '2026-09-30T10:00:00Z', error: 'Mem0 refused the key. Check it at app.mem0.ai.' } }),
  ],
  services: [
    { id: 'mem0', name: 'Mem0', accounts: 2 },
    { id: 'zep', name: 'Zep', accounts: 0 },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(memoriesApi.accountsOverview).mockResolvedValue(OVERVIEW as any)
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
  if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = vi.fn()
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = vi.fn()
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
})

describe('the Accounts tab', () => {
  it('lists every account with its health, several per service, and a service with none as not set up', async () => {
    renderAtRoute(<MemoriesPage />, { path: '/memories', url: '/memories?tab=accounts' })

    expect(await screen.findByText('Mem0 production')).toBeInTheDocument()
    expect(screen.getByText('Mem0 staging')).toBeInTheDocument()
    // Plain words from the server, never the service's raw answer.
    expect(screen.getByTestId('memory-account-error')).toHaveTextContent('Mem0 refused the key. Check it at app.mem0.ai.')
    // The Credentials table's own labels and component.
    const statuses = screen.getAllByTestId('credential-status')
    expect(statuses.map((b) => b.getAttribute('data-state'))).toEqual(['ok', 'ok', 'failed'])
    expect(statuses.map((b) => b.textContent)).toEqual(['Works', 'Works', 'Needs attention'])
    expect(screen.getByTestId('memory-service-not-set-up')).toHaveTextContent('Not set up')
    const zepRow = screen.getByTestId('memory-service-not-set-up').closest('tr')!
    expect(within(zepRow).getByRole('link', { name: /Add account/ })).toHaveAttribute('href', '/memories/accounts/new?service=zep')
    expect(screen.queryByText(/unreachable/i)).not.toBeInTheDocument()
    expect(screen.getByText('Default')).toBeInTheDocument()
  })

  it('checks an account again', async () => {
    const user = userEvent.setup()
    renderAtRoute(<MemoriesPage />, { path: '/memories', url: '/memories?tab=accounts' })
    await user.click(await screen.findByRole('button', { name: 'Check Mem0 staging' }))
    await waitFor(() => expect(connectionsApi.validate).toHaveBeenCalledWith('c2'))
    await waitFor(() => expect(memoriesApi.accountsOverview).toHaveBeenCalledTimes(2))
  })

  it('offers moving memories out of an account', async () => {
    renderAtRoute(<MemoriesPage />, { path: '/memories', url: '/memories?tab=accounts' })
    expect(await screen.findByRole('link', { name: 'Move memories from Mem0 production' })).toHaveAttribute('href', '/memories/move?from=c1')
  })
})

describe('/memories/accounts/new', () => {
  it('offers the memory services almyty can keep memories in, and adds an account', async () => {
    const user = userEvent.setup()
    renderAtRoute(<MemoryAccountNewPage />, { path: '/memories/accounts/new', paths: ['/memories'] })

    expect(await screen.findByTestId('memory-service-tile-mem0')).toBeInTheDocument()
    expect(screen.getByTestId('memory-service-tile-zep')).toBeInTheDocument()
    expect(screen.queryByTestId('memory-service-tile-memory-custom')).not.toBeInTheDocument()
    expect(screen.queryByTestId('memory-service-tile-openai')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('memory-service-tile-zep'))
    await user.click(await screen.findByRole('button', { name: 'Connect Zep' }))
    expect(await screen.findByTestId('memory-account-added')).toHaveTextContent('New Zep is added.')
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(await screen.findByText('at /memories')).toBeInTheDocument()
  })

  it('opens straight onto the service in the link', async () => {
    renderAtRoute(<MemoryAccountNewPage />, { path: '/memories/accounts/new', url: '/memories/accounts/new?service=mem0' })
    expect(await screen.findByRole('button', { name: 'Connect Mem0' })).toBeInTheDocument()
  })
})

describe('/memories/move', () => {
  async function pick(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
    await user.click(await screen.findByRole('combobox', { name: label }))
    await user.click(await screen.findByRole('option', { name: option }))
  }

  it('moves the organization’s memories between two accounts and opens the move', async () => {
    const user = userEvent.setup()
    vi.mocked(memoriesApi.startMove).mockResolvedValue({ id: 'mv-1' } as any)
    renderAtRoute(<MemoryMovePage />, { path: '/memories/move', url: '/memories/move?from=c1', paths: ['/memories/moves/:id'] })

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'From' })).toHaveTextContent('Mem0 production'))
    await pick(user, 'To', "almyty's own memory")
    await user.click(screen.getByRole('button', { name: 'Move memories' }))

    await waitFor(() => expect(memoriesApi.startMove).toHaveBeenCalledWith({ source: 'c1', target: 'almyty-native', scope_type: 'workspace', scope_id: 'org-1', mode: 'memory', switch_agents: false }))
    expect(await screen.findByText('at /memories/moves/mv-1')).toBeInTheDocument()
  })

  it('checks first: how many would move and what the other account would not keep, moving nothing', async () => {
    const user = userEvent.setup()
    vi.mocked(memoriesApi.previewMove).mockResolvedValue({ total: 12, more: false, warnings: [{ capability: 'ttl', field: 'ttl_seconds', count: 3 }] })
    renderAtRoute(<MemoryMovePage />, { path: '/memories/move' })

    await pick(user, 'To', 'Mem0 production')
    await user.click(screen.getByRole('button', { name: 'Check first' }))

    expect(await screen.findByTestId('move-preview')).toHaveTextContent('12 memories would move.')
    expect(screen.getByText(/3 memories would lose expiry dates/)).toBeInTheDocument()
    expect(memoriesApi.startMove).not.toHaveBeenCalled()
  })

  it("moves one agent's own memories", async () => {
    const user = userEvent.setup()
    vi.mocked(memoriesApi.startMove).mockResolvedValue({ id: 'mv-2' } as any)
    renderAtRoute(<MemoryMovePage />, { path: '/memories/move', paths: ['/memories/moves/:id'] })

    await pick(user, 'Whose memories', "One agent's own memories")
    await user.click(screen.getByRole('button', { name: 'Move memories' }))
    expect(await screen.findByText('Pick the agent.')).toBeInTheDocument()
    expect(await screen.findByText('Pick the account to move them to.')).toBeInTheDocument()

    await pick(user, 'Agent', 'Support bot')
    await pick(user, 'To', 'Mem0 production')
    await user.click(screen.getByRole('button', { name: 'Move memories' }))
    await waitFor(() => expect(memoriesApi.startMove).toHaveBeenCalledWith(expect.objectContaining({ scope_type: 'agent', scope_id: 'org-1:agent:ag-1' })))
    expect(agentsApi.getAll).toHaveBeenCalled()
  })

  it('adds the account to move to in place, and picks it', async () => {
    const user = userEvent.setup()
    vi.mocked(memoriesApi.startMove).mockResolvedValue({ id: 'mv-3' } as any)
    renderAtRoute(<MemoryMovePage />, { path: '/memories/move', paths: ['/memories/moves/:id'] })

    await user.click(await screen.findByTestId('move-add-account'))
    const panel = screen.getByTestId('move-add-account-panel')
    expect(within(panel).queryByTestId('memory-service-tile-memory-custom')).not.toBeInTheDocument()
    await user.click(await within(panel).findByTestId('memory-service-tile-zep'))
    await user.click(within(panel).getByRole('button', { name: 'Connect Zep' }))

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'To' })).toHaveTextContent('New Zep'))
    await user.click(screen.getByRole('button', { name: 'Move memories' }))
    await waitFor(() => expect(memoriesApi.startMove).toHaveBeenCalledWith(expect.objectContaining({ source: 'almyty-native', target: 'cred-new' })))
  })

  it('offers only accounts memories can be moved out of', async () => {
    const user = userEvent.setup()
    vi.mocked(memoriesApi.accountsOverview).mockResolvedValue({
      ...OVERVIEW,
      accounts: [...OVERVIEW.accounts, account({ id: 'v1', service: 'vertex-memory-bank', serviceName: 'Vertex AI Memory Bank', name: 'Vertex', canMoveFrom: false })],
    } as any)
    renderAtRoute(<MemoryMovePage />, { path: '/memories/move' })
    await user.click(await screen.findByRole('combobox', { name: 'From' }))
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent)
    expect(options).toContain('Mem0 production')
    expect(options).not.toContain('Vertex (Vertex AI Memory Bank)')
    // And says why, in plain words.
    expect(screen.getByTestId('move-unmovable')).toHaveTextContent('Vertex AI Memory Bank cannot delete memories one at a time, so almyty cannot move memories out of it.')
  })

  it('offers to switch the agents that use the source account, on by default', async () => {
    const user = userEvent.setup()
    vi.mocked(memoriesApi.moveAgents).mockResolvedValue([
      { id: 'ag-1', name: 'Support bot', canSwitch: true },
      { id: 'ag-2', name: 'Sales bot', canSwitch: false, reason: 'You cannot edit this agent.' },
    ])
    vi.mocked(memoriesApi.startMove).mockResolvedValue({ id: 'mv-9' } as any)
    renderAtRoute(<MemoryMovePage />, { path: '/memories/move', url: '/memories/move?from=c1', paths: ['/memories/moves/:id'] })

    const list = await screen.findByTestId('move-agents')
    expect(memoriesApi.moveAgents).toHaveBeenCalledWith({ source: 'c1', scope_type: 'workspace', scope_id: 'org-1' })
    expect(list).toHaveTextContent('Support bot')
    expect(list).toHaveTextContent('Sales bot')
    expect(list).toHaveTextContent('Not switched: You cannot edit this agent.')
    await pick(user, 'To', "almyty's own memory")
    const box = screen.getByRole('checkbox', { name: "Switch these agents to almyty's own memory too" })
    expect(box).toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Move memories' }))
    await waitFor(() => expect(memoriesApi.startMove).toHaveBeenCalledWith(expect.objectContaining({ switch_agents: true })))
  })

  it('leaves the agents alone when the box is cleared', async () => {
    const user = userEvent.setup()
    vi.mocked(memoriesApi.moveAgents).mockResolvedValue([{ id: 'ag-1', name: 'Support bot', canSwitch: true }])
    vi.mocked(memoriesApi.startMove).mockResolvedValue({ id: 'mv-9' } as any)
    renderAtRoute(<MemoryMovePage />, { path: '/memories/move', url: '/memories/move?from=c1', paths: ['/memories/moves/:id'] })
    await screen.findByTestId('move-agents')
    await pick(user, 'To', "almyty's own memory")
    await user.click(screen.getByRole('checkbox', { name: /Switch these agents/ }))
    await user.click(screen.getByRole('button', { name: 'Move memories' }))
    await waitFor(() => expect(memoriesApi.startMove).toHaveBeenCalledWith(expect.objectContaining({ switch_agents: false })))
  })
})

describe('/memories/moves/:id', () => {
  const MOVE = {
    id: 'mv-1', sourceService: 'almyty-native', sourceCredentialId: null, targetService: 'mem0', targetCredentialId: 'c1',
    scopeType: 'workspace', scopeId: 'org-1', mode: 'memory', moved: 40, failed: 0, total: 100, lastError: null, warnings: [],
    createdAt: '2026-09-30T10:00:00Z', updatedAt: new Date().toISOString(), finishedAt: null,
  }

  it('shows a running move’s progress', async () => {
    vi.mocked(memoriesApi.getMove).mockResolvedValue({ ...MOVE, status: 'running' } as any)
    renderAtRoute(<MemoryMoveDetailPage />, { path: '/memories/moves/:id', url: '/memories/moves/mv-1' })
    expect(await screen.findByTestId('move-status')).toHaveTextContent('Moving: 40 of 100 done')
    expect(screen.getByTestId('move-progress')).toBeInTheDocument()
    expect(screen.getByTestId('move-from')).toHaveTextContent("almyty's own memory")
    expect(screen.getByTestId('move-to')).toHaveTextContent('Mem0 production')
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument()
  })

  it('says why a move stopped, and resumes it', async () => {
    const user = userEvent.setup()
    vi.mocked(memoriesApi.getMove)
      .mockResolvedValueOnce({ ...MOVE, status: 'failed', lastError: 'Mem0 is down' } as any)
      .mockResolvedValue({ ...MOVE, status: 'queued' } as any)
    vi.mocked(memoriesApi.resumeMove).mockResolvedValue({ ...MOVE, status: 'queued' } as any)
    renderAtRoute(<MemoryMoveDetailPage />, { path: '/memories/moves/:id', url: '/memories/moves/mv-1' })
    expect(await screen.findByTestId('move-error')).toHaveTextContent('Mem0 is down')
    await user.click(screen.getByRole('button', { name: 'Resume' }))
    await waitFor(() => expect(memoriesApi.resumeMove).toHaveBeenCalledWith('mv-1'))
    expect(await screen.findByTestId('move-status')).toHaveTextContent('Waiting to start')
  })

  it('offers to try again the memories a finished move could not move', async () => {
    vi.mocked(memoriesApi.getMove).mockResolvedValue({ ...MOVE, status: 'completed', moved: 98, failed: 2 } as any)
    renderAtRoute(<MemoryMoveDetailPage />, { path: '/memories/moves/:id', url: '/memories/moves/mv-1' })
    expect(await screen.findByTestId('move-failed')).toHaveTextContent('2 memories could not be moved')
    expect(screen.getByRole('button', { name: 'Try the rest again' })).toBeInTheDocument()
  })

  it('says which agents now use the new account, and which were not switched and why', async () => {
    vi.mocked(memoriesApi.getMove).mockResolvedValue({
      ...MOVE, status: 'completed', moved: 100, switchAgents: true,
      agentsSwitched: [{ id: 'ag-1', name: 'Support bot' }],
      agentsNotSwitched: [{ id: 'ag-2', name: 'Sales bot', reason: 'You cannot edit this agent.' }],
    } as any)
    renderAtRoute(<MemoryMoveDetailPage />, { path: '/memories/moves/:id', url: '/memories/moves/mv-1' })
    const result = await screen.findByTestId('move-agents-result')
    expect(result).toHaveTextContent('Support bot now keeps its memories in Mem0 production.')
    expect(result).toHaveTextContent('Sales bot was not switched: You cannot edit this agent.')
  })

  it('shows the plain sentence the server gives, never a raw answer', async () => {
    vi.mocked(memoriesApi.getMove).mockResolvedValue({ ...MOVE, status: 'failed', lastError: 'Mem0 refused the key. Check it at app.mem0.ai.' } as any)
    renderAtRoute(<MemoryMoveDetailPage />, { path: '/memories/moves/:id', url: '/memories/moves/mv-1' })
    expect(await screen.findByTestId('move-error')).toHaveTextContent('Mem0 refused the key. Check it at app.mem0.ai.')
  })
})
