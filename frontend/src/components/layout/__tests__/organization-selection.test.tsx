import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from '@testing-library/react'
import { render } from '@/test/setup'
import { DashboardLayout } from '../dashboard-layout'
import { useAuthStore } from '@/store/auth'
import { useOrganizationStore } from '@/store/organization'
import { authApi } from '@/lib/api'
import type { Organization, User } from '@/types'

vi.mock('@/lib/api', () => ({
  authApi: { getProfile: vi.fn() },
  organizationsApi: { getAll: vi.fn() },
}))
vi.mock('@/lib/analytics', () => ({ identifyUser: vi.fn(), resetAnalytics: vi.fn() }))
vi.mock('@/components/onboarding/guide-pill', () => ({ GuidePill: () => null }))
vi.mock('@/components/command-palette', () => ({ CommandPalette: () => null }))
vi.mock('@/components/keyboard-shortcuts', () => ({ KeyboardShortcutsListener: () => null }))
vi.mock('@/components/notifications/notification-bell', () => ({ NotificationBell: () => null }))
vi.mock('@/components/layout/email-verification-banner', () => ({ EmailVerificationBanner: () => null }))
vi.mock('@/components/plan-indicator', () => ({ PlanBadge: () => null }))

const oldOrg = { id: 'old-org', name: 'Existing organization' } as Organization
const newOrg = { id: 'new-org', name: 'Newly created organization' } as Organization
const profile = (orgs: Organization[]) => ({
  id: 'same-user', email: 'qa@example.test',
  organizationMemberships: orgs.map(organization => ({ organization, role: 'owner' })),
}) as User

describe('organization selection while restoring a session', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(authApi.getProfile).mockReset()
    localStorage.clear()
    // The organization list is not persisted, but the last selected org is.
    // The cached auth profile predates creating that organization.
    useOrganizationStore.setState({ organizations: [], currentOrganization: newOrg, isInitialized: false })
    useAuthStore.setState({
      user: profile([oldOrg]), isAuthenticated: true,
      hasHydrated: true, authChecked: false,
    })
  })

  it('keeps the new selection until the server confirms current memberships', async () => {
    let answer!: (user: User) => void
    vi.mocked(authApi.getProfile).mockReturnValueOnce(new Promise(resolve => { answer = resolve }))
    render(<DashboardLayout><div>QA page</div></DashboardLayout>)

    expect(useOrganizationStore.getState().currentOrganization?.id).toBe(newOrg.id)
    expect(useOrganizationStore.getState().organizations).toEqual([])

    await act(async () => {
      const check = useAuthStore.getState().checkAuth()
      answer(profile([oldOrg, newOrg]))
      await check
    })

    expect(useOrganizationStore.getState().currentOrganization?.id).toBe(newOrg.id)
    expect(useOrganizationStore.getState().organizations.map(org => org.id)).toEqual([oldOrg.id, newOrg.id])
    expect(JSON.parse(localStorage.getItem('almyty-org-store')!).state.currentOrganization.id).toBe(newOrg.id)
  })

  it('still rejects the persisted selection if the fresh profile no longer includes it', async () => {
    vi.mocked(authApi.getProfile).mockResolvedValueOnce(profile([oldOrg]))
    render(<DashboardLayout><div>QA page</div></DashboardLayout>)
    await act(async () => { await useAuthStore.getState().checkAuth() })
    expect(useOrganizationStore.getState().currentOrganization?.id).toBe(oldOrg.id)
  })
})
