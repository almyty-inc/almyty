import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '../../test/setup'
import { MembersAndTeamsTab } from '../MembersAndTeamsTab'
import { organizationsApi } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  organizationsApi: {
    getMembers: vi.fn(),
    getTeams: vi.fn(),
    getPendingInvites: vi.fn(),
    removeMember: vi.fn(),
    revokePendingInvite: vi.fn(),
    deleteTeam: vi.fn(),
    removeTeamMember: vi.fn(),
  },
}))

/**
 * The trash icon next to each member had no onClick. It looked like the
 * way to remove somebody, so an admin who wanted them gone clicked it,
 * saw nothing happen, and had no reason to think the person still had
 * access. Now it removes them — behind a confirmation, because there is
 * no undo.
 */
describe('removing an organization member', () => {
  const member = { id: 'm1', userId: 'u1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', role: 'member' }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(organizationsApi.getMembers as any).mockResolvedValue([member])
    ;(organizationsApi.getTeams as any).mockResolvedValue([])
    ;(organizationsApi.getPendingInvites as any).mockResolvedValue([])
    ;(organizationsApi.removeMember as any).mockResolvedValue({})
  })

  it('asks before removing, and does not call the API until confirmed', async () => {
    render(<MembersAndTeamsTab organizationId="org1" />)

    fireEvent.click(await screen.findByTestId('remove-member-u1'))

    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('Remove Ada Lovelace?')
    // Their private resources are handed to the remover: say so up front.
    expect(dialog).toHaveTextContent('their private resources move to you')
    expect(organizationsApi.removeMember).not.toHaveBeenCalled()
  })

  it('does nothing when cancelled', async () => {
    render(<MembersAndTeamsTab organizationId="org1" />)

    fireEvent.click(await screen.findByTestId('remove-member-u1'))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(organizationsApi.removeMember).not.toHaveBeenCalled()
  })

  it('removes the member once confirmed', async () => {
    render(<MembersAndTeamsTab organizationId="org1" />)

    fireEvent.click(await screen.findByTestId('remove-member-u1'))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove member' }))

    await waitFor(() => expect(organizationsApi.removeMember).toHaveBeenCalledWith('org1', 'u1'))
  })

  it('keeps the dialog honest when the removal fails', async () => {
    ;(organizationsApi.removeMember as any).mockRejectedValue({
      response: { data: { message: 'Owners cannot be removed.' } },
    })
    render(<MembersAndTeamsTab organizationId="org1" />)

    fireEvent.click(await screen.findByTestId('remove-member-u1'))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove member' }))

    await waitFor(() => expect(organizationsApi.removeMember).toHaveBeenCalled())
    // The dialog closes either way; what must not happen is a success
    // message for a removal that did not happen.
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
  })
})

/**
 * Revoking an invite, deleting a team and removing someone from a team
 * went straight through (the last two via window.confirm, which is
 * unstyled and blocks the page). They now go through the shared confirm.
 */
describe('other destructive member and team actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(organizationsApi.getMembers as any).mockResolvedValue([])
    ;(organizationsApi.getPendingInvites as any).mockResolvedValue([
      { id: 'inv1', email: 'grace@example.com', role: 'member', inviteExpiresAt: '2099-01-01T00:00:00Z', isExpired: false },
    ])
    ;(organizationsApi.getTeams as any).mockResolvedValue([
      {
        id: 't1',
        name: 'Platform',
        isDefault: false,
        members: [{ userId: 'u2', role: 'member', user: { firstName: 'Grace' } }],
      },
    ])
    ;(organizationsApi.revokePendingInvite as any).mockResolvedValue({})
    ;(organizationsApi.deleteTeam as any).mockResolvedValue({})
    ;(organizationsApi.removeTeamMember as any).mockResolvedValue({})
  })

  it('revokes an invite only after confirming', async () => {
    render(<MembersAndTeamsTab organizationId="org1" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Revoke invite for grace@example.com' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('Revoke this invite?')
    expect(organizationsApi.revokePendingInvite).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke invite' }))
    await waitFor(() => expect(organizationsApi.revokePendingInvite).toHaveBeenCalledWith('org1', 'inv1'))
  })

  it('deletes a team only after confirming, without window.confirm', async () => {
    const nativeConfirm = vi.spyOn(window, 'confirm')
    const user = userEvent.setup()
    render(<MembersAndTeamsTab organizationId="org1" />)

    await user.click(await screen.findByRole('tab', { name: 'Teams' }))
    await user.click(await screen.findByRole('button', { name: 'Delete team Platform' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('Delete this team?')
    // Its resources are widened, not deleted: say so before it happens.
    expect(dialog).toHaveTextContent('its resources become visible to the whole organization')
    expect(organizationsApi.deleteTeam).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: 'Delete team' }))
    await waitFor(() => expect(organizationsApi.deleteTeam).toHaveBeenCalledWith('org1', 't1'))
    expect(nativeConfirm).not.toHaveBeenCalled()
    nativeConfirm.mockRestore()
  })

  it('removes someone from a team only after confirming', async () => {
    const user = userEvent.setup()
    render(<MembersAndTeamsTab organizationId="org1" />)

    await user.click(await screen.findByRole('tab', { name: 'Teams' }))
    await user.click(await screen.findByRole('button', { name: 'Remove Grace from Platform' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(organizationsApi.removeTeamMember).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: 'Remove from team' }))
    await waitFor(() => expect(organizationsApi.removeTeamMember).toHaveBeenCalledWith('org1', 't1', 'u2'))
  })
})