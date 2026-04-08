import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { Organization, User } from '@/types'
import { organizationsApi } from '@/lib/api'

interface OrganizationState {
  organizations: Organization[]
  currentOrganization: Organization | null
  isLoading: boolean
  isInitialized: boolean
  initializeFromUser: (user: User) => void
  fetchOrganizations: () => Promise<void>
  setCurrentOrganization: (org: Organization) => void
  createOrganization: (data: { name: string; description?: string }) => Promise<Organization>
  updateOrganization: (id: string, data: Partial<Organization>) => Promise<void>
  deleteOrganization: (id: string) => Promise<void>
}

export const useOrganizationStore = create<OrganizationState>()(
  persist(
    (set, get) => ({
  organizations: [],
  currentOrganization: null,
  isLoading: false,
  isInitialized: false,

  initializeFromUser: (user: User) => {
    if (get().isInitialized) return
    const organizations = user.organizationMemberships?.map(membership => ({
      ...membership.organization,
      members: [membership],
    })) || []

    // Preserve a previously-selected currentOrganization across refresh,
    // but ONLY if the user is still a member of it. Otherwise fall back
    // to the first membership. This matters because the backend now
    // requires an X-Organization-Id header for multi-org users, and we
    // read the header value from this store.
    const persistedCurrent = get().currentOrganization
    const currentStillValid =
      persistedCurrent &&
      organizations.some(o => o.id === persistedCurrent.id)

    set({
      organizations,
      currentOrganization: currentStillValid ? persistedCurrent : organizations[0] || null,
      isInitialized: true,
    })
  },

  fetchOrganizations: async () => {
    set({ isLoading: true })
    try {
      const response = await organizationsApi.getAll()
      const organizations = Array.isArray(response) ? response : response?.organizations || []
      
      set({
        organizations,
        isLoading: false,
        // Set current org to first one if none selected
        currentOrganization: get().currentOrganization || organizations[0] || null,
      })
    } catch (error) {
      set({ isLoading: false })
      throw error
    }
  },

  setCurrentOrganization: (org: Organization) => {
    set({ currentOrganization: org })
  },

  createOrganization: async (data: { name: string; description?: string }) => {
    try {
      const response = await organizationsApi.create(data)
      const newOrg = response
      
      set(state => ({
        organizations: [...state.organizations, newOrg],
        currentOrganization: state.currentOrganization || newOrg,
      }))
      
      return newOrg
    } catch (error) {
      throw error
    }
  },

  updateOrganization: async (id: string, data: Partial<Organization>) => {
    try {
      const response = await organizationsApi.update(id, data)
      const updatedOrg = response
      
      set(state => ({
        organizations: state.organizations.map(org =>
          org.id === id ? updatedOrg : org
        ),
        currentOrganization: state.currentOrganization?.id === id
          ? updatedOrg
          : state.currentOrganization,
      }))
    } catch (error) {
      throw error
    }
  },

  deleteOrganization: async (id: string) => {
    try {
      await organizationsApi.delete(id)

      set(state => {
        const remainingOrgs = state.organizations.filter(org => org.id !== id)
        return {
          organizations: remainingOrgs,
          currentOrganization: state.currentOrganization?.id === id
            ? remainingOrgs[0] || null
            : state.currentOrganization,
        }
      })
    } catch (error) {
      throw error
    }
  },
    }),
    {
      name: 'almyty-org-store',
      storage: createJSONStorage(() => localStorage),
      // Only persist the user's current-org selection. Organizations
      // are refetched from the server on each session.
      partialize: (state) => ({ currentOrganization: state.currentOrganization }),
    },
  ),
)

// Expose a synchronous accessor so axios interceptors (which can't
// subscribe to React state) can read the current org id outside of
// the React tree.
export function getCurrentOrganizationId(): string | null {
  return useOrganizationStore.getState().currentOrganization?.id ?? null
}