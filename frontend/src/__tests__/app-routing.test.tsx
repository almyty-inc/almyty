import { describe, it, expect, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { render, screen, waitFor } from '@testing-library/react'

import App from '@/App'

/**
 * Production-readiness: an unknown *authenticated* URL used to render the
 * Dashboard (the top-level catch-all redirected `*` -> /dashboard), so a
 * typo'd path silently looked like the dashboard rather than a 404. Unknown
 * authed paths now render a real NotFound page inside the shell, while `/`
 * and every known route keep working.
 *
 * The lazy page chunks + auth-gated layout are heavy, so we replace the
 * DashboardLayout with a passthrough (drops the auth redirect + shell) and
 * stub the page modules we assert on with simple markers.
 */

// DashboardLayout renders children directly — no auth gate, no shell.
vi.mock('@/components/layout/dashboard-layout', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dashboard-shell">{children}</div>
  ),
}))

vi.mock('@/components/layout/auth-layout', () => ({
  AuthLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('@/pages/dashboard', () => ({
  DashboardPage: () => <div>Dashboard Marker</div>,
}))

vi.mock('@/pages/agents', () => ({
  AgentsPage: () => <div>Agents Marker</div>,
}))

vi.mock('@/pages/not-found', () => ({
  NotFoundPage: () => <div>Page not found</div>,
}))

// Auth store is only consumed by App for checkAuth + pageviews; stub it.
vi.mock('@/store/auth', () => ({
  useAuthStore: () => ({ checkAuth: vi.fn() }),
}))

vi.mock('@/hooks/use-pageviews', () => ({
  usePageviews: () => undefined,
}))

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  )
}

describe('App authed routing', () => {
  it('renders the Dashboard at /', async () => {
    renderAt('/')
    expect(await screen.findByText('Dashboard Marker')).toBeInTheDocument()
    expect(screen.queryByText('Page not found')).not.toBeInTheDocument()
  })

  it('renders the matching page for a known route', async () => {
    renderAt('/agents')
    expect(await screen.findByText('Agents Marker')).toBeInTheDocument()
    expect(screen.queryByText('Page not found')).not.toBeInTheDocument()
  })

  it('renders NotFound (not Dashboard) for an unknown authed route', async () => {
    renderAt('/nonsense')
    expect(await screen.findByText('Page not found')).toBeInTheDocument()
    expect(screen.queryByText('Dashboard Marker')).not.toBeInTheDocument()
  })

  it('renders NotFound inside the authed shell', async () => {
    renderAt('/memory-typo')
    await waitFor(() => expect(screen.getByTestId('dashboard-shell')).toBeInTheDocument())
    expect(screen.getByText('Page not found')).toBeInTheDocument()
  })
})
