import { create } from 'zustand'
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

export const useOrganizationStore = create<OrganizationState>((set, get) => ({
  organizations: [],
  currentOrganization: null,
  isLoading: false,
  isInitialized: false,

  initializeFromUser: (user: User) => {
    const organizations = user.organizationMemberships?.map(membership => ({
      ...membership.organization,
      members: [membership], // Include the membership info
    })) || []

    set({
      organizations,
      currentOrganization: organizations[0] || null,
      isInitialized: true,
    })
  },

  fetchOrganizations: async () => {
    set({ isLoading: true })
    try {
      const response = await organizationsApi.getAll()
      const organizations = response.data
      
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
      const newOrg = response.data
      
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
      const updatedOrg = response.data
      
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
}))