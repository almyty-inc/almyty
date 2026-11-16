import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'

import { render } from '../../test/setup'
import { ToolsPage } from '../tools'
import { toolsApi } from '../../lib/api'

/**
 * An API page's "Tools generated 1" opened /tools showing all 89 tools of
 * the organization. It now opens /tools?apiId=…&apiName=…, and the list
 * asks the server for that API's tools only.
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

const routing = vi.hoisted(() => ({ search: '', setSearchParams: vi.fn() }))
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<any>('react-router-dom')
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useParams: () => ({}),
    useSearchParams: () => [new URLSearchParams(routing.search), routing.setSearchParams],
    useLocation: () => ({ pathname: '/tools', search: routing.search, hash: '', state: null }),
  }
})

const forecast = { id: 't1', name: 'get_v1_forecast', type: 'api', status: 'active', description: '', parameters: {} }

describe('the tools page filtered to one API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(toolsApi.getAll).mockResolvedValue({ tools: [forecast], total: 1 } as any)
  })

  it('asks the server for that API\'s tools and says whose they are', async () => {
    routing.search = 'apiId=api-7&apiName=Open-Meteo'
    render(<ToolsPage />)

    await screen.findAllByText('get_v1_forecast')
    expect(toolsApi.getAll).toHaveBeenCalledWith('org-1', expect.objectContaining({ apiId: 'api-7', page: 1 }))
    expect(screen.getByTestId('api-tools-filter')).toHaveTextContent('Showing the tools of Open-Meteo.')

    fireEvent.click(screen.getByRole('button', { name: 'Show all tools' }))
    const next: URLSearchParams = routing.setSearchParams.mock.calls[0][0]
    expect(next.get('apiId')).toBeNull()
    expect(next.get('apiName')).toBeNull()
  })

  it('without an API in the address, lists every tool', async () => {
    routing.search = ''
    render(<ToolsPage />)

    await screen.findAllByText('get_v1_forecast')
    expect(vi.mocked(toolsApi.getAll).mock.calls[0][1]).not.toHaveProperty('apiId')
    expect(screen.queryByTestId('api-tools-filter')).not.toBeInTheDocument()
  })
})
