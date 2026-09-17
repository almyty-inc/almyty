import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'

import { render } from '../test/setup'

const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
vi.mock('@/store/app', () => ({ useNotifications: () => notify }))
vi.mock('../store/app', () => ({ useNotifications: () => notify }))
vi.mock('@/store/organization', () => ({
  useOrganizationStore: (sel?: any) => {
    const state = { currentOrganization: { id: 'org-1', name: 'Acme' }, organizations: [], setCurrentOrganization: vi.fn() }
    return typeof sel === 'function' ? sel(state) : state
  },
}))
vi.mock('../store/organization', () => ({
  useOrganizationStore: (sel?: any) => {
    const state = { currentOrganization: { id: 'org-1', name: 'Acme' }, organizations: [], setCurrentOrganization: vi.fn() }
    return typeof sel === 'function' ? sel(state) : state
  },
}))

vi.mock('@/lib/api', () => ({
  organizationsApi: { getAll: vi.fn(), getMembers: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), addMember: vi.fn(), removeMember: vi.fn(), updateMemberRole: vi.fn() },
  toolHubApi: { getProviders: vi.fn(), getTemplates: vi.fn(), getCategories: vi.fn() },
  api: { get: vi.fn(), post: vi.fn() },
}))
vi.mock('../lib/api', async () => await import('@/lib/api'))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return { ...actual, useNavigate: () => vi.fn(), useLocation: () => ({ pathname: '/', search: '', hash: '', state: null }) }
})

import { organizationsApi, toolHubApi } from '@/lib/api'
import { OrganizationsPage } from '../pages/organizations'
import { ToolHubPage } from '../pages/tool-hub'

/**
 * A failed fetch is not an empty account.
 *
 * Several pages defaulted their data to `[]` and never read `isError`,
 * so a 500 or a dropped connection rendered the empty state — telling
 * the user their data does not exist, or that a feature is
 * unconfigured, and offering no way to retry.
 */
describe('a failed fetch does not read as "you have nothing"', () => {
  beforeEach(() => vi.clearAllMocks())

  it('says the organizations could not be loaded, rather than showing none', async () => {
    ;(organizationsApi.getAll as any).mockRejectedValue(new Error('boom'))
    ;(organizationsApi.getMembers as any).mockResolvedValue([])

    render(<OrganizationsPage />)

    // Every signed-in user is in at least one org, so zero rows is always
    // a failure rather than a fact.
    expect(await screen.findByText(/couldn.t load your organizations/i)).toBeInTheDocument()
  })

  it('says the Tool Hub is broken, rather than "no templates are configured"', async () => {
    ;(toolHubApi.getProviders as any).mockRejectedValue(new Error('boom'))
    ;(toolHubApi.getTemplates as any).mockResolvedValue({ templates: [] })
    ;(toolHubApi.getCategories as any).mockResolvedValue({ categories: [] })

    render(<ToolHubPage />)

    expect(await screen.findByText(/couldn.t load the tool hub/i)).toBeInTheDocument()
    expect(screen.queryByText(/no templates available/i)).not.toBeInTheDocument()
  })

  it('shows the organizations when the fetch works', async () => {
    ;(organizationsApi.getAll as any).mockResolvedValue([
      { id: 'o1', name: 'acme', slug: 'acme', isActive: true, plan: 'free', memberCount: 2, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z' },
    ])
    ;(organizationsApi.getMembers as any).mockResolvedValue([])

    render(<OrganizationsPage />)

    await waitFor(() => expect(screen.getByText('acme')).toBeInTheDocument())
    expect(screen.queryByText(/couldn.t load/i)).not.toBeInTheDocument()
  })
})
