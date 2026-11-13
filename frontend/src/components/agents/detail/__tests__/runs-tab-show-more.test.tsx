/**
 * The Runs badge said 34 runs and the table showed 20, with no way to see
 * the rest. "Show more" reads the next page of each list the API pages.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'

import { renderWithProviders } from '@/test/setup'
import { pluralized } from '@/lib/utils'
import type { AgentExecution, AgentRun } from '@/types'

const listRunsPage = vi.fn()
const getExecutionsPage = vi.fn()
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, agentsApi: { ...actual.agentsApi, listRunsPage: (...a: unknown[]) => listRunsPage(...a), getExecutionsPage: (...a: unknown[]) => getExecutionsPage(...a) } }
})
vi.mock('@/store/app', () => ({ useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }))
vi.mock('../route-trace-timeline', () => ({ RouteTraceTimeline: () => null }))
vi.mock('@/hooks/use-live-run', () => ({ useLiveRun: (_a: string, run: AgentRun) => ({ run, connection: 'idle' }) }))

import { RUNS_PAGE_SIZE, RunsTab, visibleRows } from '../runs-tab'

/** Run i was created i minutes before 12:00, so run 0 is the newest. */
const at = (i: number) => new Date(Date.UTC(2026, 10, 12, 12, 0) - i * 60_000).toISOString()
const run = (i: number): AgentRun =>
  ({
    id: `r-${i}`, agentId: 'a-1', status: 'completed', steps: [], input: { message: `run ${i}` }, output: 'ok',
    totalCost: 0, totalTokens: 0, executionTime: 10, currentStep: 1, maxSteps: 10, toolCallCount: 0,
    createdAt: at(i), updatedAt: at(i),
  }) as unknown as AgentRun
const exec = (i: number): AgentExecution =>
  ({ id: `e-${i}`, agentId: 'a-1', status: 'completed', nodeResults: {}, input: {}, totalCost: 0, totalTokens: 0, executionTime: 1, createdAt: at(i) }) as unknown as AgentExecution

const rowsShown = (container: HTMLElement) => container.querySelectorAll('tbody tr[role="button"]').length

beforeEach(() => {
  listRunsPage.mockReset()
  getExecutionsPage.mockReset()
})

describe('the Runs tab shows every run, a page at a time', () => {
  const all = Array.from({ length: 34 }, (_, i) => run(i))

  it('says how many it shows of the total and reads the next page on "Show more"', async () => {
    listRunsPage.mockResolvedValue({ items: all.slice(20), total: 34 })
    const { container } = renderWithProviders(<RunsTab agentId="a-1" runs={all.slice(0, 20)} total={34} runsTotal={34} executionsTotal={0} />)
    expect(screen.getByText(pluralized(34, 'run'))).toBeTruthy()
    expect(rowsShown(container)).toBe(20)
    expect(screen.getByTestId('runs-show-more').textContent).toContain(`Showing 20 of ${pluralized(34, 'run')}`)

    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    await waitFor(() => expect(rowsShown(container)).toBe(34))
    expect(listRunsPage).toHaveBeenCalledWith('a-1', { page: 2, limit: RUNS_PAGE_SIZE })
    expect(getExecutionsPage).not.toHaveBeenCalled()
    expect(screen.queryByTestId('runs-show-more')).toBeNull()
  })

  it('offers no "Show more" when the page holds every run', () => {
    renderWithProviders(<RunsTab agentId="a-1" runs={all.slice(0, 3)} total={3} runsTotal={3} executionsTotal={0} />)
    expect(screen.queryByTestId('runs-show-more')).toBeNull()
  })

  it('says so when the next page could not be read, and tries again', async () => {
    listRunsPage.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce({ items: all.slice(20), total: 34 })
    const { container } = renderWithProviders(<RunsTab agentId="a-1" runs={all.slice(0, 20)} total={34} runsTotal={34} executionsTotal={0} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    await screen.findByRole('button', { name: 'Try again' })
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(rowsShown(container)).toBe(34))
  })

  it('never shows a run ahead of a newer one from the other list it has not read yet', () => {
    // Runs 0..3 read, more runs to come; workflow runs 10 and 11 read, none to come.
    const shown = visibleRows([run(0), run(1), run(2), run(3)], [exec(10), exec(11)], { runs: true, executions: false })
    expect(shown.map((r) => r.id)).toEqual(['r-0', 'r-1', 'r-2', 'r-3'])
    const done = visibleRows([run(0), run(1)], [exec(10), exec(11)], { runs: false, executions: false })
    expect(done.map((r) => r.id)).toEqual(['r-0', 'r-1', 'e-10', 'e-11'])
  })
})
