import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { renderWithProviders } from '../../../../test/setup'
import { PromotedSkillsTab } from '../promoted-skills-tab'
import { PromoteRunSection } from '../promote-run-section'
import { RunsTab } from '../runs-tab'
import type { AgentRun } from '@/types'
import { promotedSkillsApi } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  promotedSkillsApi: {
    list: vi.fn(),
    promote: vi.fn(),
    remove: vi.fn(),
    get: vi.fn(),
  },
}))

const skills = [
  {
    id: 's1', agentId: 'agent-1', name: 'Revenue report', description: 'monthly',
    slug: 'revenue-report', version: 2, content: '# SKILL', createdAt: '2026-06-24T00:00:00Z',
  },
  {
    id: 's2', agentId: 'other-agent', name: 'Unrelated skill',
    slug: 'unrelated', version: 1, content: '# X', createdAt: '2026-06-24T00:00:00Z',
  },
]

describe('PromotedSkillsTab', () => {
  beforeEach(() => vi.clearAllMocks())

  it("lists only this agent's promoted skills", async () => {
    ;(promotedSkillsApi.list as any).mockResolvedValue(skills)
    renderWithProviders(<PromotedSkillsTab agentId="agent-1" />)

    expect(await screen.findByText('Revenue report')).toBeInTheDocument()
    expect(screen.queryByText('Unrelated skill')).not.toBeInTheDocument()
    expect(screen.getByText('v2')).toBeInTheDocument()
  })

  it('shows an empty state when the agent has no skills', async () => {
    ;(promotedSkillsApi.list as any).mockResolvedValue([])
    renderWithProviders(<PromotedSkillsTab agentId="agent-1" />)

    expect(await screen.findByText(/No promoted skills yet/)).toBeInTheDocument()
  })

  // A failed fetch used to look exactly like an agent with nothing promoted,
  // and sent the user off to promote a run they had already promoted.
  it('shows the retryable error state, not the empty state, when the list fails', async () => {
    ;(promotedSkillsApi.list as any).mockRejectedValue(new Error('boom'))
    renderWithProviders(<PromotedSkillsTab agentId="agent-1" />)

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load promoted skills")
    expect(screen.queryByText(/No promoted skills yet/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument()
  })

  // The SKILL.md viewer was a dialog; it now opens under the skill's row.
  it('opens a skill\'s SKILL.md inline under its row, not in a dialog, and closes it again', async () => {
    ;(promotedSkillsApi.list as any).mockResolvedValue(skills)
    renderWithProviders(<PromotedSkillsTab agentId="agent-1" />)

    const view = await screen.findByRole('button', { name: /View SKILL.md for Revenue report/ })
    expect(view).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('# SKILL')).not.toBeInTheDocument()

    fireEvent.click(view)
    const panel = screen.getByRole('region', { name: 'SKILL.md for Revenue report' })
    expect(within(panel).getByText('# SKILL')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // Replay and Delete stay reachable while it is open.
    expect(screen.getByRole('button', { name: /Replay/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Delete promoted skill Revenue report/ })).toBeInTheDocument()

    const hide = screen.getByRole('button', { name: /Hide SKILL.md for Revenue report/ })
    expect(hide).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(hide)
    expect(screen.queryByText('# SKILL')).not.toBeInTheDocument()
  })
})

describe('PromoteRunSection', () => {
  beforeEach(() => vi.clearAllMocks())

  it('opens the promote form inline, not in a dialog', () => {
    renderWithProviders(<PromoteRunSection runId="run-1" />)
    expect(screen.queryByRole('form', { name: 'Promote run to skill' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Promote to skill/ }))
    expect(screen.getByRole('form', { name: 'Promote run to skill' })).toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toBeInTheDocument()
    expect(screen.getByLabelText('Description')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('promotes the run with the trimmed name and description, then closes', async () => {
    ;(promotedSkillsApi.promote as any).mockResolvedValue({ id: 's9' })
    renderWithProviders(<PromoteRunSection runId="run-1" />)

    fireEvent.click(screen.getByRole('button', { name: /Promote to skill/ }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Revenue report  ' } })
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'monthly' } })
    fireEvent.click(screen.getByRole('button', { name: 'Promote' }))

    await waitFor(() =>
      expect(promotedSkillsApi.promote).toHaveBeenCalledWith({
        runId: 'run-1',
        name: 'Revenue report',
        description: 'monthly',
      }),
    )
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Promote run to skill' })).not.toBeInTheDocument(),
    )
  })

  it('leaves blank fields for the server to derive', async () => {
    ;(promotedSkillsApi.promote as any).mockResolvedValue({ id: 's9' })
    renderWithProviders(<PromoteRunSection runId="run-2" />)

    fireEvent.click(screen.getByRole('button', { name: /Promote to skill/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Promote' }))

    await waitFor(() =>
      expect(promotedSkillsApi.promote).toHaveBeenCalledWith({
        runId: 'run-2',
        name: undefined,
        description: undefined,
      }),
    )
  })

  it('keeps the form and its input open when promotion fails', async () => {
    ;(promotedSkillsApi.promote as any).mockRejectedValue(new Error('nope'))
    renderWithProviders(<PromoteRunSection runId="run-1" />)

    fireEvent.click(screen.getByRole('button', { name: /Promote to skill/ }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Kept' } })
    fireEvent.click(screen.getByRole('button', { name: 'Promote' }))

    await waitFor(() => expect(promotedSkillsApi.promote).toHaveBeenCalled())
    expect(screen.getByRole('form', { name: 'Promote run to skill' })).toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toHaveValue('Kept')
  })

  it('Cancel closes the form and clears what was typed', () => {
    renderWithProviders(<PromoteRunSection runId="run-1" />)

    fireEvent.click(screen.getByRole('button', { name: /Promote to skill/ }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('form', { name: 'Promote run to skill' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Promote to skill/ }))
    expect(screen.getByLabelText('Name')).toHaveValue('')
  })
})
describe('RunsTab promote entry point', () => {
  const run = (id: string, status: string) =>
    ({
      id, agentId: 'agent-1', organizationId: 'org-1', mode: 'autonomous', status,
      thread: [], workingMemory: {}, steps: [], currentStep: 1, maxSteps: 5,
      totalCost: 0, totalTokens: 0, executionTime: 0,
      createdAt: '2026-06-24T00:00:00Z', updatedAt: '2026-06-24T00:00:00Z',
    }) as unknown as AgentRun

  it('offers promotion inside an expanded completed run and opens the form in place', () => {
    renderWithProviders(<RunsTab runs={[run('r-ok', 'completed')]} />)
    fireEvent.click(screen.getAllByRole('button', { expanded: false })[0])

    fireEvent.click(screen.getByRole('button', { name: /Promote to skill/ }))
    expect(screen.getByRole('form', { name: 'Promote run to skill' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('does not offer promotion for a failed run', () => {
    renderWithProviders(<RunsTab runs={[run('r-bad', 'failed')]} />)
    fireEvent.click(screen.getAllByRole('button', { expanded: false })[0])
    expect(screen.queryByRole('button', { name: /Promote to skill/ })).not.toBeInTheDocument()
  })
})
