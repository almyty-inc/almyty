import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'

import { render } from '../../test/setup'
import { MembersAndTeamsTab } from '../MembersAndTeamsTab'
import { AgentsTab } from '../analytics/agents-tab'

const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
vi.mock('@/store/app', () => ({ useNotifications: () => notify }))
vi.mock('../../store/app', () => ({ useNotifications: () => notify }))

vi.mock('@/lib/api', () => ({
  organizationsApi: {
    getMembers: vi.fn().mockResolvedValue([]),
    getTeams: vi.fn().mockResolvedValue([]),
    getPendingInvites: vi.fn().mockResolvedValue([]),
    addMember: vi.fn(),
    removeMember: vi.fn(),
  },
  agentsApi: { getExecutions: vi.fn(), getAll: vi.fn() },
}))

vi.mock('@/store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org1', name: 'Org' } }),
}))

import { organizationsApi, agentsApi } from '@/lib/api'

/**
 * Three surfaces that reported an outcome they had not checked.
 */
describe('surfaces that used to report success regardless', () => {
  beforeEach(() => vi.clearAllMocks())

  describe('inviting a member', () => {
    const invite = async () => {
      render(<MembersAndTeamsTab organizationId="org1" />)
      fireEvent.click(await screen.findByRole('button', { name: /invite member/i }))
      fireEvent.change(await screen.findByPlaceholderText('user@example.com'), {
        target: { value: 'ada@example.com' },
      })
      fireEvent.click(screen.getByRole('button', { name: /send invitation/i }))
    }

    it('does not claim the email was sent when the provider refused it', async () => {
      // The mail service returns false rather than throwing, so this
      // resolves and the old code said "Invitation has been sent."
      ;(organizationsApi.addMember as any).mockResolvedValue({ inviteSent: false })

      await invite()

      await waitFor(() => expect(notify.warning).toHaveBeenCalled())
      expect(notify.success).not.toHaveBeenCalled()
      expect(notify.warning.mock.calls[0][1]).toMatch(/share the invite link/i)
    })

    it('says it was sent when it was', async () => {
      ;(organizationsApi.addMember as any).mockResolvedValue({ inviteSent: true })

      await invite()

      await waitFor(() => expect(notify.success).toHaveBeenCalled())
      expect(notify.warning).not.toHaveBeenCalled()
    })
  })

  describe('per-agent analytics', () => {
    it('does not report a failed fetch as a genuinely idle agent', async () => {
      ;(agentsApi.getAll as any).mockResolvedValue([
        {
          id: 'a1',
          name: 'Works',
          status: 'active',
          totalExecutions: 0,
          successfulExecutions: 0,
          averageExecutionTime: 0,
          totalCost: 0,
        },
      ])
      ;(agentsApi.getExecutions as any).mockRejectedValue(new Error('500'))

      render(<AgentsTab />)

      // "0 executions, 0% success" for an agent whose executions could
      // not be read is the same reading as an agent that has never run.
      await waitFor(() => expect(agentsApi.getExecutions).toHaveBeenCalled())
      const cell = await screen.findByTestId('agent-stats-unavailable-a1')
      expect(cell).toBeInTheDocument()
      // The row says it could not read them, rather than printing the
      // zeros that an agent which has genuinely never run would show.
      const row = cell.closest('tr')!
      expect(row.textContent).not.toMatch(/0%/)
    })
  })
})
