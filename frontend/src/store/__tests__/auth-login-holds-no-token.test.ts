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
  it.each(['login', 'register'] as const)('%s', async (action) => {
    const { useAuthStore } = await import('../auth')

    if (action === 'login') await useAuthStore.getState().login('u@example.com', 'pw')
    else await useAuthStore.getState().register('u@example.com', 'pw', 'U', 'Ser', 'Org')

    expect(useAuthStore.getState().isAuthenticated).toBe(true)
    expect(JSON.stringify(useAuthStore.getState())).not.toContain(JWT)
    for (const value of stored.values()) expect(value).not.toContain(JWT)
  })
})
