import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '../../test/setup'
import { GatewayDetailPage } from '../gateway-detail'
import { gatewaysApi, toolsApi } from '../../lib/api'

/**
 * "Assign all" used to answer with a green success toast while assigning
 * nothing.
 *
 * The endpoint returns 200 with `{ associated, skipped }` and skips every
 * tool that is not active — which, immediately after a schema import, is
 * every tool. The page ignored `skipped` and said "Tools have been
 * assigned to the gateway successfully" over a gateway that had been
 * given none of them. That toast is the reason a user could sit in front
 * of an empty gateway without suspecting the draft rule existed.
 */

vi.mock('../../lib/api', () => ({
  gatewaysApi: {
    getById: vi.fn(),
    getTools: vi.fn(),
    bulkAssignTools: vi.fn(),
    assignTool: vi.fn(),
    removeTool: vi.fn(),
    removeAllTools: vi.fn(),
    update: vi.fn(),
    getMetrics: vi.fn().mockResolvedValue({}),
    getEvents: vi.fn().mockResolvedValue([]),
    getAuthConfig: vi.fn().mockResolvedValue({}),
    getApiKeys: vi.fn().mockResolvedValue([]),
    testChannelConnection: vi.fn(),
  },
  toolsApi: { getAll: vi.fn() },
  organizationsApi: { getTeams: vi.fn().mockResolvedValue([]) },
}))

vi.mock('@/hooks/use-entitlement', () => ({
  useEntitlements: () => new Set<string>(),
}))

const ORG = { id: 'org-1', name: 'Org' }
vi.mock('../../store/organization', () => {
  const useOrganizationStore: any = () => ({ currentOrganization: ORG })
  useOrganizationStore.getState = () => ({ currentOrganization: ORG })
  return { useOrganizationStore }
})

const notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('../../store/app', () => ({ useNotifications: () => notify }))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<any>('react-router-dom')
  return {
    ...actual,
    useParams: () => ({ id: 'gw-1' }),
    useNavigate: () => vi.fn(),
  }
})

const TOOLS = [
  { id: 't1', name: 'listPets', status: 'draft', type: 'api' },
  { id: 't2', name: 'getPetById', status: 'draft', type: 'api' },
]

async function assignAll() {
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'All Tools' }))
}

describe('gateway bulk assign says what actually happened', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(gatewaysApi.getById).mockResolvedValue({
      id: 'gw-1',
      name: 'Petstore Gateway',
      type: 'mcp',
      status: 'active',
      endpoint: '/petstore',
      configuration: {},
    } as any)
    vi.mocked(gatewaysApi.getTools).mockResolvedValue([] as any)
    vi.mocked(toolsApi.getAll).mockResolvedValue({ tools: TOOLS } as any)
  })

  it('does not call a run that assigned nothing a success', async () => {
    vi.mocked(gatewaysApi.bulkAssignTools).mockResolvedValue({
      associated: [],
      skipped: [
        { toolId: 't1', reason: "Tool 'listPets' is draft; a gateway only serves active tools." },
        { toolId: 't2', reason: "Tool 'getPetById' is draft; a gateway only serves active tools." },
      ],
    } as any)

    render(<GatewayDetailPage />)
    await assignAll()

    await waitFor(() => expect(notify.error).toHaveBeenCalled())
    expect(notify.success).not.toHaveBeenCalled()
    expect(notify.error.mock.calls[0][0]).toBe('No tools were assigned')
    expect(notify.error.mock.calls[0][1]).toMatch(/draft/)
  })

  it('reports the real counts on a partial assignment', async () => {
    vi.mocked(gatewaysApi.bulkAssignTools).mockResolvedValue({
      associated: [{ id: 'gt-1', toolId: 't1' }],
      skipped: [{ toolId: 't2', reason: "Tool 'getPetById' is draft." }],
    } as any)

    render(<GatewayDetailPage />)
    await assignAll()

    await waitFor(() => expect(notify.warning).toHaveBeenCalled())
    expect(notify.success).not.toHaveBeenCalled()
    expect(notify.warning.mock.calls[0][0]).toBe('1 of 2 tools assigned')
  })

  it('still reports success, with a count, when everything attached', async () => {
    vi.mocked(gatewaysApi.bulkAssignTools).mockResolvedValue({
      associated: [{ id: 'gt-1', toolId: 't1' }, { id: 'gt-2', toolId: 't2' }],
      skipped: [],
    } as any)

    render(<GatewayDetailPage />)
    await assignAll()

    await waitFor(() => expect(notify.success).toHaveBeenCalled())
    expect(notify.success.mock.calls[0][1]).toMatch(/2 tools assigned/)
  })

  it('will not offer Assign on a draft tool, and says what state it is in', async () => {
    const user = userEvent.setup()
    render(<GatewayDetailPage />)

    // Expand the tool group so the per-tool rows render.
    await user.click(await screen.findByText('Deleted API'))

    const row = (await screen.findByText('listPets')).closest('div.flex')!.parentElement!
      .parentElement!
    expect(within(row).getByRole('button', { name: 'Assign' })).toBeDisabled()
    expect(within(row).getAllByText('Draft').length).toBeGreaterThan(0)
  })
})
