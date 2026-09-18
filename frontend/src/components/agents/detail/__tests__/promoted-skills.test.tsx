import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '../../../../test/setup'
import { PromotedSkillsTab } from '../promoted-skills-tab'
import { PromoteRunDialog } from '../promote-run-dialog'
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
})

describe('PromoteRunDialog', () => {
  it('renders a promote trigger', () => {
    renderWithProviders(<PromoteRunDialog runId="run-1" />)
    expect(screen.getByRole('button', { name: /Promote to skill/ })).toBeInTheDocument()
  })
})
