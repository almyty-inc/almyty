import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

/**
 * Verifies the auth store wires PostHog analytics: identify after a
 * successful login (contract basis), and reset on logout.
 */

const mockUser = {
  id: 'user-42',
  email: 'u@example.com',
  organizationMemberships: [
    { organization: { id: 'org-7', name: 'Acme', plan: 'pro' } },
  ],
}

vi.mock('@/lib/api', () => ({
  authApi: {
    login: vi.fn().mockResolvedValue({ accessToken: 'tok' }),
    register: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    getProfile: vi.fn().mockResolvedValue(mockUser),
    updateProfile: vi.fn(),
  },
  organizationsApi: {
    getAll: vi.fn(),
  },
}))

const identifyUser = vi.fn()
const resetAnalytics = vi.fn()
vi.mock('@/lib/analytics', () => ({
  identifyUser: (...args: unknown[]) => identifyUser(...args),
  resetAnalytics: (...args: unknown[]) => resetAnalytics(...args),
  captureEvent: vi.fn(),
  initAnalytics: vi.fn(),
}))

const makeLocalStorage = () => {
  const store = new Map<string, string>()
  return {
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
  Object.defineProperty(globalThis, 'localStorage', {
    value: makeLocalStorage(),
    writable: true,
    configurable: true,
  })
})

afterEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
})

describe('auth store analytics wiring', () => {
  it('identifies the user with id + orgId + plan after login', async () => {
    const { useAuthStore } = await import('../auth')

    await useAuthStore.getState().login('u@example.com', 'pw')

    expect(identifyUser).toHaveBeenCalledWith({
      id: 'user-42',
      orgId: 'org-7',
      plan: 'pro',
    })
  })

  it('resets analytics on logout', async () => {
    const { useAuthStore } = await import('../auth')

    useAuthStore.getState().logout()

    expect(resetAnalytics).toHaveBeenCalledTimes(1)
  })
})
