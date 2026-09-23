import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * `localStorage.removeItem('almyty-org-store')` is not a reset.
 *
 * login(), register() and logout() each dropped the persisted copy of the
 * user's organization selection and called it done. The live Zustand store
 * kept `currentOrganization` in memory, so:
 *
 *   - the very next `set()` on that store re-persisted the stale id
 *     through the persist middleware, putting it straight back where the
 *     axios request interceptor reads it, and
 *   - `initializeFromUser` compares against `get().currentOrganization`,
 *     which is still the *previous* session's org.
 *
 * Both hand the stale id back to `X-Organization-Id`, which the backend
 * refuses — the bounce back to /auth/login that reads as a double login.
 *
 * Clearing storage and leaving the state is the bug. Clear the state.
 */

vi.mock('@/lib/api', () => ({
  organizationsApi: { getAll: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  authApi: {
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    getProfile: vi.fn(),
    updateProfile: vi.fn(),
  },
}))

vi.mock('@/lib/analytics', () => ({
  identifyUser: vi.fn(),
  resetAnalytics: vi.fn(),
}))

const ORG_A = { id: 'org-A', name: 'Org A', slug: 'org-a' }

function userWith(id: string, orgs: Array<{ id: string; name: string; slug: string }>) {
  return {
    id,
    email: `${id}@example.com`,
    organizationMemberships: orgs.map(organization => ({ role: 'owner', organization })),
  } as any
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
})

afterEach(() => {
  vi.resetModules()
})

describe('an auth transition clears the org selection from memory, not just from storage', () => {
  it('logout() leaves no selected organization in the live store', async () => {
    const { useOrganizationStore } = await import('../organization')
    const { useAuthStore } = await import('../auth')
    const { authApi } = await import('@/lib/api')
    ;(authApi.logout as any).mockResolvedValue(undefined)

    useOrganizationStore.getState().initializeFromUser(userWith('u1', [ORG_A]))
    expect(useOrganizationStore.getState().currentOrganization?.id).toBe('org-A')

    await useAuthStore.getState().logout()

    expect(useOrganizationStore.getState().currentOrganization).toBeNull()
  })

  it('the next store write after logout() does not re-persist the old selection', async () => {
    const { useOrganizationStore } = await import('../organization')
    const { useAuthStore } = await import('../auth')
    const { authApi, organizationsApi } = await import('@/lib/api')
    ;(authApi.logout as any).mockResolvedValue(undefined)
    ;(organizationsApi.getAll as any).mockRejectedValue(new Error('offline'))

    useOrganizationStore.getState().initializeFromUser(userWith('u1', [ORG_A]))
    await useAuthStore.getState().logout()

    // Any subsequent `set()` flushes the whole partialized state back to
    // localStorage. A failed refresh on the login page is enough.
    await useOrganizationStore.getState().fetchOrganizations().catch(() => {})

    const raw = localStorage.getItem('almyty-org-store')
    const persisted = raw ? JSON.parse(raw)?.state?.currentOrganization?.id ?? null : null
    expect(persisted).toBeNull()
  })

  it('login() does not carry the previous session org into the new session', async () => {
    const { useOrganizationStore } = await import('../organization')
    const { useAuthStore } = await import('../auth')
    const { authApi } = await import('@/lib/api')

    // Session one selected org-A.
    useOrganizationStore.getState().initializeFromUser(userWith('u1', [ORG_A]))
    expect(useOrganizationStore.getState().currentOrganization?.id).toBe('org-A')

    // Session two. The profile still mentions org-A — the second user has
    // an outstanding invite to it — but org-B is the one they can act in,
    // and it is the one login() must land on.
    const ORG_B = { id: 'org-B', name: 'Org B', slug: 'org-b' }
    ;(authApi.login as any).mockResolvedValue({ accessToken: 't' })
    ;(authApi.getProfile as any).mockResolvedValue(userWith('u2', [ORG_B]))

    await useAuthStore.getState().login('u2@example.com', 'pw')

    expect(useOrganizationStore.getState().currentOrganization?.id).toBe('org-B')
  })

  it('the selection is gone from memory before login() makes its first request', async () => {
    const { useOrganizationStore } = await import('../organization')
    const { useAuthStore } = await import('../auth')
    const { authApi } = await import('@/lib/api')

    useOrganizationStore.getState().initializeFromUser(userWith('u1', [ORG_A]))

    let selectionAtRequestTime: string | null | undefined = 'not-observed'
    ;(authApi.login as any).mockImplementation(async () => {
      selectionAtRequestTime = useOrganizationStore.getState().currentOrganization?.id ?? null
      return { accessToken: 't' }
    })
    ;(authApi.getProfile as any).mockResolvedValue(userWith('u2', []))

    await useAuthStore.getState().login('u2@example.com', 'pw')

    expect(selectionAtRequestTime).toBeNull()
  })

  /**
   * The rearm is wired, not just exported. Recovery from a refused
   * organization spends a one-reload budget that nothing else restores,
   * so if login() ever stops calling this the second occurrence in a tab
   * silently degrades to a permission toast on a broken page.
   */
  it('login() rearms the stale-org-context reload budget', async () => {
    const { useAuthStore } = await import('../auth')
    const selection = await import('../organization-selection')
    const { authApi } = await import('@/lib/api')
    ;(authApi.login as any).mockResolvedValue({ accessToken: 't' })
    ;(authApi.getProfile as any).mockResolvedValue(userWith('u2', []))

    // Spend the budget, then sign in and check it came back.
    selection.recoverFromStaleOrganizationContext()
    expect(selection.recoverFromStaleOrganizationContext()).toBe(false)

    await useAuthStore.getState().login('u2@example.com', 'pw')

    expect(selection.recoverFromStaleOrganizationContext()).toBe(true)
  })
})
