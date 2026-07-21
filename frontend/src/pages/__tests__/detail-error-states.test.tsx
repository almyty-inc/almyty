import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

/**
 * Production-readiness GAP 1: the five detail pages used to guard with
 * `if (!data) return <NotFound/>`, so a 500 / network failure looked
 * identical to a genuine 404 and left the user at a dead end with no retry.
 *
 * These pages now distinguish:
 *   - isError            -> <QueryError onRetry={refetch} />
 *   - !isError && !data  -> the "not found" screen (genuine 404)
 *   - isLoading          -> the loading skeleton / spinner
 *
 * We drive all three by mocking the primary React Query hook. Every page
 * short-circuits on isLoading / isError / !data BEFORE rendering its heavy
 * child tree, so controlling the primary query is enough.
 */

// Controls the state the mocked primary useQuery reports.
let queryState: { isLoading: boolean; isError: boolean; data: unknown } = {
  isLoading: false,
  isError: false,
  data: undefined,
}
const refetchMock = vi.fn()

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual<any>('@tanstack/react-query')
  return {
    ...actual,
    useQuery: ({ queryKey }: { queryKey: any[] }) => {
      const key = Array.isArray(queryKey) ? queryKey[0] : queryKey
      const PRIMARY = ['api', 'tool', 'gateway', 'llm-provider', 'agent']
      if (PRIMARY.includes(key)) {
        return {
          data: queryState.data,
          isLoading: queryState.isLoading,
          isError: queryState.isError,
          error: queryState.isError ? new Error('Server exploded') : undefined,
          refetch: refetchMock,
        }
      }
      // All secondary queries are inert — the page never reaches them in the
      // loading/error/not-found branches under test.
      return { data: undefined, isLoading: false, isError: false, error: undefined, refetch: vi.fn() }
    },
    useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, reset: vi.fn() }),
    useQueryClient: () => ({ invalidateQueries: vi.fn(), refetchQueries: vi.fn() }),
  }
})

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<any>('react-router-dom')
  return { ...actual, useParams: () => ({ id: 'abc-123' }), useNavigate: () => vi.fn() }
})

vi.mock('@/store/organization', () => ({
  useOrganizationStore: (selector?: any) => {
    const state = { currentOrganization: { id: 'org-1', name: 'Org' } }
    return selector ? selector(state) : state
  },
}))

vi.mock('@/store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn() }),
}))

vi.mock('@/lib/api', () => {
  const stub = new Proxy({}, { get: () => vi.fn() })
  return {
    apisApi: stub, toolsApi: stub, gatewaysApi: stub, llmProvidersApi: stub,
    agentsApi: stub, memoriesApi: stub, filesApi: stub, versionsApi: stub,
    workspacesApi: stub,
  }
})

import { ApiDetailPage } from '../api-detail'
import { ToolDetailPage } from '../tool-detail'
import { GatewayDetailPage } from '../gateway-detail'
import { LlmProviderDetailPage } from '../llm-provider-detail'
import { AgentDetailPage } from '../agent-detail'

const PAGES: Array<{ name: string; Comp: React.ComponentType; notFound: RegExp }> = [
  { name: 'api-detail', Comp: ApiDetailPage, notFound: /API not found/i },
  { name: 'tool-detail', Comp: ToolDetailPage, notFound: /Tool not found/i },
  { name: 'gateway-detail', Comp: GatewayDetailPage, notFound: /Gateway not found/i },
  { name: 'llm-provider-detail', Comp: LlmProviderDetailPage, notFound: /Provider not found/i },
  { name: 'agent-detail', Comp: AgentDetailPage, notFound: /Agent not found/i },
]

function renderPage(Comp: React.ComponentType) {
  return render(<MemoryRouter><Comp /></MemoryRouter>)
}

describe.each(PAGES)('$name error/not-found/loading states', ({ Comp, notFound }) => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders QueryError with a working retry on a real load failure', async () => {
    queryState = { isLoading: false, isError: true, data: undefined }
    renderPage(Comp)

    // Shared QueryError component renders role="alert" + a "Try again" button.
    expect(screen.getByRole('alert')).toBeInTheDocument()
    const retry = screen.getByRole('button', { name: /try again/i })

    // Retry is wired to React Query's refetch.
    await userEvent.click(retry)
    expect(refetchMock).toHaveBeenCalled()

    // The error screen is NOT the not-found screen.
    expect(screen.queryByText(notFound)).not.toBeInTheDocument()
  })

  it('renders the not-found screen when data is genuinely absent (no error)', () => {
    queryState = { isLoading: false, isError: false, data: undefined }
    renderPage(Comp)

    expect(screen.getByText(notFound)).toBeInTheDocument()
    // Not-found is distinct from the error state.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('renders the loading state while the primary query is pending', () => {
    queryState = { isLoading: true, isError: false, data: undefined }
    const { container } = renderPage(Comp)

    // Loading spinner path: no error alert, no not-found copy.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText(notFound)).not.toBeInTheDocument()
    // The spinner container is present (h-96 centered wrapper).
    expect(container.querySelector('.h-96')).toBeInTheDocument()
  })
})
