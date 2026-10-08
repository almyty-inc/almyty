import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'fs'
import { join } from 'path'

import { render } from '../../../../test/setup'
import { CodeStepCard, isCodeStep } from '../code-step'
import { api } from '@/lib/api'

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }))

/**
 * A run_code step in the run view (code mode): a one-line summary, and on
 * request the script with its failing line marked, its log, return value,
 * change set and every call it made.
 */
const step = {
  type: 'tool_call',
  input: { tool: 'run_code', parameters: { code: '...' } },
  output: { codeExecutionId: 'code-1', status: 'waiting_approval', calls: { made: 3, ran: 1, failed: 0, staged: 2, refused: 0 }, cpuMs: 12 },
  duration: 340,
  timestamp: '2026-10-01T10:00:00Z',
}

const trace = {
  id: 'code-1',
  code: "const sold = await petstore.findPetsByStatus({ status: 'sold' })\nlog(sold.length)\nreturn sold.length",
  logs: '3',
  result: 3,
  error: null,
  status: 'waiting_approval',
  cpuMs: 12,
  durationMs: 340,
  changeSet: [
    { id: 1, toolId: 't', toolName: 'petstore_update_pet', codeName: 'petstore.updatePet', title: 'Update a pet', arguments: { id: 1, status: 'archived' }, sideEffect: 'write', reason: 'policy' },
    { id: 2, toolId: 't', toolName: 'petstore_update_pet', codeName: 'petstore.updatePet', title: 'Update a pet', arguments: { id: 3, status: 'archived' }, sideEffect: 'write', reason: 'amount_rule', rule: 'Ask before Update a pet when price is over 500' },
  ],
  calls: [{ id: 'te-1', toolId: 't-find', toolName: 'petstore_find_pets_by_status', parameters: { status: 'sold' }, success: true, executionTime: 20 }],
}

describe('the script step of a run', () => {
  beforeEach(() => vi.clearAllMocks())

  it('is recognised only for a run_code call with a trace', () => {
    expect(isCodeStep(step as any)).toBe(true)
    expect(isCodeStep({ ...step, input: { tool: 'crm_lookup' } } as any)).toBe(false)
    expect(isCodeStep({ ...step, output: { error: 'x' } } as any)).toBe(false)
  })

  it('summarises the calls, and loads the script, its changes and its calls on request', async () => {
    ;(api.get as any).mockResolvedValue({ data: { data: trace } })
    render(<CodeStepCard step={step as any} index={2} agentId="a1" runId="r1" />)
    expect(screen.getByText(/3 calls: 1 ran, 2 waiting for approval/)).toBeInTheDocument()
    expect(api.get).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Show script' }))
    expect(await screen.findByTestId('code-trace')).toBeInTheDocument()
    expect(api.get).toHaveBeenCalledWith('/agents/a1/runs/r1/code-executions/code-1')
    expect(await screen.findByText(/petstore.findPetsByStatus/)).toBeInTheDocument()
    expect(screen.getByTestId('change-set')).toHaveTextContent('petstore.updatePet(id: 3, status: "archived")')
    expect(screen.getByText(/Also needs approval under a rule/)).toBeInTheDocument()
    expect(screen.getByTestId('code-calls')).toHaveTextContent('petstore_find_pets_by_status')
  })

  it('marks the line a failed script stopped on', async () => {
    ;(api.get as any).mockResolvedValue({ data: { data: { ...trace, status: 'failed', error: { message: 'boom', line: 2 }, changeSet: [] } } })
    render(<CodeStepCard step={{ ...step, output: { ...step.output, status: 'failed' } } as any} index={0} agentId="a1" runId="r1" />)
    await userEvent.click(screen.getByRole('button', { name: 'Show script' }))
    expect(await screen.findByText('Line 2: boom')).toBeInTheDocument()
  })

  it('is what the runs tab renders for a script step (guard)', () => {
    const source = readFileSync(join(__dirname, '..', 'runs-tab.tsx'), 'utf8')
    expect(source).toMatch(/if \(isCodeStep\(step\)\) return <CodeStepCard/)
  })
})
