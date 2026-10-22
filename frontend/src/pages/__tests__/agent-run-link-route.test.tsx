/**
 * "Last woke" on the Always on card, each row of What woke it lately and the
 * run id on Approvals link to /agents/:id/runs/:runId. There was no such
 * route, so every one of those links opened "Page not found". The route
 * opens the agent on its Runs tab with that run open.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { screen } from '@testing-library/react'

import { renderWithProviders } from '@/test/setup'
import { RunsTab } from '@/components/agents/detail/runs-tab'
import type { AgentRun } from '@/types'

vi.mock('@/lib/api', () => ({ promotedSkillsApi: { promote: vi.fn() }, api: { get: vi.fn() } }))
vi.mock('@/store/app', () => ({ useNotifications: () => ({ success: vi.fn(), error: vi.fn() }) }))

const src = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf8')

function run(id: string): AgentRun {
  return {
    id, agentId: 'agent-1', organizationId: 'org-1', mode: 'autonomous', status: 'completed',
    thread: [], workingMemory: {}, steps: [], currentStep: 1, maxSteps: 20, totalCost: 0, totalTokens: 0,
    executionTime: 100, createdAt: '2026-10-22T10:00:00Z', updatedAt: '2026-10-22T10:00:01Z',
  }
}

describe('links to one run', () => {
  it('has a route for /agents/:id/runs/:runId, served by the agent page', () => {
    expect(src('App.tsx')).toMatch(/<Route path="\/agents\/:id\/runs\/:runId" element=\{<AgentDetailPage \/>\} \/>/)
  })

  it('opens the Runs tab and hands the run to it', () => {
    const page = src('pages/agent-detail.tsx')
    expect(page).toMatch(/const \{ id, runId \} = useParams/)
    expect(page).toMatch(/searchParams\.get\('tab'\) \|\| \(runId \? 'runs' : 'overview'\)/)
    expect(page).toMatch(/<RunsTab runs=\{runs\} agentId=\{agent\.id\} openRunId=\{runId\} \/>/)
  })

  it('shows the linked run open, and none without a link', () => {
    const { unmount } = renderWithProviders(<RunsTab agentId="agent-1" runs={[run('run-1'), run('run-2')]} openRunId="run-2" />)
    expect(screen.getAllByRole('button', { expanded: true })).toHaveLength(1)
    unmount()
    renderWithProviders(<RunsTab agentId="agent-1" runs={[run('run-1'), run('run-2')]} />)
    expect(screen.queryAllByRole('button', { expanded: true })).toHaveLength(0)
  })
})
