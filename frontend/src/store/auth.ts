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
        try {
          const response = await authApi.login({ email, password })
          const { accessToken } = response

          localStorage.setItem('token', accessToken)

          // Fetch user profile to populate organization data
          const profileResponse = await authApi.getProfile()
          const user = profileResponse.data.data
          
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
        try {
          const response = await authApi.register({ email, password, firstName, lastName, organizationName })
          const { accessToken } = response

          localStorage.setItem('token', accessToken)

          // Fetch user profile to populate organization data
          const profileResponse = await authApi.getProfile()
          const user = profileResponse.data.data
          
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
        localStorage.removeItem('token')
        localStorage.removeItem('user')
        
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
        const token = localStorage.getItem('token')
        if (!token) {
          set({ isAuthenticated: false, user: null, token: null })
          return
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
            token,
            isAuthenticated: true,
          })
        } catch (error) {
          localStorage.removeItem('token')
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
      partialize: (state) => ({
        user: state.user,
        token: state.token,
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