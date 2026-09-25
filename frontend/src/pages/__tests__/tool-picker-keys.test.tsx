import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, useQuery } from '@tanstack/react-query'

import { render } from '../../test/setup'
import { ToolsPage } from '../tools'
import { toolsApi } from '../../lib/api'

// The agent builder's tool picker and the gateway tool assigner read the
// same endpoint the tools page writes to. They used to sit on keys of
// their own -- ['tools-list', orgId] and ['all-tools', orgId] -- which
// the tools page's invalidateQueries({ queryKey: ['tools'] }) covered
// neither of, so a tool created here was missing from the builder and a
// deleted one was still on offer in the gateway dialog.

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


vi.mock('../../store/app', () => ({
  useNotifications: () => ({
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useParams: () => ({}),
    useSearchParams: () => [new URLSearchParams(), vi.fn()],
    useLocation: () => ({ pathname: '/tools', search: '', hash: '', state: null }),
  }
})

const TOOL = {
  id: 't1',
  name: 'Doomed Tool',
  type: 'http',
  status: 'active',
  description: '',
  parameters: {},
}

// The same key the agent builder's picker and the gateway assigner use.
function PickerProbe() {
  const { data } = useQuery({
    queryKey: ['tools', 'org-1', 'all'],
    queryFn: () => toolsApi.getAll('org-1'),
  })
  const tools = Array.isArray(data) ? data : ((data as any)?.tools ?? [])
  return <div data-testid="picker">{tools.map((t: any) => t.name).join(',')}</div>
}

describe('the tool pickers see what the tools page changes', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    vi.clearAllMocks()
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
  })

  it('drops a deleted tool from the picker key too', async () => {
    let deleted = false
    vi.mocked(toolsApi.getAll).mockImplementation(async () =>
      (deleted ? [] : [TOOL]) as any,
    )
    vi.mocked(toolsApi.delete).mockImplementation(async () => {
      deleted = true
      return { success: true } as any
    })

    const user = userEvent.setup()
    render(
      <>
        <ToolsPage />
        <PickerProbe />
      </>,
      { queryClient },
    )

    await waitFor(() =>
      expect(screen.getByTestId('picker')).toHaveTextContent('Doomed Tool'),
    )

    const row = (await screen.findAllByText('Doomed Tool'))[0].closest('tr')!
    await user.click(within(row).getByRole('button', { name: 'Actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }))
    const confirm = await screen.findByRole('alertdialog')
    await user.click(within(confirm).getByRole('button', { name: 'Delete tool' }))

    await waitFor(() => expect(toolsApi.delete).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.getByTestId('picker')).not.toHaveTextContent('Doomed Tool'),
    )
  })
})
