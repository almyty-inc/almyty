import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, screen, waitFor, fireEvent } from '@testing-library/react'

import { render } from '../../test/setup'

vi.mock('@/store/organization', () => ({
  useOrganizationStore: (sel?: any) => {
    const state = { currentOrganization: { id: 'org-1', name: 'Acme' } }
    return typeof sel === 'function' ? sel(state) : state
  },
}))
vi.mock('@/store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}))
vi.mock('@/components/onboarding/getting-started-card', () => ({
  GettingStartedCard: () => null,
  useOnboarding: () => ({ data: null }),
  useSeedSampleWorkspace: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock('@/components/onboarding/product-tour', () => ({ useProductTour: () => ({ start: vi.fn() }) }))
vi.mock('@/lib/analytics', () => ({ captureEvent: vi.fn() }))

vi.mock('@/lib/api', () => ({
  gatewaysApi: { getAll: vi.fn() },
  toolsApi: { getAll: vi.fn() },
  apisApi: { getAll: vi.fn() },
  agentsApi: { getAll: vi.fn() },
  analyticsApi: { getRequestLogs: vi.fn() },
  onboardingApi: { get: vi.fn() },
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return { ...actual, useNavigate: () => vi.fn() }
})

import { gatewaysApi, toolsApi, apisApi, agentsApi, analyticsApi } from '@/lib/api'
import { DashboardPage } from '../dashboard'

// testing-library's 1s default for findBy* is not enough for a react-query
// round trip when this file shares a worker with the rest of the suite. The
// budget only bounds how long a genuine failure takes to report.
const WAIT = { timeout: 10000 }

/**
 * The dashboard waits for every count before printing any of them.
 *
 * Its gate was `loadingGateways && loadingTools && loadingApis &&
 * loadingAgents` — all four. The four query keys are shared with the
 * list pages, so visiting Gateways and then Dashboard inside the 30s
 * staleTime left one query already fresh, its `isLoading` false, and the
 * whole page rendered past the spinner with the other three still
 * undefined. The pipeline row then read "0 APIs · 0 Tools · 0 Gateways ·
 * 0 Agents" for an org with plenty of each, until the rest landed.
 */
describe('the dashboard loading gate', () => {
  beforeEach(() => vi.clearAllMocks())

  const never = () => new Promise(() => {})

  it('does not print zeros while any count is still loading', async () => {
    // One resolved, three hanging -- exactly the shape a warm cache
    // produces when you arrive from a list page.
    ;(gatewaysApi.getAll as any).mockResolvedValue({ gateways: [{ id: 'g1' }, { id: 'g2' }], total: 2 })
    ;(toolsApi.getAll as any).mockImplementation(never)
    ;(apisApi.getAll as any).mockImplementation(never)
    ;(agentsApi.getAll as any).mockImplementation(never)
    ;(analyticsApi.getRequestLogs as any).mockImplementation(never)

    render(<DashboardPage />)

    // Let the one resolved query flush all the way through React, which
    // is the moment the old `&&` gate opened.
    await waitFor(() => expect(gatewaysApi.getAll).toHaveBeenCalled())
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // Still waiting, rather than claiming the org has nothing.
    expect(document.querySelector('.animate-spin')).toBeInTheDocument()
    expect(
      screen.queryByText((_t, el) => el?.tagName === 'DIV' && /Serving$/.test(el?.textContent ?? '')),
    ).not.toBeInTheDocument()
  })

  it('prints the counts once every query has answered', async () => {
    ;(gatewaysApi.getAll as any).mockResolvedValue({ gateways: [{ id: 'g1' }], total: 1 })
    ;(toolsApi.getAll as any).mockResolvedValue({ tools: [] })
    ;(apisApi.getAll as any).mockResolvedValue({ apis: [] })
    ;(agentsApi.getAll as any).mockResolvedValue({ agents: [] })
    ;(analyticsApi.getRequestLogs as any).mockResolvedValue({ logs: [] })

    render(<DashboardPage />)

    // JSX splits `{count} Gateway Serving` across text nodes, so match on
    // the element's whole text.
    const label = await screen.findByText(
      (_t, el) => el?.tagName === 'DIV' && el?.textContent === 'Gateway Serving',
    )
    // The number beside that label is the real one, not a placeholder zero.
    expect(label.parentElement?.textContent).toBe('1Gateway Serving')
  })

  // The two "Needs Attention" lines were <div onClick> dressed as links.
  // They are the only remediation path the dashboard offers for a gateway
  // with no authentication, so a keyboard user could not act on the warning
  // at all. Real links put them back in the tab order.
  it('offers the Needs Attention warnings as real links', async () => {
    ;(gatewaysApi.getAll as any).mockResolvedValue({
      gateways: [{ id: 'g1', name: 'Open Gateway', authConfig: { required: false } }],
      total: 1,
    })
    ;(toolsApi.getAll as any).mockResolvedValue({ tools: [] })
    ;(apisApi.getAll as any).mockResolvedValue({
      apis: [{ id: 'a1', name: 'Bare API', tools: [] }],
    })
    ;(agentsApi.getAll as any).mockResolvedValue({ agents: [] })
    ;(analyticsApi.getRequestLogs as any).mockResolvedValue({ logs: [] })

    render(<DashboardPage />)

    expect(
      await screen.findByRole('link', { name: /have no authentication configured/ }),
    ).toHaveAttribute('href', '/gateways')
    expect(
      screen.getByRole('link', { name: /have no generated tools/ }),
    ).toHaveAttribute('href', '/apis')
  })
})

/**
 * A failed count is not a count of zero.
 *
 * The `&&` -> `||` loading gate above fixed the warm-cache case, but none of
 * the four queries exposed `isError`. On a failure `isLoading` was false and
 * `data` undefined, so the extraction produced empty arrays and the page told
 * a fully populated org it had "0 APIs · 0 Tools · 0 Gateways · 0 Agents",
 * Getting-Started card and all -- a made-up dashboard for real data.
 */
describe('the dashboard when a count fails to load', () => {
  beforeEach(() => vi.clearAllMocks())

  const populated = () => {
    ;(toolsApi.getAll as any).mockResolvedValue({ tools: [{ id: 't1' }], total: 1 })
    ;(apisApi.getAll as any).mockResolvedValue({ apis: [{ id: 'a1' }], total: 1 })
    ;(agentsApi.getAll as any).mockResolvedValue({ agents: [] })
    ;(analyticsApi.getRequestLogs as any).mockResolvedValue({ logs: [] })
  }

  it('says it could not load rather than printing zeros', async () => {
    ;(gatewaysApi.getAll as any).mockRejectedValue(new Error('gateways unavailable'))
    populated()

    render(<DashboardPage />)

    expect(await screen.findByRole('alert', {}, WAIT)).toHaveTextContent(
      "We couldn't load your dashboard",
    )
    // The pipeline row must not appear at all: a zero here is a lie about
    // the org, not a fact about the request.
    expect(
      screen.queryByText((_t, el) => el?.tagName === 'DIV' && /Serving$/.test(el?.textContent ?? '')),
    ).not.toBeInTheDocument()
  })

  it('surfaces the backend message and offers a retry that refetches', async () => {
    ;(gatewaysApi.getAll as any).mockRejectedValue({
      response: { data: { message: 'Gateway service is down.' } },
    })
    populated()

    render(<DashboardPage />)

    expect(await screen.findByRole('alert', {}, WAIT)).toHaveTextContent('Gateway service is down.')

    const callsBefore = (gatewaysApi.getAll as any).mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    await waitFor(
      () => expect((gatewaysApi.getAll as any).mock.calls.length).toBeGreaterThan(callsBefore),
      WAIT,
    )
  })
})
