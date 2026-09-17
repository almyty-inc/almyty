import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, screen, waitFor } from '@testing-library/react'

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
})
