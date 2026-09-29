import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '../../test/setup'
import { SettingsPage } from '../settings'
import { OrganizationsPage } from '../organizations'
import { useOrganizationStore } from '../../store/organization'
import { organizationsApi } from '../../lib/api'

// The organization entity has two owners: React Query and the Zustand
// store, whose currentOrganization is persisted to localStorage and read
// back by the axios interceptor to stamp X-Organization-Id. Every
// mutation used to invalidate only the query keys, so a rename kept
// rendering the old name (and survived a reload) and a delete left the
// whole app addressing an organization the server no longer had.

vi.mock('../../lib/api', () => ({
  organizationsApi: {
    getAll: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    getMembers: vi.fn(),
    addMember: vi.fn(),
    removeMember: vi.fn(),
    updateMemberRole: vi.fn(),
  },
  authApi: { getProfile: vi.fn(), updateProfile: vi.fn() },
}))

vi.mock('../../store/app', () => ({
  useNotifications: () => ({
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}))

const ORG = {
  id: 'org-1',
  name: 'Old Name',
  description: 'desc',
  createdAt: '2024-01-01T00:00:00.000Z',
} as any
const OTHER = { id: 'org-2', name: 'Survivor' } as any

describe('organization store stays in sync with the server', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    useOrganizationStore.setState({
      organizations: [ORG, OTHER],
      currentOrganization: ORG,
      isInitialized: true,
      isLoading: false,
    })
    vi.mocked(organizationsApi.getAll).mockResolvedValue([ORG, OTHER])
    vi.mocked(organizationsApi.getById).mockResolvedValue(ORG)
    if (!Element.prototype.hasPointerCapture) {
      Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
      Element.prototype.setPointerCapture = vi.fn()
      Element.prototype.releasePointerCapture = vi.fn()
    }
  })

  it('keeps every settings section in a wrapping navigation group', async () => {
    render(<SettingsPage />)
    const sections = screen.getByRole('tablist', { name: 'Settings sections' })
    expect(sections).toHaveClass('flex-wrap')
    expect(within(sections).getAllByRole('tab')).toHaveLength(5)
    for (const name of ['Organization', 'Your account', 'People and access', 'Billing', 'Advanced']) {
      expect(within(sections).getByRole('tab', { name, exact: true })).toBeEnabled()
    }
    await screen.findByText('Old Name')
  })

  it('renaming from Settings updates the store, so the name on screen changes', async () => {
    vi.mocked(organizationsApi.update).mockResolvedValue({
      ...ORG,
      name: 'New Name',
    })
    const user = userEvent.setup()
    render(<SettingsPage />)

    expect(await screen.findByText('Old Name')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Edit organization' }))
    const nameInput = screen.getByLabelText('Organization name')
    await user.clear(nameInput)
    await user.type(nameInput, 'New Name')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(
        useOrganizationStore.getState().currentOrganization?.name,
      ).toBe('New Name'),
    )
    expect(await screen.findByText('New Name')).toBeInTheDocument()
    expect(screen.queryByText('Old Name')).not.toBeInTheDocument()
    expect(
      useOrganizationStore.getState().organizations.find(o => o.id === 'org-1')?.name,
    ).toBe('New Name')
  })

  it('deleting the current organization moves the selection off it', async () => {
    vi.mocked(organizationsApi.delete).mockResolvedValue({ success: true })
    const user = userEvent.setup()
    render(<OrganizationsPage />)

    const row = (await screen.findByText('Old Name')).closest('tr')!
    await user.click(within(row).getByRole('button', { name: 'Actions' }))
    await user.click(await screen.findByText('Delete'))
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete organization' }),
    )

    await waitFor(() =>
      expect((organizationsApi.delete as any).mock.calls[0]?.[0]).toBe('org-1'),
    )
    await waitFor(() => {
      const state = useOrganizationStore.getState()
      expect(state.currentOrganization?.id).toBe('org-2')
      expect(state.organizations.map(o => o.id)).not.toContain('org-1')
    })
  })
})

describe('organization store reconcilers', () => {
  beforeEach(() => {
    localStorage.clear()
    useOrganizationStore.setState({
      organizations: [ORG, OTHER],
      currentOrganization: ORG,
    })
  })

  it('upsert merges into the list and the current selection', () => {
    useOrganizationStore.getState().upsertOrganization({ ...ORG, name: 'Renamed' })
    const state = useOrganizationStore.getState()
    expect(state.currentOrganization?.name).toBe('Renamed')
    expect(state.currentOrganization?.description).toBe('desc')
    expect(state.organizations).toHaveLength(2)
  })

  it('upsert appends an organization it has never seen', () => {
    useOrganizationStore.getState().upsertOrganization({ id: 'org-3', name: 'Third' } as any)
    const state = useOrganizationStore.getState()
    expect(state.organizations.map(o => o.id)).toEqual(['org-1', 'org-2', 'org-3'])
    // The current selection is untouched when another org is added.
    expect(state.currentOrganization?.id).toBe('org-1')
  })

  it('remove clears a selection pointing at the deleted organization', () => {
    useOrganizationStore.getState().removeOrganization('org-1')
    const state = useOrganizationStore.getState()
    expect(state.currentOrganization?.id).toBe('org-2')
  })

  it('remove leaves a selection that points elsewhere alone', () => {
    useOrganizationStore.getState().removeOrganization('org-2')
    const state = useOrganizationStore.getState()
    expect(state.currentOrganization?.id).toBe('org-1')
    expect(state.organizations.map(o => o.id)).toEqual(['org-1'])
  })

  it('removing the last organization leaves no selection for the interceptor to send', () => {
    useOrganizationStore.setState({ organizations: [ORG], currentOrganization: ORG })
    useOrganizationStore.getState().removeOrganization('org-1')
    expect(useOrganizationStore.getState().currentOrganization).toBeNull()
  })
})
