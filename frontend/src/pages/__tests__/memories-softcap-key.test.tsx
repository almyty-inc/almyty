import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, useQuery } from '@tanstack/react-query'

import { render } from '../../test/setup'
import { MemoriesPage } from '../memories'
import { memoriesApi } from '../../lib/api'

// The soft-cap warning list sits on ['memories','softcap-warnings',orgId],
// a sibling of ['memories','list',orgId] rather than a descendant, so
// storing a memory (which is what trips a soft cap) and deleting one
// (which frees capacity) both left it on the pre-change answer.

vi.mock('../../lib/api', () => ({
  memoriesApi: {
    list: vi.fn(),
    search: vi.fn(),
    put: vi.fn(),
    remove: vi.fn(),
    supersede: vi.fn(),
    listBackends: vi.fn(),
    backendsHealth: vi.fn(),
    getConfig: vi.fn(),
    updateConfig: vi.fn(),
    getById: vi.fn(),
    transfer: vi.fn(),
    listAudit: vi.fn(),
    listCredentials: vi.fn(),
    listSoftcapWarnings: vi.fn(),
    runConsolidation: vi.fn(),
  },
  credentialsApi: { getAll: vi.fn().mockResolvedValue([]) },
  organizationsApi: { getTeams: vi.fn().mockResolvedValue([]) },
}))

vi.mock('../../store/app', () => ({
  useNotifications: () => ({
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}))

vi.mock('../../store/organization', () => ({
  // Honour the selector form: the page reads
  // useOrganizationStore(s => s.currentOrganization?.id), and a mock
  // that ignores the selector hands it the whole state object, which
  // then lands in the query key.
  useOrganizationStore: (selector?: (s: any) => any) => {
    const state = { currentOrganization: { id: 'org-test' } }
    return selector ? selector(state) : state
  },
}))


vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useLocation: () => ({ pathname: '/memories', search: '', hash: '', state: null }),
  }
})

const ITEM = {
  id: 'm1111111-2222-3333-4444-555555555555',
  content: 'The billing contact is ops@acme.test',
  tier: 'short',
  tags: [],
  mode: 'memory',
  created_at: '2026-01-01T00:00:00.000Z',
}

// A stand-in for SoftcapAuditList, reading the same key it does.
function SoftcapProbe() {
  const { data } = useQuery({
    queryKey: ['memories', 'softcap-warnings', 'org-test'],
    queryFn: () => memoriesApi.listSoftcapWarnings('workspace', 'org-test', 100),
  })
  return <div data-testid="softcap">{Array.isArray(data) ? data.length : 0}</div>
}

describe('memory writes refresh the soft-cap warnings', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    vi.clearAllMocks()
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    vi.mocked(memoriesApi.list).mockResolvedValue({ items: [ITEM] } as any)
    vi.mocked(memoriesApi.listBackends).mockResolvedValue([] as any)
    vi.mocked(memoriesApi.remove).mockResolvedValue({ ok: true } as any)
  })

  it('refetches the soft-cap warnings when a memory is deleted', async () => {
    vi.mocked(memoriesApi.listSoftcapWarnings).mockResolvedValue([{ id: 'w1' }] as any)

    render(
      <>
        <MemoriesPage />
        <SoftcapProbe />
      </>,
      { queryClient },
    )

    await waitFor(() => expect(memoriesApi.listSoftcapWarnings).toHaveBeenCalled())
    const before = vi.mocked(memoriesApi.listSoftcapWarnings).mock.calls.length

    fireEvent.click(await screen.findByTitle('Soft delete'))
    fireEvent.click(await screen.findByRole('button', { name: /Delete Memory/ }))

    await waitFor(() => expect(memoriesApi.remove).toHaveBeenCalled())
    await waitFor(() =>
      expect(vi.mocked(memoriesApi.listSoftcapWarnings).mock.calls.length)
        .toBeGreaterThan(before),
    )
  })
})
