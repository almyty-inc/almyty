import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * A valid httpOnly cookie with an empty persisted store used to bounce
 * to the sign-in page: the layout redirected as soon as the store had
 * hydrated, before /auth/profile had answered. authChecked is the flag
 * the layout waits for.
 */
vi.mock('@/lib/api', () => ({
  authApi: {
    logout: vi.fn().mockResolvedValue(undefined),
    getProfile: vi.fn(),
    login: vi.fn(),
    register: vi.fn(),
    updateProfile: vi.fn(),
  },
}))
// `identifyForAnalytics` is a local helper inside store/auth.ts, not an export
// of @/lib/analytics — naming it here left the real import, `identifyUser`,
// absent from the mock, so every successful checkAuth threw inside the
// post-auth bookkeeping and the store's own try/catch swallowed it. The
// assertions below still passed while the analytics path was never exercised.
vi.mock('@/lib/analytics', () => ({ identifyUser: vi.fn(), resetAnalytics: vi.fn() }))

import { authApi } from '@/lib/api'
import { identifyUser } from '@/lib/analytics'
import { useAuthStore } from '../auth'

describe('checkAuth and authChecked', () => {
  beforeEach(() => {
    useAuthStore.setState({ user: null, isAuthenticated: false, authChecked: false, hasHydrated: true })
  })

  it('starts unchecked, and a valid cookie session flips authChecked with isAuthenticated', async () => {
    expect(useAuthStore.getState().authChecked).toBe(false)
    ;(authApi.getProfile as any).mockResolvedValueOnce({ id: 'u-1', email: 'a@b.c', organizationMemberships: [] })
    await useAuthStore.getState().checkAuth()
    const s = useAuthStore.getState()
    expect(s.authChecked).toBe(true)
    expect(s.isAuthenticated).toBe(true)
    expect(s.user?.id).toBe('u-1')
  })

  it('a rejected profile call also marks the check as done, with the user signed out', async () => {
    ;(authApi.getProfile as any).mockRejectedValueOnce(Object.assign(new Error('401'), { response: { status: 401 } }))
    await useAuthStore.getState().checkAuth()
    const s = useAuthStore.getState()
    expect(s.authChecked).toBe(true)
    expect(s.isAuthenticated).toBe(false)
  })

  // Guard for the mock above: a session restore must reach identifyUser.
  // Without this, renaming the export again would silently put the test
  // back on the swallowed-error path with every other assertion green.
  it('re-identifies the restored session for analytics', async () => {
    ;(authApi.getProfile as any).mockResolvedValueOnce({ id: 'u-2', email: 'a@b.c', organizationMemberships: [] })
    await useAuthStore.getState().checkAuth()
    expect(identifyUser).toHaveBeenCalledWith(expect.objectContaining({ id: 'u-2' }))
  })
})
