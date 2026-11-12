/**
 * The Runs tab's badge said "20 runs" for an agent with more: it counted
 * the page the list holds (20 runs, the endpoint's page size), not the
 * total the response gives in `pagination.total`.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'

import { renderWithProviders } from '@/test/setup'
import { pageOf } from '@/lib/api'
import { pluralized } from '@/lib/utils'
import { RunsTab } from '../runs-tab'
import type { AgentRun } from '@/types'

vi.mock('@/store/app', () => ({ useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }))
vi.mock('../route-trace-timeline', () => ({ RouteTraceTimeline: () => null }))
vi.mock('@/hooks/use-live-run', () => ({ useLiveRun: (_a: string, run: AgentRun) => ({ run, connection: 'idle' }) }))

const run = (i: number): AgentRun =>
  ({
    id: `r-${i}`, agentId: 'a-1', status: 'completed', steps: [], input: { message: 'hi' }, output: 'ok',
    totalCost: 0, totalTokens: 0, executionTime: 10, currentStep: 1, maxSteps: 10, toolCallCount: 0,
    createdAt: new Date(Date.UTC(2026, 10, 12, 10, i)).toISOString(), updatedAt: '2026-11-12T10:00:00Z',
  }) as unknown as AgentRun

const page = Array.from({ length: 20 }, (_, i) => run(i))

describe('the Runs tab counts every run, not the page', () => {
  it('reads the total from a paged response', () => {
    expect(pageOf({ success: true, data: page, pagination: { total: 73, page: 1, limit: 20, totalPages: 4 } })).toEqual({ items: page, total: 73 })
    // No pagination: the page is all there is.
    expect(pageOf({ success: true, data: page.slice(0, 3) }).total).toBe(3)
    expect(pageOf(page.slice(0, 2)).total).toBe(2)
  })

  it('shows the total on the badge while it lists the page', () => {
    renderWithProviders(<RunsTab agentId="a-1" runs={page} total={73} />)
    expect(screen.getByText(pluralized(73, 'run'))).toBeTruthy()
    expect(screen.queryByText(pluralized(20, 'run'))).toBeNull()
  })

  it('falls back to the listed runs without a total', () => {
    renderWithProviders(<RunsTab agentId="a-1" runs={page.slice(0, 1)} />)
    expect(screen.getByText(pluralized(1, 'run'))).toBeTruthy()
  })

  it('the agent page reads both lists with their totals and hands the sum to the tab', () => {
    const src = readFileSync(join(__dirname, '../../../../pages/agent-detail.tsx'), 'utf8')
    expect(src).toMatch(/agentsApi\.listRunsPage\(id!\)/)
    expect(src).toMatch(/agentsApi\.getExecutionsPage\(id!/)
    expect(src).toMatch(/const runsTotal = \(runsData\?\.total \?\? runs\.length\) \+ \(executionsData\?\.total \?\? executions\.length\)/)
    expect(src).toMatch(/<RunsTab [^>]*total=\{runsTotal\}/)
  })
})
