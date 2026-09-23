import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '../../test/setup'
import { ToolsPage } from '../tools'
import { toolsApi } from '../../lib/api'

/**
 * Activating a generated tool used to take a page visit each.
 *
 * Every tool generated from a schema is a DRAFT, a gateway refuses
 * anything that is not ACTIVE, and the only activate control in the whole
 * dashboard was one toggle on a single tool's detail page. An
 * eighteen-operation import therefore meant eighteen detail pages and
 * eighteen toggles, and no screen said so — the row menu offered only
 * View details and Test tool.
 */

vi.mock('../../lib/api', () => ({
  toolsApi: {
    getAll: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
    activate: vi.fn(),
    deactivate: vi.fn(),
  },
  llmProvidersApi: { getAll: vi.fn().mockResolvedValue([]) },
  apisApi: { getAll: vi.fn().mockResolvedValue([]) },
  organizationsApi: { getTeams: vi.fn().mockResolvedValue([]) },
  gatewaysApi: { getAll: vi.fn().mockResolvedValue([]) },
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
    useNavigate: () => vi.fn(),
    useParams: () => ({}),
    useSearchParams: () => [new URLSearchParams(), vi.fn()],
    useLocation: () => ({ pathname: '/tools', search: '', hash: '', state: null }),
  }
})

const DRAFTS = [
  { id: 't1', name: 'listPets', type: 'api', status: 'draft', description: '', parameters: {} },
  { id: 't2', name: 'getPetById', type: 'api', status: 'draft', description: '', parameters: {} },
]

describe('activating generated tools from the tools list', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(toolsApi.activate).mockResolvedValue({ status: 'active' } as any)
  })

  it('activates every selected draft in one action', async () => {
    vi.mocked(toolsApi.getAll).mockResolvedValue({ tools: DRAFTS, total: 2 } as any)
    const user = userEvent.setup()
    render(<ToolsPage />)

    await user.click(await screen.findByRole('button', { name: 'Select the drafts' }))
    await user.click(screen.getByRole('button', { name: /Activate selected/ }))

    await waitFor(() => expect(toolsApi.activate).toHaveBeenCalledTimes(2))
    expect(vi.mocked(toolsApi.activate).mock.calls.map((c) => c[0]).sort()).toEqual(['t1', 't2'])
    await waitFor(() => expect(notify.success).toHaveBeenCalled())
    expect(notify.success.mock.calls[0][0]).toBe('2 tools activated')
  })

  it('says how many drafts are in the way before anything is selected', async () => {
    vi.mocked(toolsApi.getAll).mockResolvedValue({ tools: DRAFTS, total: 2 } as any)
    render(<ToolsPage />)

    expect(await screen.findByText(/2 tools are drafts/)).toBeInTheDocument()
    expect(screen.getByText(/only serves active tools/)).toBeInTheDocument()
  })

  it('offers Activate on a draft row', async () => {
    vi.mocked(toolsApi.getAll).mockResolvedValue({ tools: [DRAFTS[0]], total: 1 } as any)
    const user = userEvent.setup()
    render(<ToolsPage />)

    const row = (await screen.findAllByText('listPets'))[0].closest('tr')!
    await user.click(within(row).getByRole('button', { name: 'Actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Activate' }))

    await waitFor(() => expect(toolsApi.activate).toHaveBeenCalledWith('t1', 'org-1'))
  })

  it('does not offer Activate on a tool that is already active', async () => {
    vi.mocked(toolsApi.getAll).mockResolvedValue({
      tools: [{ ...DRAFTS[0], status: 'active' }],
      total: 1,
    } as any)
    const user = userEvent.setup()
    render(<ToolsPage />)

    const row = (await screen.findAllByText('listPets'))[0].closest('tr')!
    await user.click(within(row).getByRole('button', { name: 'Actions' }))

    expect(await screen.findByRole('menuitem', { name: 'Test tool' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Activate' })).not.toBeInTheDocument()
  })

  it('reports the ones that refused rather than claiming they all worked', async () => {
    vi.mocked(toolsApi.getAll).mockResolvedValue({ tools: DRAFTS, total: 2 } as any)
    vi.mocked(toolsApi.activate).mockImplementation(async (id: string) => {
      if (id === 't2') throw { response: { data: { message: 'Tool is archived.' } } }
      return { status: 'active' } as any
    })
    const user = userEvent.setup()
    render(<ToolsPage />)

    await user.click(await screen.findByRole('button', { name: 'Select the drafts' }))
    await user.click(screen.getByRole('button', { name: /Activate selected/ }))

    await waitFor(() => expect(notify.warning).toHaveBeenCalled())
    expect(notify.warning.mock.calls[0][0]).toBe('1 of 2 tools activated')
    expect(notify.success).not.toHaveBeenCalled()
  })
})
