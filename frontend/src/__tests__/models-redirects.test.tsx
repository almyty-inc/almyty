/**
 * The old Models and inference-provider addresses land on the pages that
 * replaced them, through the real route table.
 */
import { describe, it, expect, vi } from 'vitest'
import { RouterProvider, createMemoryRouter, useLocation, useParams } from 'react-router-dom'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { createAppRoutes } from '@/App'
import { modelsApi } from '@/lib/models-api'

vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

vi.mock('@/components/layout/dashboard-layout', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock('@/components/layout/auth-layout', () => ({
  AuthLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock('@/store/auth', () => ({ useAuthStore: () => ({ checkAuth: vi.fn() }) }))
vi.mock('@/hooks/use-pageviews', () => ({ usePageviews: () => undefined }))
vi.mock('@/lib/tenant-host', () => ({ currentTenantSlug: () => null }))
vi.mock('@/lib/models-api', () => ({ modelsApi: { get: vi.fn() } }))

function Where({ page }: { page: string }) {
  const location = useLocation()
  const params = useParams()
  return (
    <p>
      {page} {params.id ?? ''} {location.search} {location.hash}
    </p>
  )
}
vi.mock('@/pages/models', () => ({ ModelsPage: () => <Where page="models-page" /> }))
vi.mock('@/pages/models-connect', () => ({ ConnectProviderPage: () => <Where page="connect-page" /> }))
vi.mock('@/pages/provider', () => ({ ProviderPage: () => <Where page="provider-page" /> }))

function renderAt(path: string) {
  const router = createMemoryRouter(createAppRoutes(), { initialEntries: [path] })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

describe('old Models addresses', () => {
  it.each([
    ['/llm-providers', '/models', 'models-page'],
    ['/llm-providers/new', '/models/connect', 'connect-page'],
    ['/models/new', '/models/connect', 'connect-page'],
    ['/llm-providers/p1', '/models/providers/p1', 'provider-page p1'],
    ['/llm-providers/p1/edit', '/models/providers/p1', 'provider-page p1'],
  ])('%s lands on %s', async (from, to, page) => {
    const router = renderAt(from)
    expect(await screen.findByText(new RegExp(`^${page}`))).toBeInTheDocument()
    expect(router.state.location.pathname).toBe(to)
  })

  it('keeps the provider picked in ?type', async () => {
    const router = renderAt('/models/new?type=anthropic')
    expect(await screen.findByText(/^connect-page/)).toBeInTheDocument()
    expect(router.state.location.search).toBe('?type=anthropic')
    renderAt('/llm-providers/new?type=ollama')
    expect(await screen.findByText(/connect-page\s+\?type=ollama/)).toBeInTheDocument()
  })

  it("sends a model's old page to its provider's page, at the model", async () => {
    vi.mocked(modelsApi.get).mockResolvedValue({ id: 'card-1', providerId: 'p9', endpointRef: null } as any)
    const router = renderAt('/models/card-1')
    expect(await screen.findByText(/^provider-page p9/)).toBeInTheDocument()
    expect(router.state.location.hash).toBe('#model-card-1')
  })

  it('serves the new pages at their own addresses', async () => {
    renderAt('/models/connect?type=openai')
    expect(await screen.findByText(/connect-page\s+\?type=openai/)).toBeInTheDocument()
  })
})
