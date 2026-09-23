import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { Organization, User } from '@/types'
import { organizationsApi } from '@/lib/api'
import {
  ORG_STORE_KEY,
  registerOrganizationSelectionClearer,
} from './organization-selection'

interface OrganizationState {
  organizations: Organization[]
  currentOrganization: Organization | null
  isLoading: boolean
  isInitialized: boolean
  initializeFromUser: (user: User) => void
  fetchOrganizations: () => Promise<void>
  setCurrentOrganization: (org: Organization) => void
  upsertOrganization: (org: Organization) => void
  removeOrganization: (id: string) => void
}

export const useOrganizationStore = create<OrganizationState>()(
  persist(
    (set, get) => ({
  organizations: [],
  currentOrganization: null,
  isLoading: false,
  isInitialized: false,

  initializeFromUser: (user: User) => {
    const organizations = user.organizationMemberships?.map(membership => ({
      ...membership.organization,
      members: [membership],
    })) || []

    // Preserve the previously-selected currentOrganization across
    // refresh and across re-init, but ONLY if the freshly-loaded user
    // is still a member of it. Otherwise fall back to the first
    // membership. We must NOT short-circuit on isInitialized — a
    // different user signing in on the same browser would otherwise
    // inherit the prior session's org id and the backend's
    // X-Organization-Id check would 401 every request.
    const persistedCurrent = get().currentOrganization
    const stillValid =
      persistedCurrent &&
      organizations.some(o => o.id === persistedCurrent.id)

    set({
      organizations,
      currentOrganization: stillValid ? persistedCurrent : organizations[0] || null,
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

  // Reconcilers, not request makers. React Query owns the HTTP call and
  // the server cache; this store owns the user's selection, which is
  // persisted to localStorage and read back by the axios interceptor to
  // stamp X-Organization-Id on every request. A rename or a delete that
  // only invalidates a query key therefore leaves the switcher, this
  // page's own heading and that header pointing at the old -- or a
  // deleted -- organization, so every mutation has to push the result
  // in here as well.
  upsertOrganization: (org: Organization) => {
    set(state => {
      const exists = state.organizations.some(o => o.id === org.id)
      const organizations = exists
        ? state.organizations.map(o => (o.id === org.id ? { ...o, ...org } : o))
        : [...state.organizations, org]

      let currentOrganization = state.currentOrganization
      if (currentOrganization?.id === org.id) {
        currentOrganization = { ...currentOrganization, ...org }
      } else if (!currentOrganization && !exists) {
        currentOrganization = org
      }

      return { organizations, currentOrganization }
    })
  },

  removeOrganization: (id: string) => {
    set(state => {
      const remainingOrgs = state.organizations.filter(org => org.id !== id)
      return {
        organizations: remainingOrgs,
        // Never leave the selection on an organization the server no
        // longer has: the interceptor would keep talking to it.
        currentOrganization: state.currentOrganization?.id === id
          ? remainingOrgs[0] || null
          : state.currentOrganization,
      }
    })
  },
    }),
    {
      name: ORG_STORE_KEY,
      storage: createJSONStorage(() => localStorage),
      // Only persist the user's current-org selection. Organizations
      // are refetched from the server on each session.
      partialize: (state) => ({ currentOrganization: state.currentOrganization }),
    },
  ),
)

// Hand the store's own reset to the import-free module the axios
// interceptors and the auth store talk to. Without this, "clear the
// organization selection" is only ever `localStorage.removeItem` —
// which leaves `currentOrganization` live in memory for the next
// `set()` to persist straight back. See organization-selection.ts.
registerOrganizationSelectionClearer(() => {
  useOrganizationStore.setState({
    organizations: [],
    currentOrganization: null,
    isInitialized: false,
  })
})

// Expose a synchronous accessor so callers that can't subscribe to React
// state can read the current org id outside of the React tree.
export function getCurrentOrganizationId(): string | null {
  return useOrganizationStore.getState().currentOrganization?.id ?? null
}
