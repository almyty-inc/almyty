/**
 * Settings > Members & teams: invite, create team, add a member to a team
 * and edit a team are inline forms in the card they belong to, not dialogs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '../../test/setup'
import { MembersAndTeamsTab } from '../MembersAndTeamsTab'
import { organizationsApi } from '../../lib/api'

vi.mock('../../lib/api', () => ({
  organizationsApi: {
    getMembers: vi.fn(),
    getTeams: vi.fn(),
    getPendingInvites: vi.fn(),
    addMember: vi.fn(),
    createTeam: vi.fn(),
    updateTeam: vi.fn(),
    addTeamMember: vi.fn(),
    removeMember: vi.fn(),
    revokePendingInvite: vi.fn(),
    deleteTeam: vi.fn(),
    removeTeamMember: vi.fn(),
    updateTeamMemberRole: vi.fn(),
  },
}))

const notify = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }))
vi.mock('../../store/app', () => ({ useNotifications: () => notify }))

const team = { id: 't1', name: 'Platform', description: 'Infra', isDefault: false, members: [] }

beforeEach(() => {
  vi.clearAllMocks()
  Element.prototype.hasPointerCapture ??= vi.fn().mockReturnValue(false) as any
  Element.prototype.setPointerCapture ??= vi.fn() as any
  Element.prototype.releasePointerCapture ??= vi.fn() as any
  Element.prototype.scrollIntoView ??= vi.fn() as any
  vi.mocked(organizationsApi.getMembers).mockResolvedValue([
    { id: 'm1', userId: 'u1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', role: 'member' },
  ] as any)
  vi.mocked(organizationsApi.getTeams).mockResolvedValue([team] as any)
  vi.mocked(organizationsApi.getPendingInvites).mockResolvedValue([] as any)
})

async function openTeams(user: ReturnType<typeof userEvent.setup>) {
  render(<MembersAndTeamsTab organizationId="org1" />)
  await user.click(screen.getByRole('tab', { name: 'Teams' }))
  await screen.findByText('Platform')
}

describe('MembersAndTeamsTab inline forms', () => {
  it('invites inline and refuses an empty email in place', async () => {
    vi.mocked(organizationsApi.addMember).mockResolvedValue({ inviteSent: true } as any)
    const user = userEvent.setup()
    render(<MembersAndTeamsTab organizationId="org1" />)

    await user.click(await screen.findByRole('button', { name: 'Invite member' }))
    const form = within(screen.getByRole('form', { name: 'Invite member' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(form.getByRole('button', { name: 'Send invitation' }))
    expect(await form.findByText('Enter an email address.')).toBeInTheDocument()
    expect(organizationsApi.addMember).not.toHaveBeenCalled()

    await user.type(form.getByLabelText(/Email address/), 'grace@example.com')
    await user.click(form.getByRole('button', { name: 'Send invitation' }))
    await waitFor(() => expect(organizationsApi.addMember).toHaveBeenCalledWith('org1', { email: 'grace@example.com', role: 'member' }))
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Invite member' })).not.toBeInTheDocument())
  })

  it('adds a member to a team inline, on that team', async () => {
    vi.mocked(organizationsApi.addTeamMember).mockResolvedValue({} as any)
    const user = userEvent.setup()
    await openTeams(user)

    await user.click(screen.getByRole('button', { name: 'Add a member to Platform' }))
    const form = within(screen.getByRole('form', { name: 'Add member to Platform' }))
    await user.click(form.getByRole('combobox', { name: /^Member/ }))
    await user.click(await screen.findByRole('option', { name: /Ada Lovelace/ }))
    await user.click(form.getByRole('button', { name: 'Add member' }))

    await waitFor(() => expect(organizationsApi.addTeamMember).toHaveBeenCalledWith('org1', 't1', { userId: 'u1', role: 'member' }))
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Add member to Platform' })).not.toBeInTheDocument())
  })

  it('edits a team inline, seeded from the team', async () => {
    vi.mocked(organizationsApi.updateTeam).mockResolvedValue({} as any)
    const user = userEvent.setup()
    await openTeams(user)

    await user.click(screen.getByRole('button', { name: 'Edit team Platform' }))
    const form = within(screen.getByRole('form', { name: 'Edit team Platform' }))
    const name = form.getByLabelText(/Team name/)
    expect(name).toHaveValue('Platform')
    await user.clear(name)
    await user.type(name, 'Platform core')
    await user.click(form.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(organizationsApi.updateTeam).toHaveBeenCalledWith('org1', 't1', { name: 'Platform core', description: 'Infra' }))
  })

  it('cancelling an inline team form closes it without saving', async () => {
    const user = userEvent.setup()
    await openTeams(user)
    await user.click(screen.getByRole('button', { name: 'Edit team Platform' }))
    await user.click(within(screen.getByRole('form', { name: 'Edit team Platform' })).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('form', { name: 'Edit team Platform' })).not.toBeInTheDocument()
    expect(organizationsApi.updateTeam).not.toHaveBeenCalled()
  })
})
