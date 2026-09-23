/**
 * /organizations/new and /organizations/:id -- what used to be a create
 * dialog, a detail sheet, an invite dialog and a window.prompt for the
 * role. Driven under a real router.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderAtRoute } from '../../test/render-at-route'
import { OrganizationNewPage, OrganizationDetailPage } from '../organization-pages'
import { organizationsApi } from '../../lib/api'

vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

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

const notify = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }))
vi.mock('../../store/app', () => ({ useNotifications: () => notify }))

const store = vi.hoisted(() => ({
  setCurrentOrganization: vi.fn(),
  upsertOrganization: vi.fn(),
  removeOrganization: vi.fn(),
}))
vi.mock('../../store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org-a', name: 'alpha-org' }, organizations: [], ...store }),
}))

const org = {
  id: 'org-a',
  name: 'alpha-org',
  slug: 'alpha-org',
  description: 'The first one',
  isActive: true,
  plan: 'free',
  memberCount: 1,
  createdAt: '2026-06-01T12:17:57.470Z',
  updatedAt: '2026-06-02T00:00:00.000Z',
}
const ada = { id: 'm1', userId: 'u1', role: 'member', user: { name: 'Ada Lovelace', email: 'ada@example.com' } }

beforeEach(() => {
  vi.clearAllMocks()
  Element.prototype.hasPointerCapture ??= vi.fn().mockReturnValue(false) as any
  Element.prototype.setPointerCapture ??= vi.fn() as any
  Element.prototype.releasePointerCapture ??= vi.fn() as any
  Element.prototype.scrollIntoView ??= vi.fn() as any
  vi.mocked(organizationsApi.getAll).mockResolvedValue([org] as any)
  vi.mocked(organizationsApi.getMembers).mockResolvedValue([ada] as any)
})

describe('/organizations/new', () => {
  const NEW = { path: '/organizations/new', paths: ['/organizations/:id', '/organizations'] }

  it('creates, switches to it and opens its page', async () => {
    vi.mocked(organizationsApi.create).mockResolvedValue({ id: 'org-new', name: 'QA First Run' } as any)
    const user = userEvent.setup()
    renderAtRoute(<OrganizationNewPage />, NEW)

    await user.type(screen.getByLabelText(/Organization name/), 'QA First Run')
    await user.click(screen.getByRole('button', { name: 'Create organization' }))

    await waitFor(() => expect(vi.mocked(organizationsApi.create).mock.calls[0][0]).toMatchObject({ name: 'QA First Run' }))
    expect(await screen.findByText('at /organizations/org-new')).toBeInTheDocument()
    expect(store.setCurrentOrganization).toHaveBeenCalledWith(expect.objectContaining({ id: 'org-new' }))
  })

  it('keeps the API rejection visible, preserves input, and clears it on retry', async () => {
    vi.mocked(organizationsApi.create)
      .mockRejectedValueOnce({ response: { data: { error: { message: 'Organization with this name or slug already exists' } } } })
      .mockImplementationOnce(() => new Promise(() => {}))
    const user = userEvent.setup()
    renderAtRoute(<OrganizationNewPage />, NEW)
    const name = screen.getByLabelText(/Organization name/)
    await user.type(name, 'QA First Run')
    await user.click(screen.getByRole('button', { name: 'Create organization' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Organization with this name or slug already exists')
    expect(name).toHaveValue('QA First Run')
    await user.click(screen.getByRole('button', { name: 'Create organization' }))
    await waitFor(() => expect(screen.queryByText(/already exists/)).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Creating...' })).toBeDisabled()
  })

  it('focuses the name when it is too short', async () => {
    renderAtRoute(<OrganizationNewPage />, NEW)
    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }))
    expect(await screen.findByText('Name must be at least 2 characters')).toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(/Organization name/)))
    expect(organizationsApi.create).not.toHaveBeenCalled()
  })
})

describe('/organizations/:id', () => {
  const DETAIL = { path: '/organizations/:id', url: '/organizations/org-a?tab=members', paths: ['/organizations'] }

  it('lists the members the API returned on the Members tab', async () => {
    renderAtRoute(<OrganizationDetailPage />, DETAIL)
    expect(await screen.findByRole('heading', { name: 'alpha-org' })).toBeInTheDocument()
    expect(await screen.findByText(/ada@example.com/i)).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('invites inline and reports an undelivered email honestly', async () => {
    vi.mocked(organizationsApi.addMember).mockResolvedValue({ inviteSent: false } as any)
    const user = userEvent.setup()
    renderAtRoute(<OrganizationDetailPage />, DETAIL)

    await user.click(await screen.findByRole('button', { name: 'Invite member' }))
    const form = within(screen.getByRole('form', { name: 'Invite team member' }))
    await user.type(form.getByLabelText(/Email address/), 'grace@example.com')
    await user.click(form.getByRole('button', { name: 'Send invitation' }))

    await waitFor(() => expect(organizationsApi.addMember).toHaveBeenCalledWith('org-a', { email: 'grace@example.com', role: 'member' }))
    await waitFor(() => expect(notify.warning).toHaveBeenCalledWith('Invite created, email not delivered', expect.any(String)))
    expect(screen.queryByRole('form', { name: 'Invite team member' })).not.toBeInTheDocument()
  })

  it('refuses a bad email inline without posting', async () => {
    const user = userEvent.setup()
    renderAtRoute(<OrganizationDetailPage />, DETAIL)
    await user.click(await screen.findByRole('button', { name: 'Invite member' }))
    const form = within(screen.getByRole('form', { name: 'Invite team member' }))
    await user.type(form.getByLabelText(/Email address/), 'not-an-email')
    await user.click(form.getByRole('button', { name: 'Send invitation' }))
    expect(await form.findByText('Invalid email address')).toBeInTheDocument()
    expect(organizationsApi.addMember).not.toHaveBeenCalled()
  })

  it('changes a role through an inline select, not a prompt', async () => {
    vi.mocked(organizationsApi.updateMemberRole).mockResolvedValue({} as any)
    const promptSpy = vi.spyOn(window, 'prompt')
    const user = userEvent.setup()
    renderAtRoute(<OrganizationDetailPage />, DETAIL)

    await screen.findByText(/ada@example.com/i)
    await user.click(screen.getByRole('button', { name: 'Actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Change role' }))
    await user.click(await screen.findByRole('combobox', { name: 'Role for Ada Lovelace' }))
    await user.click(await screen.findByRole('option', { name: 'Admin' }))

    await waitFor(() => expect(organizationsApi.updateMemberRole).toHaveBeenCalledWith('org-a', 'u1', { role: 'admin' }))
    expect(promptSpy).not.toHaveBeenCalled()
  })

  it('asks before removing a member, and offers no dead Edit item', async () => {
    vi.mocked(organizationsApi.removeMember).mockResolvedValue(undefined as any)
    const user = userEvent.setup()
    renderAtRoute(<OrganizationDetailPage />, DETAIL)

    await screen.findByText(/ada@example.com/i)
    await user.click(screen.getByRole('button', { name: 'Actions' }))
    expect(screen.queryByRole('menuitem', { name: 'Edit' })).not.toBeInTheDocument()
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('Remove this member?')
    expect(organizationsApi.removeMember).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Remove member' }))
    await waitFor(() => expect(organizationsApi.removeMember).toHaveBeenCalledWith('org-a', 'u1'))
  })

  it('renames inline on the Settings tab and updates the store', async () => {
    vi.mocked(organizationsApi.update).mockResolvedValue({ ...org, name: 'beta-org' } as any)
    const user = userEvent.setup()
    renderAtRoute(<OrganizationDetailPage />, { ...DETAIL, url: '/organizations/org-a?tab=settings' })

    const name = await screen.findByLabelText(/Organization name/)
    await user.clear(name)
    await user.type(name, 'beta-org')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(organizationsApi.update).toHaveBeenCalledWith('org-a', { name: 'beta-org', description: 'The first one' }))
    expect(store.upsertOrganization).toHaveBeenCalledWith(expect.objectContaining({ name: 'beta-org' }))
  })

  it('deletes after confirming and returns to the list', async () => {
    vi.mocked(organizationsApi.delete).mockResolvedValue(undefined as any)
    const user = userEvent.setup()
    renderAtRoute(<OrganizationDetailPage />, { ...DETAIL, url: '/organizations/org-a?tab=settings' })

    await user.click(await screen.findByRole('button', { name: 'Delete organization' }))
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Delete organization' }))
    await waitFor(() => expect(organizationsApi.delete).toHaveBeenCalledWith('org-a'))
    expect(store.removeOrganization).toHaveBeenCalledWith('org-a')
    expect(await screen.findByText('at /organizations')).toBeInTheDocument()
  })
})
