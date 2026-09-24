import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { fireEvent, render, screen } from '@testing-library/react'

import { createAppRoutes } from '@/App'
import { AppErrorFallback } from '@/components/layout/route-error'
import { ErrorBoundary } from '@/components/ui/error-boundary'

/**
 * A page that throws while rendering used to blank the whole app: the
 * router had no errorElement, so react-router's own boundary (or nothing)
 * took over and the sidebar went with it. Production's white /models page
 * was exactly that. These tests render the real route tree and make one
 * page throw.
 */

// A stand-in shell with one nav link, so "the shell survives" is a
// concrete assertion: the shell and its link are still there, and the
// link still navigates.
vi.mock('@/components/layout/dashboard-layout', async () => {
  const { Link } = await import('react-router-dom')
  return {
    DashboardLayout: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="dashboard-shell">
        <nav>
          <Link to="/agents">Agents link</Link>
        </nav>
        <main>{children}</main>
      </div>
    ),
  }
})

vi.mock('@/components/layout/auth-layout', () => ({
  AuthLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

const boom = new Error('models page exploded')
vi.mock('@/pages/models', () => ({
  ModelsPage: () => {
    throw boom
  },
}))

vi.mock('@/pages/runners', () => ({
  RunnersPage: () => {
    throw new TypeError(
      'Failed to fetch dynamically imported module: https://app.almyty.com/assets/runners-OLD.js',
    )
  },
}))

vi.mock('@/pages/cli-login', () => ({
  CliLoginPage: () => {
    throw new Error('cli login exploded')
  },
}))

vi.mock('@/pages/agents', () => ({
  AgentsPage: () => <div>Agents Marker</div>,
}))

const { captureError } = vi.hoisted(() => ({ captureError: vi.fn() }))
vi.mock('@/lib/sentry', () => ({ captureError }))

vi.mock('@/store/auth', () => ({
  useAuthStore: () => ({ checkAuth: vi.fn() }),
}))
vi.mock('@/hooks/use-pageviews', () => ({ usePageviews: () => undefined }))
vi.mock('@/lib/tenant-host', () => ({ currentTenantSlug: () => null }))

function renderAt(path: string) {
  const router = createMemoryRouter(createAppRoutes(), { initialEntries: [path] })
  return render(<RouterProvider router={router} />)
}

describe('route error boundary', () => {
  beforeEach(() => {
    captureError.mockClear()
    // React and react-router log caught render errors; keep the run quiet.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows the error view inside the shell when a page throws', async () => {
    renderAt('/models')
    expect(await screen.findByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument()
    // The shell and its navigation are still mounted around the error.
    const shell = screen.getByTestId('dashboard-shell')
    expect(shell).toContainElement(screen.getByTestId('route-error'))
    expect(screen.getByRole('link', { name: 'Agents link' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /go to dashboard/i })).toHaveAttribute('href', '/dashboard')
  })

  it('clears the error when the user navigates away through the shell', async () => {
    renderAt('/models')
    await screen.findByTestId('route-error')
    fireEvent.click(screen.getByRole('link', { name: 'Agents link' }))
    expect(await screen.findByText('Agents Marker')).toBeInTheDocument()
    expect(screen.queryByTestId('route-error')).not.toBeInTheDocument()
  })

  it('reports the error to Sentry', async () => {
    renderAt('/models')
    await screen.findByTestId('route-error')
    expect(captureError).toHaveBeenCalledWith(boom)
  })

  it('keeps technical detail behind a toggle', async () => {
    renderAt('/models')
    await screen.findByTestId('route-error')
    expect(screen.queryByTestId('route-error-details')).not.toBeInTheDocument()
    expect(screen.queryByText(/models page exploded/)).not.toBeInTheDocument()
    const toggle = screen.getByRole('button', { name: 'Show technical details' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(screen.getByTestId('route-error-details')).toHaveTextContent('models page exploded')
    expect(screen.getByRole('button', { name: 'Hide technical details' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('offers a reload that re-arms the chunk retry after a deploy', async () => {
    const reload = vi.fn()
    const original = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, reload },
    })
    try {
      sessionStorage.setItem('almyty:chunk-reload-attempted', '1')
      renderAt('/runners')
      expect(await screen.findByRole('heading', { name: 'A new version of almyty is out' })).toBeInTheDocument()
      expect(screen.getByTestId('dashboard-shell')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: /reload/i }))
      expect(sessionStorage.getItem('almyty:chunk-reload-attempted')).toBeNull()
      expect(reload).toHaveBeenCalledTimes(1)
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original })
    }
  })

  it('shows a full-page error for a route outside the dashboard shell', async () => {
    renderAt('/cli-login')
    expect(await screen.findByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument()
    expect(screen.queryByTestId('dashboard-shell')).not.toBeInTheDocument()
  })
})

describe('top-level error fallback', () => {
  beforeEach(() => {
    captureError.mockClear()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the error view for an error outside routing and reports it once', () => {
    const outside = new Error('provider exploded')
    function Broken(): never {
      throw outside
    }
    render(
      <ErrorBoundary fallbackRender={(error) => <AppErrorFallback error={error} />}>
        <Broken />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /go to dashboard/i })).toHaveAttribute('href', '/dashboard')
    expect(captureError).toHaveBeenCalledTimes(1)
    expect(captureError).toHaveBeenCalledWith(outside)
  })
})
