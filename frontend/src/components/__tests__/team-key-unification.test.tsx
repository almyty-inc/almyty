import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient } from '@tanstack/react-query'

import { render } from '../../test/setup'
import { MembersAndTeamsTab } from '../MembersAndTeamsTab'
import { VisibilityField } from '../ui/visibility-field'
import { useTeamLookup } from '../ui/team-filter'
import { organizationsApi } from '../../lib/api'

// One endpoint, one cache key. Settings -> Members & Teams read and wrote
// ['organization-teams', orgId] while every Visibility picker and team
// filter in the app read a second key over the same endpoint, so a team
// created here was missing from all of them and a deleted one was still
// on offer.

vi.mock('../../lib/api', () => ({
  organizationsApi: {
    getMembers: vi.fn(),
    getTeams: vi.fn(),
    getPendingInvites: vi.fn(),
    createTeam: vi.fn(),
    deleteTeam: vi.fn(),
    updateTeam: vi.fn(),
    addTeamMember: vi.fn(),
    removeTeamMember: vi.fn(),
    updateTeamMemberRole: vi.fn(),
    addMember: vi.fn(),
    removeMember: vi.fn(),
    revokePendingInvite: vi.fn(),
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

function TeamLookupProbe() {
  const { teams } = useTeamLookup('org-1')
  return <div data-testid="lookup">{teams.map(t => t.name).join(',')}</div>
}

function Harness() {
  return (
    <>
      <MembersAndTeamsTab organizationId="org-1" />
      <TeamLookupProbe />
      <VisibilityField
        organizationId="org-1"
        value={{ visibility: 'team', teamId: null }}
        onChange={() => {}}
      />
    </>
  )
}

describe('team mutations reach every team consumer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(organizationsApi.getMembers).mockResolvedValue([] as any)
    vi.mocked(organizationsApi.getPendingInvites).mockResolvedValue([] as any)
  })

  it('a team created in Settings turns up in the lookup and the visibility picker', async () => {
    vi.mocked(organizationsApi.getTeams)
      .mockResolvedValueOnce([{ id: 't1', name: 'Existing', isDefault: true }] as any)
      .mockResolvedValue([
        { id: 't1', name: 'Existing', isDefault: true },
        { id: 't2', name: 'Platform', isDefault: false },
      ] as any)
    vi.mocked(organizationsApi.createTeam).mockResolvedValue({ id: 't2', name: 'Platform' } as any)

    const user = userEvent.setup()
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    render(<Harness />, { queryClient })

    await waitFor(() =>
      expect(screen.getByTestId('lookup')).toHaveTextContent('Existing'),
    )
    // All three consumers share one fetch because they share one key.
    expect(organizationsApi.getTeams).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('tab', { name: 'Teams' }))
    await user.click(screen.getByRole('button', { name: /Create team/i }))
    // Inline in the Teams card now, not a dialog.
    const form = within(await screen.findByRole('form', { name: 'Create team' }))
    await user.type(form.getByLabelText(/Team name/), 'Platform')
    await user.click(form.getByRole('button', { name: 'Create team' }))

    await waitFor(() => expect(organizationsApi.createTeam).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.getByTestId('lookup')).toHaveTextContent('Existing,Platform'),
    )
  })

  it('a team deleted in Settings stops being offered everywhere else', async () => {
    vi.mocked(organizationsApi.getTeams)
      .mockResolvedValueOnce([
        { id: 't1', name: 'Existing', isDefault: true },
        { id: 't2', name: 'Doomed', isDefault: false },
      ] as any)
      .mockResolvedValue([{ id: 't1', name: 'Existing', isDefault: true }] as any)
    vi.mocked(organizationsApi.deleteTeam).mockResolvedValue({ success: true } as any)

    const user = userEvent.setup()
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    render(<Harness />, { queryClient })

    await waitFor(() =>
      expect(screen.getByTestId('lookup')).toHaveTextContent('Existing,Doomed'),
    )

    await user.click(screen.getByRole('tab', { name: 'Teams' }))
    await user.click(screen.getByRole('button', { name: 'Delete team Doomed' }))
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete team' }),
    )

    await waitFor(() => expect(organizationsApi.deleteTeam).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.getByTestId('lookup')).not.toHaveTextContent('Doomed'),
    )
    expect(screen.getByTestId('lookup')).toHaveTextContent('Existing')
  })
})
