import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

/**
 * Regression test for auth.logout() not clearing the persisted
 * Zustand store. Previously the logout path cleared the `token` and
 * `user` localStorage keys but NOT the `auth-storage` key that
 * Zustand's persist middleware writes. A hard refresh after "logout"
 * re-hydrated the stale token and the user appeared to be logged
 * back in.
 */

// Stub the backend logout call so we don't hit the network.
vi.mock('@/lib/api', () => ({
  authApi: {
    logout: vi.fn().mockResolvedValue(undefined),
    getProfile: vi.fn(),
    login: vi.fn(),
    register: vi.fn(),
    updateProfile: vi.fn(),
  },
}))

// Build a local localStorage mock so we can inspect what the logout
// path removed.
const makeLocalStorage = () => {
  const store = new Map<string, string>()
  return {
    store,
    getItem: vi.fn((k: string) => store.get(k) ?? null),
    setItem: vi.fn((k: string, v: string) => store.set(k, v)),
    removeItem: vi.fn((k: string) => store.delete(k)),
    clear: vi.fn(() => store.clear()),
    key: vi.fn((i: number) => Array.from(store.keys())[i] ?? null),
    get length() {
      return store.size
    },
  }
}

beforeEach(() => {
  const ls = makeLocalStorage()
  ls.setItem('token', 'stale-jwt-value')
  ls.setItem('user', '{"id":"u1","email":"u@example.com"}')
  ls.setItem(
    'auth-storage',
    JSON.stringify({
      state: {
        user: { id: 'u1', email: 'u@example.com' },
        token: 'stale-jwt-value',
        isAuthenticated: true,
      },
      version: 0,
    }),
  )
  Object.defineProperty(globalThis, 'localStorage', {
    value: ls,
    writable: true,
    configurable: true,
  })
})

afterEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
})

describe('auth store logout', () => {
  it('clears token + user and ensures the persisted store contains no live session', async () => {
    const { useAuthStore } = await import('../auth')

    useAuthStore.getState().logout()

    const ls = globalThis.localStorage
    expect(ls.getItem('token')).toBeNull()
    expect(ls.getItem('user')).toBeNull()

    // Zustand's persist middleware rewrites `auth-storage` on every
    // state change — and logout triggers `set({...})` right after we
    // remove the key. The key will therefore be present again, but
    // it must contain only the CLEARED state (no live user flag).
    //
    // The partialize config NO LONGER persists the `token` field
    // at all — see auth.ts for the XSS rationale. So we check that
    // the rehydrated state contains no user and isAuthenticated=false,
    // and ALSO that the token field is absent from the persisted
    // payload (previously writing the token to localStorage made it
    // readable by any script on the page).
    const raw = ls.getItem('auth-storage')
    if (raw !== null) {
      const parsed = JSON.parse(raw)
      expect(parsed.state?.user).toBeNull()
      expect(parsed.state?.isAuthenticated).toBe(false)
      expect(parsed.state?.token).toBeUndefined()
    }
  })

  it('clears the in-memory auth state', async () => {
    const { useAuthStore } = await import('../auth')

    useAuthStore.getState().logout()

    const state = useAuthStore.getState()
    expect(state.user).toBeNull()
    expect(state.token).toBeNull()
    expect(state.isAuthenticated).toBe(false)
  })

  it('clears the persisted org store so a different user signing in after logout does not inherit the prior session orgId', async () => {
    // Seed the org store with a prior user's selection. The bug we're
    // pinning: logout used to leave this alone, so the next login's
    // first /auth/profile call carried the stale X-Organization-Id and
    // the backend returned 401 "Not a member of the requested
    // organization", visible to the user as "Invalid credentials".
    const ls = globalThis.localStorage
    ls.setItem(
      'almyty-org-store',
      JSON.stringify({
        state: { currentOrganization: { id: 'org-from-prior-user', name: 'old' } },
        version: 0,
      }),
    )

    const { useAuthStore } = await import('../auth')
    useAuthStore.getState().logout()

    // Either the key is gone, or it's been rewritten by the persist
    // middleware to currentOrganization=null. Both are acceptable —
    // what matters is that the prior session's id is no longer
    // retrievable.
    const raw = ls.getItem('almyty-org-store')
    if (raw !== null) {
      const parsed = JSON.parse(raw)
      expect(parsed.state?.currentOrganization?.id).toBeUndefined()
    }
  })
})
