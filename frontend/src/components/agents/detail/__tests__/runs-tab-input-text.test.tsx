/**
 * The Runs list printed each run's input as JSON: `{"message":"Sites: ...`.
 * It shows the text the run was asked instead.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'

import { renderWithProviders } from '@/test/setup'
import { runInputPreview, stepInputPreview } from '@/lib/run-input'
import { RunsTab } from '../runs-tab'
import { stepNameOf } from '../../step-values'
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

  it('names an opened run\'s steps in words and its tool inputs without ids or JSON', () => {
    const opened = {
      ...run,
      steps: [{
        type: 'tool_call', timestamp: 't0', duration: 10,
        input: { tool: 'open_meteo_forecast', toolId: '801a7c5b-c506-4afc-b064-d7d56931a544', parameters: { latitude: '62.03', longitude: '129.73' } },
        output: 'sunny',
      }],
    } as unknown as AgentRun
    renderWithProviders(<RunsTab agentId="a-1" runs={[opened]} openRunId="r-1" />)
    const step = screen.getByTestId('run-step-0')
    expect(step).toHaveTextContent('Tool call')
    expect(step).not.toHaveTextContent('tool_call')
    expect(step).toHaveTextContent('In: open_meteo_forecast (latitude: 62.03 · longitude: 129.73)')
    expect(step).not.toHaveTextContent('801a7c5b')
    expect(stepInputPreview({ message: 'hi' })).toBe('hi')
  })

  it('names a workflow run\'s steps by type, not by their ids', () => {
    expect(stepNameOf(undefined, 'input_1')).toBe('Input')
    expect(stepNameOf(undefined, 'llm_1')).toBe('Model call')
    expect(stepNameOf(undefined, 'verify_1794417938_3')).toBe('Verify')
    expect(stepNameOf('tool_call', 'anything')).toBe('Tool call')
    expect(stepNameOf(undefined, 'my-custom-node')).toBe('my-custom-node')
    const opened = { ...exec, nodeResults: { input_1: { output: { message: 'hi' } }, llm_1: { output: 'done' } } } as unknown as AgentExecution
    renderWithProviders(<RunsTab agentId="a-1" runs={[]} executions={[opened]} openRunId="e-1" />)
    expect(screen.getByTestId('execution-step-0')).toHaveTextContent('Input')
    expect(screen.getByTestId('execution-step-0')).not.toHaveTextContent('input_1')
    expect(screen.getByTestId('execution-step-1')).toHaveTextContent('Model call')
  })
})