import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient } from '@tanstack/react-query'

import { render } from '../../test/setup'
import { AgentsPage } from '../agents'
import { agentsApi } from '../../lib/api'

// A state change made from the list page has to reach the detail page's
// caches too. agent-detail.tsx drops four keys for these operations and
// documents why; the list page dropped ['agents'] only, so the detail
// page, its version list and its audit log kept the pre-change answer,
// and a deleted agent's detail cache was served to whoever opened it
// next.

vi.mock('../../lib/api', () => ({
  agentsApi: {
    getAll: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    activate: vi.fn(),
    deactivate: vi.fn(),
    duplicate: vi.fn(),
    getTemplates: vi.fn(),
    importAgent: vi.fn(),
    exportAgent: vi.fn(),
  },
  toolsApi: { getAll: vi.fn().mockResolvedValue([]) },
  llmProvidersApi: { getAll: vi.fn().mockResolvedValue([]) },
  organizationsApi: { getTeams: vi.fn().mockResolvedValue([]) },
}))

vi.mock('../../store/organization', () => ({
  useOrganizationStore: () => ({
    currentOrganization: { id: 'test-org-id', name: 'Test Org' },
  }),
}))

vi.mock('../../store/app', () => ({
  useNotifications: () => ({
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}))

vi.mock('../../lib/analytics', () => ({ captureEvent: vi.fn() }))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useParams: () => ({}),
    useSearchParams: () => [new URLSearchParams(), vi.fn()],
    useLocation: () => ({ pathname: '/agents', search: '', hash: '', state: null }),
  }
})

const AGENT = {
  id: 'a1',
  name: 'Triage',
  status: 'inactive',
  totalExecutions: 0,
  description: '',
}

const DETAIL_KEYS = [
  ['agent', 'a1'],
  ['entity-versions', 'Agent', 'a1'],
  ['agent-audit-log', 'a1'],
] as const

function seedDetailCaches(qc: QueryClient) {
  qc.setQueryData(['agent', 'a1'], { ...AGENT })
  qc.setQueryData(['entity-versions', 'Agent', 'a1'], [{ version: 1 }])
  qc.setQueryData(['agent-audit-log', 'a1'], [{ action: 'created' }])
}

describe('agents list mutations reach the detail caches', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    vi.clearAllMocks()
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    vi.mocked(agentsApi.getAll).mockResolvedValue([AGENT] as any)
  })

  it('activating from the list invalidates the agent, its versions and its audit log', async () => {
    vi.mocked(agentsApi.activate).mockResolvedValue({ ...AGENT, status: 'active' } as any)
    seedDetailCaches(queryClient)

    const user = userEvent.setup()
    render(<AgentsPage />, { queryClient })

    expect(await screen.findByText('Triage')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open actions menu' }))
    await user.click(await screen.findByRole('menuitem', { name: /Activate/ }))

    await waitFor(() => expect(agentsApi.activate).toHaveBeenCalledWith('a1'))
    for (const key of DETAIL_KEYS) {
      await waitFor(() =>
        expect(queryClient.getQueryState([...key])?.isInvalidated).toBe(true),
      )
    }
  })

  it('duplicating from the list does the same', async () => {
    vi.mocked(agentsApi.duplicate).mockResolvedValue({ ...AGENT, id: 'a2' } as any)
    seedDetailCaches(queryClient)

    const user = userEvent.setup()
    render(<AgentsPage />, { queryClient })

    expect(await screen.findByText('Triage')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open actions menu' }))
    await user.click(await screen.findByRole('menuitem', { name: /Duplicate/ }))

    await waitFor(() => expect(agentsApi.duplicate).toHaveBeenCalledWith('a1'))
    await waitFor(() =>
      expect(queryClient.getQueryState(['agent', 'a1'])?.isInvalidated).toBe(true),
    )
  })

  it('deleting from the list drops the detail caches rather than leaving them to be served', async () => {
    vi.mocked(agentsApi.delete).mockResolvedValue({ success: true } as any)
    seedDetailCaches(queryClient)

    const user = userEvent.setup()
    render(<AgentsPage />, { queryClient })

    expect(await screen.findByText('Triage')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open actions menu' }))
    await user.click(await screen.findByRole('menuitem', { name: /Delete/ }))

    const confirm = await screen.findByRole('alertdialog')
    await user.click(within(confirm).getByRole('button', { name: /delete/i }))


    await waitFor(() => expect(agentsApi.delete).toHaveBeenCalledWith('a1'))
    for (const key of DETAIL_KEYS) {
      await waitFor(() =>
        expect(queryClient.getQueryData([...key])).toBeUndefined(),
      )
    }
  })
})
