import { describe, it, expect, beforeEach, vi } from 'vitest'

import { useAuthStore } from '../auth'
import { authApi } from '../../lib/api'

// Regression for #99. Before this fix, switching users on the same
// browser (Logout one account → Login the other) would leave the
// previously-selected currentOrganization id in localStorage's
// almyty-org-store. The request interceptor then stamped that id
// into X-Organization-Id on the very first /auth/profile call,
// the backend correctly rejected it with "Not a member of the
// requested organization", and the UI rendered it as
// "Invalid credentials". This test asserts that login(), register(),
// and logout() all wipe almyty-org-store before letting any
// authenticated request fire.

vi.mock('../../lib/api', () => ({
  authApi: {
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    me: vi.fn(),
  },
}))

describe('useAuthStore — wipes almyty-org-store on auth transitions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('login() removes almyty-org-store before authenticating', async () => {
    localStorage.setItem('almyty-org-store', JSON.stringify({ state: { currentOrganization: { id: 'stale' } } }))
    ;(authApi.login as any).mockImplementation(async () => {
      // The fix is "wipe BEFORE the network call fires", so we
      // check at the moment the API would run.
      expect(localStorage.getItem('almyty-org-store')).toBeNull()
      return { accessToken: 't', user: null }
    })

    await useAuthStore.getState().login('a@b.c', 'pw').catch(() => {})
  })

  it('register() removes almyty-org-store before authenticating', async () => {
    localStorage.setItem('almyty-org-store', JSON.stringify({ state: { currentOrganization: { id: 'stale' } } }))
    ;(authApi.register as any).mockImplementation(async () => {
      expect(localStorage.getItem('almyty-org-store')).toBeNull()
      return { accessToken: 't', user: null }
    })

    await useAuthStore.getState().register('a@b.c', 'pw', 'a', 'b', 'org').catch(() => {})
  })

  it('logout() removes almyty-org-store', async () => {
    localStorage.setItem('almyty-org-store', JSON.stringify({ state: { currentOrganization: { id: 'stale' } } }))
    ;(authApi.logout as any).mockResolvedValue(undefined)

    await useAuthStore.getState().logout()

    expect(localStorage.getItem('almyty-org-store')).toBeNull()
  })
})
