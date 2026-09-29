import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'

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
vi.mock('@/components/onboarding/guide-card', () => ({ GuideCard: () => null }))
vi.mock('@/components/onboarding/use-onboarding', () => ({ useOnboarding: () => ({ data: null }) }))
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

const WAIT = { timeout: 10000 }

/**
 * "Needs attention" makes claims about the org, and both used to be wrong:
 * an API with tools was listed as having none (the page guessed the link
 * from metadata copies and the first page of tools), and chat, channel and
 * system gateways were listed as having no authentication, which they do
 * not take. The server's per-API count and the gateway type decide now.
 */
describe('dashboard: needs attention only says true things', () => {
  const load = (apis: any[], gateways: any[]) => {
    ;(apisApi.getAll as any).mockResolvedValue({ apis, total: apis.length })
    ;(gatewaysApi.getAll as any).mockResolvedValue({ gateways, total: gateways.length })
    ;(toolsApi.getAll as any).mockResolvedValue({ tools: [] })
    ;(agentsApi.getAll as any).mockResolvedValue({ agents: [] })
    ;(analyticsApi.getRequestLogs as any).mockResolvedValue({ logs: [] })
  }
  beforeEach(() => vi.clearAllMocks())

  it('flags an API with no tools and not one that has tools', async () => {
    load(
      [
        { id: 'a1', name: 'Petstore', toolCount: 3, operationCount: 3 },
        { id: 'a2', name: 'Empty', toolCount: 0, operationCount: 2 },
      ],
      [],
    )
    render(<DashboardPage />)
    expect(await screen.findByText('1 API has no tools yet', {}, WAIT)).toBeInTheDocument()
  })

  it('says nothing about APIs when each one has tools', async () => {
    load([{ id: 'a1', name: 'Petstore', toolCount: 3, operationCount: 3 }], [])
    render(<DashboardPage />)
    await waitFor(() => expect(apisApi.getAll).toHaveBeenCalled(), WAIT)
    await screen.findAllByText(/API/, {}, WAIT)
    expect(screen.queryByText(/no tools yet/)).not.toBeInTheDocument()
  })

  it('flags only protocol gateways without sign-in, never chat, channel or system ones', async () => {
    load(
      [{ id: 'a1', name: 'Petstore', toolCount: 3 }],
      [
        { id: 'g1', name: 'Open MCP', type: 'mcp', authConfigs: [] },
        { id: 'g2', name: 'System', type: 'mcp', isSystem: true, authConfigs: [] },
        { id: 'g3', name: 'Chat', type: 'hosted_chat', authConfigs: [] },
        { id: 'g4', name: 'Slack', type: 'slack', authConfigs: [] },
        { id: 'g5', name: 'Signed MCP', type: 'mcp', authConfigs: [{ id: 'x' }] },
      ],
    )
    render(<DashboardPage />)
    expect(await screen.findByText('1 gateway is open to anyone: add sign-in', {}, WAIT)).toBeInTheDocument()
  })
})
