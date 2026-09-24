import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'

import { ApisPage } from '@/pages/apis'
import { apisApi } from '@/lib/api'

// Entry points into the Connect API page: the real router.
vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

vi.mock('@/lib/api', () => ({
  apisApi: { getAll: vi.fn(), delete: vi.fn(), generateTools: vi.fn(), testConnection: vi.fn() },
  toolsApi: { getAll: vi.fn().mockResolvedValue([]) },
  organizationsApi: { getTeams: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}))
vi.mock('@/store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org-1' } }),
}))

function renderAt(url: string) {
  const router = createMemoryRouter(
    [
      { path: '/apis', element: <ApisPage /> },
      { path: '/apis/new', element: <p>Connect API page</p> },
    ],
    { initialEntries: [url] },
  )
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

describe('APIs page entry points', () => {
  beforeEach(() => {
    vi.mocked(apisApi.getAll).mockResolvedValue([] as any)
  })

  it('Connect API links to /apis/new, from the header and the empty state', async () => {
    renderAt('/apis')
    await screen.findByText('No APIs yet')
    const links = screen.getAllByRole('link', { name: /Connect API/ })
    expect(links).toHaveLength(2)
    for (const link of links) expect(link).toHaveAttribute('href', '/apis/new')
  })

  it('following Connect API lands on the page, not a dialog', async () => {
    const user = userEvent.setup()
    const router = renderAt('/apis')
    await user.click((await screen.findAllByRole('link', { name: /Connect API/ }))[0])
    await waitFor(() => expect(router.state.location.pathname).toBe('/apis/new'))
    expect(screen.getByText('Connect API page')).toBeInTheDocument()
  })

  it('an old ?new=1 link redirects to /apis/new', async () => {
    const router = renderAt('/apis?new=1')
    await waitFor(() => expect(router.state.location.pathname).toBe('/apis/new'))
  })
})
