/**
 * The Runs list printed each run's input as JSON: `{"message":"Sites: ...`.
 * It shows the text the run was asked instead.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'

import { renderWithProviders } from '@/test/setup'
import { runInputPreview } from '@/lib/run-input'
import { RunsTab } from '../runs-tab'
import type { AgentExecution, AgentRun } from '@/types'

vi.mock('@/store/app', () => ({ useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }))
vi.mock('../route-trace-timeline', () => ({ RouteTraceTimeline: () => null }))
vi.mock('@/hooks/use-live-run', () => ({ useLiveRun: (_a: string, run: AgentRun) => ({ run, connection: 'idle' }) }))

const run = {
  id: 'r-1', agentId: 'a-1', status: 'completed', steps: [], input: { message: 'Sites: Berlin warehouse' }, output: 'ok',
  totalCost: 0, totalTokens: 0, executionTime: 10, currentStep: 1, maxSteps: 10, toolCallCount: 0,
  createdAt: '2026-11-12T10:00:00Z', updatedAt: '2026-11-12T10:00:00Z',
} as unknown as AgentRun

const exec = {
  id: 'e-1', agentId: 'a-1', status: 'completed', input: { city: 'Lyon', days: 3 }, nodeResults: {},
  totalCost: 0, totalTokens: 0, executionTime: 10, createdAt: '2026-11-12T09:00:00Z',
} as unknown as AgentExecution

describe('the Runs list shows what a run was asked, not JSON', () => {
  it('shows the message of an autonomous run and the fields of a workflow run', () => {
    renderWithProviders(<RunsTab agentId="a-1" runs={[run]} executions={[exec]} />)
    expect(screen.getByText('Sites: Berlin warehouse')).toBeTruthy()
    expect(screen.getByText('city: Lyon · days: 3')).toBeTruthy()
    expect(document.body.textContent).not.toContain('{"')
  })

  it('reads the usual keys, collapses whitespace and shortens long text', () => {
    expect(runInputPreview({ message: 'hello\n  there' })).toBe('hello there')
    expect(runInputPreview({ prompt: 'p' })).toBe('p')
    expect(runInputPreview('plain')).toBe('plain')
    expect(runInputPreview(null)).toBe('--')
    expect(runInputPreview({})).toBe('--')
    expect(runInputPreview({ message: 'x'.repeat(200) }, 10)).toBe(`${'x'.repeat(9)}…`)
  })
})
