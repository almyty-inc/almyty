import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'

import { render } from '../../test/setup'
import { MembersAndTeamsTab } from '../MembersAndTeamsTab'
import { organizationsApi } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  organizationsApi: {
    getMembers: vi.fn(),
    getTeams: vi.fn(),
    getPendingInvites: vi.fn(),
    removeMember: vi.fn(),
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

    expect(await screen.findByTestId('remove-member-dialog')).toBeInTheDocument()
    expect(organizationsApi.removeMember).not.toHaveBeenCalled()
  })

  it('removes the member once confirmed', async () => {
    render(<MembersAndTeamsTab organizationId="org1" />)

    fireEvent.click(await screen.findByTestId('remove-member-u1'))
    fireEvent.click(await screen.findByTestId('confirm-remove-member'))

    await waitFor(() => expect(organizationsApi.removeMember).toHaveBeenCalledWith('org1', 'u1'))
  })

  it('keeps the dialog honest when the removal fails', async () => {
    ;(organizationsApi.removeMember as any).mockRejectedValue({
      response: { data: { message: 'Owners cannot be removed.' } },
    })
    render(<MembersAndTeamsTab organizationId="org1" />)

    fireEvent.click(await screen.findByTestId('remove-member-u1'))
    fireEvent.click(await screen.findByTestId('confirm-remove-member'))

    await waitFor(() => expect(organizationsApi.removeMember).toHaveBeenCalled())
    // The dialog closes either way; what must not happen is a success
    // message for a removal that did not happen.
    await waitFor(() => expect(screen.queryByTestId('remove-member-dialog')).not.toBeInTheDocument())
  })
})
