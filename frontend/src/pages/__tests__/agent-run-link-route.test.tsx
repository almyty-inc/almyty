/**
 * "Last woke" on the Always on card, each row of What woke it lately and the
 * run id on Approvals link to /agents/:id/runs/:runId. There was no such
 * route, so every one of those links opened "Page not found". The route
 * opens the agent on its Runs tab with that run open.
 */
import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { readFileSync } from 'fs'
import { join } from 'path'
import { act, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider, useParams } from 'react-router-dom'

import { renderWithProviders } from '@/test/setup'
import { RunsTab } from '@/components/agents/detail/runs-tab'
import type { AgentRun } from '@/types'

// setup.tsx stubs the router hooks; the route test below needs the real ones.
vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))
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

  // Last woke sits on the Overview tab of this same page. Following it goes
  // from /agents/:id to /agents/:id/runs/:runId, two routes rendering the same
  // page, so the page is not mounted again and its first-render state stays.
  it('keeps the page mounted across the two routes, so the page follows the link itself', async () => {
    let mounts = 0
    function Page() {
      const [mountedAt] = useState(() => ++mounts)
      const { runId } = useParams()
      return <p>{`mount ${mountedAt} run ${runId ?? 'none'}`}</p>
    }
    const router = createMemoryRouter(
      [
        { path: '/agents/:id', element: <Page /> },
        { path: '/agents/:id/runs/:runId', element: <Page /> },
      ],
      { initialEntries: ['/agents/a1'] },
    )
    render(<RouterProvider router={router} />)
    expect(screen.getByText('mount 1 run none')).toBeInTheDocument()
    await act(() => router.navigate('/agents/a1/runs/r9'))
    expect(screen.getByText('mount 1 run r9')).toBeInTheDocument()

    const page = src('pages/agent-detail.tsx')
    expect(page).toMatch(/useEffect\(\(\) => \{\s*if \(runId\) setActiveTab\('runs'\)\s*\}, \[runId\]\)/)
  })

  it('opens the run a later link names while the Runs tab is showing', () => {
    const runs = [run('run-1'), run('run-2')]
    // One row per run (the open run's detail has expandable parts of its own).
    const expanded = () => Array.from(document.querySelectorAll('tr[aria-expanded]')).map((r) => r.getAttribute('aria-expanded'))
    const { rerender } = renderWithProviders(<RunsTab agentId="agent-1" runs={runs} openRunId="run-1" />)
    expect(expanded()).toEqual(['true', 'false'])
    rerender(<RunsTab agentId="agent-1" runs={runs} openRunId="run-2" />)
    expect(expanded()).toEqual(['false', 'true'])
  })
})
