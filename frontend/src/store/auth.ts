import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { User, AuthResponse } from '@/types'
import { authApi } from '@/lib/api'
import { useOrganizationStore } from './organization'

interface AuthState {
  user: User | null
  token: string | null
  isAuthenticated: boolean
  isLoading: boolean
  hasHydrated: boolean
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string, firstName: string, lastName: string, organizationName: string) => Promise<void>
  logout: () => void
  updateProfile: (data: Partial<User>) => Promise<void>
  checkAuth: () => Promise<void>
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      isAuthenticated: false,
      isLoading: false,
      hasHydrated: false,

      login: async (email: string, password: string) => {
        set({ isLoading: true })
        // Drop any prior session's org selection before we make any
        // authenticated requests, otherwise the request interceptor
        // stamps the stale id into X-Organization-Id on the very first
        // /auth/profile call after login and the backend 401s "Not a
        // member of the requested organization".
        localStorage.removeItem('almyty-org-store')
        try {
          const response = await authApi.login({ email, password })
          const { accessToken } = response

          // Token is set as an httpOnly cookie by the backend.
          // We do NOT copy it into localStorage — any XSS (stored
          // XSS from a user-provided string rendered somewhere, a
          // compromised npm package, a malicious browser extension)
          // can read localStorage. The whole point of the httpOnly
          // cookie is that JavaScript can't touch the token; writing
          // it back into localStorage defeats the protection. Keep
          // the token in the Zustand in-memory state only — that
          // memory is gone on page reload, and re-auth happens via
          // the still-valid cookie through `checkAuth`.

          // Fetch user profile to populate organization data
          // (cookie is already set, so this request will authenticate via cookie)
          const profileResponse = await authApi.getProfile()
          const user = profileResponse

          localStorage.setItem('user', JSON.stringify(user))

          // Initialize organization store from user data
          const { initializeFromUser } = useOrganizationStore.getState()
          initializeFromUser(user)

          set({
            user,
            token: accessToken,
            isAuthenticated: true,
            isLoading: false,
          })
        } catch (error) {
          set({ isLoading: false })
          throw error
        }
      },

      register: async (email: string, password: string, firstName: string, lastName: string, organizationName: string) => {
        set({ isLoading: true })
        // Same reasoning as login(): wipe any prior session's
        // currentOrganization so the next /auth/profile call carries the
        // new user's identity, not the stale id.
        localStorage.removeItem('almyty-org-store')
        try {
          const response = await authApi.register({ email, password, firstName, lastName, organizationName })
          const { accessToken } = response

          // httpOnly cookie is set by the backend; no localStorage copy
          // (see the login() comment for the threat model).

          // Fetch user profile to populate organization data
          const profileResponse = await authApi.getProfile()
          const user = profileResponse

          localStorage.setItem('user', JSON.stringify(user))

          // Initialize organization store from user data
          const { initializeFromUser } = useOrganizationStore.getState()
          initializeFromUser(user)

          set({
            user,
            token: accessToken,
            isAuthenticated: true,
            isLoading: false,
          })
        } catch (error) {
          set({ isLoading: false })
          throw error
        }
      },

      logout: () => {
        // Call backend to clear the httpOnly cookie
        authApi.logout().catch(() => {
          // Best-effort — even if the call fails, clear local state
        })

        // Legacy cleanup: old builds wrote 'token' + persisted
        // 'auth-storage.token' into localStorage. Remove both so an
        // upgrade from a vulnerable client leaves no residue behind.
        localStorage.removeItem('token')
        localStorage.removeItem('user')
        localStorage.removeItem('auth-storage')
        // Drop the previously-selected currentOrganization too. Without
        // this, a different user signing in on the same browser inherits
        // the prior session's org id, the request interceptor stamps it
        // into X-Organization-Id, and the backend correctly 401s with
        // "Not a member of the requested organization" — looks to the
        // user as an "Invalid credentials" failure.
        localStorage.removeItem('almyty-org-store')

        set({
          user: null,
          token: null,
          isAuthenticated: false,
        })
      },

      updateProfile: async (data: Partial<User>) => {
        try {
          const response = await authApi.updateProfile(data)
          const updatedUser = response

          localStorage.setItem('user', JSON.stringify(updatedUser))
          set({ user: updatedUser })
        } catch (error) {
          throw error
        }
      },

      checkAuth: async () => {
        // With httpOnly cookies the browser sends the cookie
        // automatically on every request to the same origin. The
        // frontend doesn't know or care whether the cookie is
        // present — we just try to fetch the profile and trust the
        // server's answer. If the cookie is valid we're
        // authenticated, otherwise we fall through to the cleared
        // state. Previously we short-circuited this based on a
        // localStorage.getItem('token') probe which is now always
        // null (we stopped writing it); the short-circuit left
        // users with a valid cookie stranded in the logged-out UI.
        const { user: persistedUser } = get()

        if (!persistedUser) {
          // No cached user in the Zustand store → cold start. Try
          // the profile fetch anyway; the cookie may still be valid
          // from a previous session on this browser.
        }

        try {
          const response = await authApi.getProfile()
          const user = response

          localStorage.setItem('user', JSON.stringify(user))

          // Initialize organization store from user data
          const { initializeFromUser } = useOrganizationStore.getState()
          initializeFromUser(user)

          set({
            user,
            token: null,
            isAuthenticated: true,
          })
        } catch (error) {
          localStorage.removeItem('user')
          set({
            user: null,
            token: null,
            isAuthenticated: false,
          })
        }
      },
    }),
    {
      name: 'auth-storage',
      // Do NOT persist `token` to localStorage — the Zustand
      // persist middleware would otherwise write it to
      // `auth-storage.state.token`, defeating the whole point of
      // the httpOnly cookie. Persist only the minimal display
      // state (user profile + auth flag) so the UI can render
      // without a round trip on page refresh.
      partialize: (state) => ({
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }),
      onRehydrateStorage: () => (state) => {
        state?.hasHydrated && (state.hasHydrated = true)
        if (!state) return
        state.hasHydrated = true
      },
    }
  )
)
