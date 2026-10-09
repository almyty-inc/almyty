import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '../../test/setup'
import { ToolsPage } from '../tools'
import { toolsApi } from '../../lib/api'

/**
 * Searching the Tools page searched only the ten tools on the page shown.
 * With Gmail, Google Calendar and Google Tasks imported (130 tools) a
 * search for "calendar_events_list" said "No results" while the tool sat on
 * page 7. The search now asks the server, across every page, and starts
 * again from page 1.
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

const tool = (id: string, name: string) => ({ id, name, type: 'api', status: 'active', description: '', parameters: {} })

describe('searching the tools page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(toolsApi.getAll).mockImplementation((async (_org: string, params: any) =>
      params?.search
        ? { tools: [tool('t70', 'google_calendar_calendar_events_list')], total: 1 }
        : { tools: [tool('t1', 'gmail_gmail_users_messages_list')], total: 130 }) as any)
  })

  it('asks the server, so a tool on another page is found', async () => {
    const user = userEvent.setup()
    render(<ToolsPage />)
    await screen.findAllByText('gmail_gmail_users_messages_list')

    await user.type(screen.getByPlaceholderText('Search tools...'), 'calendar_events_list')

    expect((await screen.findAllByText('google_calendar_calendar_events_list')).length).toBeGreaterThan(0)
    await waitFor(() =>
      expect(toolsApi.getAll).toHaveBeenLastCalledWith('org-1', { limit: 10, page: 1, search: 'calendar_events_list' }),
    )
  })
})
