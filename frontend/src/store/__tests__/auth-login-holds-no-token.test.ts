import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Tokens are httpOnly-cookie only in the browser. The backend's login
 * and register responses carry no token; the store must not go looking
 * for one either, so even a response that did carry one would leave
 * nothing in page memory or in localStorage for a script to read.
 */

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.c2lnbmF0dXJl'
const mockUser = { id: 'user-1', email: 'u@example.com', organizationMemberships: [] }

vi.mock('@/lib/api', () => ({
  authApi: {
    login: vi.fn().mockResolvedValue({ expiresIn: 86400, accessToken: JWT, refreshToken: JWT }),
    register: vi.fn().mockResolvedValue({ expiresIn: 86400, accessToken: JWT, refreshToken: JWT }),
    logout: vi.fn().mockResolvedValue(undefined),
    getProfile: vi.fn().mockResolvedValue(mockUser),
    updateProfile: vi.fn(),
  },
  organizationsApi: { getAll: vi.fn() },
}))

vi.mock('@/lib/analytics', () => ({
  identifyUser: vi.fn(),
  resetAnalytics: vi.fn(),
  captureEvent: vi.fn(),
  initAnalytics: vi.fn(),
}))

const stored = new Map<string, string>()
beforeEach(() => {
  stored.clear()
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => void stored.set(k, v),
      removeItem: (k: string) => void stored.delete(k),
      clear: () => stored.clear(),
      key: (i: number) => Array.from(stored.keys())[i] ?? null,
      get length() {
        return stored.size
      },
    },
    writable: true,
    configurable: true,
  })
})

describe('signing in keeps no token in the page', () => {
  it('login', async () => {
    const { useAuthStore } = await import('../auth')

    await useAuthStore.getState().login('u@example.com', 'pw')

    expect(useAuthStore.getState().isAuthenticated).toBe(true)
    expect(JSON.stringify(useAuthStore.getState())).not.toContain(JWT)
    for (const value of stored.values()) expect(value).not.toContain(JWT)
  })

  // Sign-up opens no session at all: signing in needs the address
  // confirmed first, so the store neither asks for a profile nor claims to
  // be signed in, and a stray token in the response is never kept.
  it('register', async () => {
    const { useAuthStore } = await import('../auth')
    const { authApi } = await import('@/lib/api')
    useAuthStore.setState({ user: null, isAuthenticated: false })
    ;(authApi.getProfile as any).mockClear()

    const result = await useAuthStore.getState().register('u@example.com', 'pw', 'U', 'Ser', 'Org')

    expect(result).toEqual({ email: 'u@example.com' })
    expect(authApi.getProfile).not.toHaveBeenCalled()
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
    expect(useAuthStore.getState().user).toBeNull()
    expect(JSON.stringify(useAuthStore.getState())).not.toContain(JWT)
    for (const value of stored.values()) expect(value).not.toContain(JWT)
  })
})