import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '../../test/setup'
import { OrganizationsPage } from '../organizations'
import { organizationsApi } from '../../lib/api'

// Regression for #129: organizationsApi.getAll() runs through
// apiGet → extractData so the resolved value already IS the array.
// The page used to read organizationsData?.data || organizations
// which was undefined for the array case and fell through to the
// Zustand-store fallback whose entries miss createdAt and isActive
// — that's why the table rendered "Invalid Date" and "Inactive"
// for the active org.

vi.mock('../../lib/api', () => ({
  organizationsApi: {
    getAll: vi.fn(),
    getMembers: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    addMember: vi.fn(),
    removeMember: vi.fn(),
    updateMemberRole: vi.fn(),
  },
}))

vi.mock('../../store/app', () => ({
  useNotifications: () => ({
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}))

vi.mock('../../store/organization', () => ({
  useOrganizationStore: () => ({
    currentOrganization: { id: 'current-org', name: 'Current' },
    organizations: [],
    setCurrentOrganization: vi.fn(),
    upsertOrganization: vi.fn(),
    removeOrganization: vi.fn(),
  }),
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useLocation: () => ({ pathname: '/organizations', search: '', hash: '', state: null }),
  }
})

describe('OrganizationsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    if (!Element.prototype.hasPointerCapture) {
      Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
      Element.prototype.setPointerCapture = vi.fn()
      Element.prototype.releasePointerCapture = vi.fn()
    }
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = vi.fn()
    }
  })

  it('keeps the API rejection visible in the creation dialog, preserves input, and clears it on retry', async () => {
    vi.mocked(organizationsApi.getAll).mockResolvedValue([])
    vi.mocked(organizationsApi.create).mockRejectedValueOnce({
      response: { data: { error: { message: 'Organization with this name or slug already exists' } } },
    }).mockImplementationOnce(() => new Promise(() => {}))
    const user = userEvent.setup()
    render(<OrganizationsPage />)
    await user.click(await screen.findByRole('button', { name: 'Create organization' }))
    const dialog = within(screen.getByRole('dialog'))
    const name = dialog.getByLabelText('Organization Name')
    await user.type(name, 'QA First Run')
    await user.click(dialog.getByRole('button', { name: 'Create', exact: true }))

    expect(await dialog.findByRole('alert')).toHaveTextContent('Organization with this name or slug already exists')
    expect(name).toHaveValue('QA First Run')
    await user.click(dialog.getByRole('button', { name: 'Create', exact: true }))
    await waitFor(() => expect(dialog.queryByRole('alert')).not.toBeInTheDocument())
    expect(dialog.getByRole('button', { name: 'Creating...' })).toBeDisabled()
  })

  it('renders the org row with its real name when given a flat array (post-extractData)', async () => {
    ;(organizationsApi.getAll as any).mockResolvedValue([
      {
        id: 'org-1',
        name: 'fresh-org-test',
        slug: 'fresh-org-test',
        description: 'Test org',
        isActive: true,
        plan: 'free',
        createdAt: '2026-06-01T12:17:57.470Z',
        updatedAt: '2026-06-02T00:00:00.000Z',
      },
    ])

    render(<OrganizationsPage />)

    await waitFor(() => {
      expect(screen.getByText('fresh-org-test')).toBeInTheDocument()
    })
    // The pre-fix behavior rendered "Invalid Date" because we fell
    // through to a Zustand-store fallback with no createdAt field.
    expect(screen.queryByText('Invalid Date')).not.toBeInTheDocument()
  })
  /**
   * Two numbers on this page were always wrong. The row subtitle read
   * `org.members?.length` off a list payload that does not hydrate the
   * relation, so it said "0 members" for a full organization; the Members
   * tab reached for `membersData.data` on a value that was already the
   * array, so it was permanently empty. Both are read straight now.
   */
  describe('member numbers', () => {
    const org = {
      id: 'org-a',
      name: 'alpha-org',
      slug: 'alpha-org',
      isActive: true,
      plan: 'free',
      memberCount: 5,
      createdAt: '2026-06-01T12:17:57.470Z',
      updatedAt: '2026-06-02T00:00:00.000Z',
    }

    it('prints the count the API sent, not zero', async () => {
      vi.mocked(organizationsApi.getAll).mockResolvedValue([org] as any)
      vi.mocked(organizationsApi.getMembers).mockResolvedValue([] as any)

      render(<OrganizationsPage />)

      expect(await screen.findByText('5 members')).toBeInTheDocument()
      expect(screen.queryByText('0 members')).not.toBeInTheDocument()
    })

    it('lists the members the API returned', async () => {
      vi.mocked(organizationsApi.getAll).mockResolvedValue([org] as any)
      vi.mocked(organizationsApi.getMembers).mockResolvedValue([
        { id: 'm1', userId: 'u1', role: 'owner', user: { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' } },
      ] as any)

      render(<OrganizationsPage />)

      await userEvent.click(await screen.findByText('alpha-org'))
      await userEvent.click(await screen.findByRole('tab', { name: /members/i }))

      expect(await screen.findByText(/ada@example.com/i)).toBeInTheDocument()
    })
  })

  // The row's onRowClick was the only way into an organization, and a click
  // handler on a <tr> is invisible to the keyboard. The name is a real
  // button now, so it is tabbable and opens on Enter.
  it('opens the organization from the keyboard', async () => {
    vi.mocked(organizationsApi.getAll).mockResolvedValue([
      {
        id: 'org-a',
        name: 'alpha-org',
        slug: 'alpha-org',
        isActive: true,
        plan: 'free',
        memberCount: 1,
        createdAt: '2026-06-01T12:17:57.470Z',
        updatedAt: '2026-06-02T00:00:00.000Z',
      },
    ] as any)
    vi.mocked(organizationsApi.getMembers).mockResolvedValue([] as any)

    render(<OrganizationsPage />)

    const nameButton = await screen.findByRole('button', { name: 'alpha-org' })
    nameButton.focus()
    expect(nameButton).toHaveFocus()

    await userEvent.keyboard('{Enter}')

    expect(await screen.findByRole('tab', { name: /members/i })).toBeInTheDocument()
  })

  // "Delete" in an organization's row menu deleted the whole organization
  // on the spot -- gateways, tools, settings, no second chance. The same
  // action inside the detail sheet had always asked; the row menu now does.
  describe('deleting from the row menu', () => {
    const org = {
      id: 'org-a',
      name: 'alpha-org',
      slug: 'alpha-org',
      isActive: true,
      plan: 'free',
      memberCount: 1,
      createdAt: '2026-06-01T12:17:57.470Z',
      updatedAt: '2026-06-02T00:00:00.000Z',
    }

    const openRowDelete = async (user: ReturnType<typeof userEvent.setup>) => {
      await screen.findByText('alpha-org')
      await user.click(screen.getByRole('button', { name: 'Actions' }))
      await user.click(await screen.findByRole('menuitem', { name: 'Delete' }))
    }

    it('asks before deleting and does not call the API until confirmed', async () => {
      vi.mocked(organizationsApi.getAll).mockResolvedValue([org] as any)
      vi.mocked(organizationsApi.delete).mockResolvedValue(undefined as any)
      const user = userEvent.setup()
      render(<OrganizationsPage />)

      await openRowDelete(user)

      const dialog = await screen.findByRole('alertdialog')
      expect(dialog).toHaveTextContent('Delete this organization?')
      expect(dialog).toHaveTextContent('alpha-org')
      expect(organizationsApi.delete).not.toHaveBeenCalled()

      await user.click(within(dialog).getByRole('button', { name: 'Delete organization' }))
      await waitFor(() => expect(organizationsApi.delete).toHaveBeenCalledTimes(1))
      expect(vi.mocked(organizationsApi.delete).mock.calls[0][0]).toBe('org-a')
    })

    it('leaves the organization alone when cancelled', async () => {
      vi.mocked(organizationsApi.getAll).mockResolvedValue([org] as any)
      const user = userEvent.setup()
      render(<OrganizationsPage />)

      await openRowDelete(user)
      await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))

      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
      expect(organizationsApi.delete).not.toHaveBeenCalled()
    })
  })

  it('asks before removing a member, and offers no dead Edit item', async () => {
    vi.mocked(organizationsApi.getAll).mockResolvedValue([
      {
        id: 'org-a',
        name: 'alpha-org',
        slug: 'alpha-org',
        isActive: true,
        plan: 'free',
        memberCount: 1,
        createdAt: '2026-06-01T12:17:57.470Z',
        updatedAt: '2026-06-02T00:00:00.000Z',
      },
    ] as any)
    vi.mocked(organizationsApi.getMembers).mockResolvedValue([
      { id: 'm1', userId: 'u1', role: 'member', user: { name: 'Ada Lovelace', email: 'ada@example.com' } },
    ] as any)
    vi.mocked(organizationsApi.removeMember).mockResolvedValue(undefined as any)
    const user = userEvent.setup()
    render(<OrganizationsPage />)

    await user.click(await screen.findByRole('button', { name: 'alpha-org' }))
    await user.click(await screen.findByRole('tab', { name: /members/i }))
    await screen.findByText(/ada@example.com/i)

    const sheet = screen.getByRole('dialog')
    await user.click(within(sheet).getByRole('button', { name: 'Actions' }))
    expect(screen.queryByRole('menuitem', { name: 'Edit' })).not.toBeInTheDocument()
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('Remove this member?')
    expect(organizationsApi.removeMember).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: 'Remove member' }))
    await waitFor(() => expect(organizationsApi.removeMember).toHaveBeenCalledWith('org-a', 'u1'))
  })
})
