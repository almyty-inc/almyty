import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

/**
 * The httpOnly session cookie can only be cleared by the SERVER.
 *
 * logout() used to fire POST /auth/logout and forget about it
 * (`.catch(() => {})`). A sign-out that never reached the server — offline,
 * a 5xx, a dropped proxy hop — still wiped the local state and showed the
 * login page, while the cookie stayed live. Navigating back to /dashboard
 * then ran checkAuth(), the cookie authenticated, and the "signed out"
 * person was signed straight back in. On a shared machine that hands the
 * account to whoever sits down next.
 *
 * So logout() now reports whether the server confirmed. Local state is
 * still cleared synchronously either way — stranding someone in a session
 * they asked to end is worse — but the caller can say plainly that the
 * session may still be live instead of implying it is gone.
 */
const logoutMock = vi.fn()

vi.mock('@/lib/api', () => ({
  authApi: {
    logout: logoutMock,
    getProfile: vi.fn(),
    login: vi.fn(),
    register: vi.fn(),
    updateProfile: vi.fn(),
  },
}))

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

describe('auth store logout reports the server outcome', () => {
  it('resolves true when the server confirmed the session was ended', async () => {
    logoutMock.mockResolvedValue(undefined)
    const { useAuthStore } = await import('../auth')

    await expect(useAuthStore.getState().logout()).resolves.toBe(true)
    expect(logoutMock).toHaveBeenCalledTimes(1)
  })

  it('resolves false when the server call failed, instead of swallowing it', async () => {
    logoutMock.mockRejectedValue(new Error('Network Error'))
    const { useAuthStore } = await import('../auth')

    await expect(useAuthStore.getState().logout()).resolves.toBe(false)
  })

  it('clears local state synchronously, before the server has answered', async () => {
    // A pending promise: the server has not answered yet.
    let settle: () => void = () => {}
    logoutMock.mockReturnValue(new Promise<void>((resolve) => { settle = resolve }))
    const { useAuthStore } = await import('../auth')
    useAuthStore.setState({ user: { id: 'u1' } as any, isAuthenticated: true })

    const pending = useAuthStore.getState().logout()

    // Not awaited: the UI must already be signed out, so the click feels
    // instant and never waits on the wire.
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
    expect(useAuthStore.getState().user).toBeNull()

    settle()
    await expect(pending).resolves.toBe(true)
  })
})
