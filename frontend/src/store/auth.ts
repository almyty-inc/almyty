import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { User } from '@/types'
import { authApi } from '@/lib/api'
import { useOrganizationStore } from './organization'
import {
  armOrganizationContextRecovery,
  clearOrganizationSelection,
} from './organization-selection'
import { identifyUser, resetAnalytics } from '@/lib/analytics'

// Identify the logged-in user in PostHog. Called only after auth succeeds
// (contract basis). Carries the minimum: user id + current org id + plan.
// No-op when analytics is disabled (no ALMYTY_POSTHOG_KEY).
function identifyForAnalytics(user: User) {
  if (!user?.id) return
  const org = useOrganizationStore.getState().currentOrganization
  identifyUser({ id: user.id, orgId: org?.id, plan: org?.plan })
}

interface AuthState {
  user: User | null
  token: string | null
  isAuthenticated: boolean
  isLoading: boolean
  hasHydrated: boolean
  /** True once checkAuth has answered (either way); layouts redirect only after that. */
  authChecked: boolean
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string, firstName: string, lastName: string, organizationName: string, captchaToken?: string) => Promise<void>
  /** Resolves false when the server never confirmed the session was ended. */
  logout: () => Promise<boolean>
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
      authChecked: false,

      login: async (email: string, password: string) => {
        set({ isLoading: true })
        // Drop any prior session's org selection before we make any
        // authenticated requests, otherwise the request interceptor
        // stamps the stale id into X-Organization-Id on the very first
        // /auth/profile call after login and the backend refuses it with
        // "Not a member of the requested organization".
        //
        // This clears the STORE, not just its localStorage key. Removing
        // the key left `currentOrganization` live in memory, so the next
        // `set()` persisted it straight back and `initializeFromUser`
        // below still measured the new user against the old session's
        // org — the stale id came back either way.
        clearOrganizationSelection()
        // A deliberate sign-in also restores the one-reload budget the
        // stale-org-context recovery spends. Only a person clicking Sign
        // in can rearm it, so it cannot spin.
        armOrganizationContextRecovery()
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

          // Identify only after a successful login (contract basis).
          identifyForAnalytics(user)

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

      register: async (email: string, password: string, firstName: string, lastName: string, organizationName: string, captchaToken?: string) => {
        set({ isLoading: true })
        // Same reasoning as login(): wipe any prior session's
        // currentOrganization so the next /auth/profile call carries the
        // new user's identity, not the stale id.
        clearOrganizationSelection()
        armOrganizationContextRecovery()
        try {
          const response = await authApi.register({ email, password, firstName, lastName, organizationName, captchaToken })
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

          // Identify only after a successful registration (contract basis).
          identifyForAnalytics(user)

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

      logout: async () => {
        // Local state goes first and synchronously (everything up to the
        // await below runs before the caller gets its promise), so the UI
        // still responds to the click at once and never waits on the wire.
        //
        // Legacy cleanup: old builds wrote 'token' + persisted
        // 'auth-storage.token' into localStorage. Remove both so an
        // upgrade from a vulnerable client leaves no residue behind.
        localStorage.removeItem('token')
        localStorage.removeItem('user')
        localStorage.removeItem('auth-storage')
        // Drop the previously-selected currentOrganization too — from the
        // live store, not only from storage. Without this, a different
        // user signing in on the same browser inherits the prior
        // session's org id, the request interceptor stamps it into
        // X-Organization-Id, and the backend correctly refuses it with
        // "Not a member of the requested organization".
        clearOrganizationSelection()

        // Drop the PostHog identity so the next user on this browser is
        // not stitched to the previous session.
        resetAnalytics()

        set({
          user: null,
          token: null,
          isAuthenticated: false,
        })

        // Only the SERVER can clear the httpOnly cookie. This call used to
        // be fire-and-forget (`.catch(() => {})`), so a sign-out that never
        // reached the server -- offline, a 5xx, a dropped proxy hop -- still
        // showed the login page while the session cookie stayed live.
        // Navigating back to /dashboard then ran checkAuth(), the cookie
        // authenticated, and the "signed out" user was signed straight back
        // in; on a shared machine that hands the account to whoever sits
        // down next. Report the outcome so the caller can say so.
        try {
          await authApi.logout()
          return true
        } catch {
          return false
        }
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

        let user: User
        try {
          user = await authApi.getProfile()
        } catch {
          // Only the server's answer signs the user out.
          localStorage.removeItem('user')
          set({
            user: null,
            token: null,
            isAuthenticated: false,
            authChecked: true,
          })
          return
        }

        // Client-side bookkeeping after a successful profile fetch must
        // never log the user out; a broken analytics hook or a full
        // localStorage is not a sign-out.
        try {
          localStorage.setItem('user', JSON.stringify(user))
          const { initializeFromUser } = useOrganizationStore.getState()
          initializeFromUser(user)
          // Re-identify on cookie-based session restore. The user is
          // authenticated (valid cookie), so this is on contract basis.
          identifyForAnalytics(user)
        } catch (error) {
          console.warn('post-auth bookkeeping failed', error)
        }

        set({
          user,
          token: null,
          isAuthenticated: true,
          authChecked: true,
        })
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
