import { readFileSync } from 'fs'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({ agentsApi: { invoke: vi.fn(), getRun: vi.fn() } }))

import { agentsApi } from '@/lib/api'
import { invokeAndSettle, runOutcome } from '../agent-run'

const invoke = vi.mocked(agentsApi.invoke)
const getRun = vi.mocked(agentsApi.getRun)
const noWait = () => Promise.resolve()

describe('invokeAndSettle', () => {
  beforeEach(() => {
    invoke.mockReset()
    getRun.mockReset()
  })

  it('waits for an autonomous run, which invoke answers while it is still running', async () => {
    invoke.mockResolvedValue({ id: 'run-1', mode: 'autonomous', status: 'running', output: null })
    getRun
      .mockResolvedValueOnce({ id: 'run-1', mode: 'autonomous', status: 'running', output: null })
      .mockResolvedValueOnce({ id: 'run-1', mode: 'autonomous', status: 'completed', output: 'It is sunny in Lisbon.' })

    const run = await invokeAndSettle('agent-1', { message: 'weather?' }, { wait: noWait })

    expect(getRun).toHaveBeenCalledWith('agent-1', 'run-1')
    expect(run.status).toBe('completed')
    expect(runOutcome(run)).toEqual({ output: 'It is sunny in Lisbon.' })
  })

  it('returns a workflow execution as invoke answered it', async () => {
    invoke.mockResolvedValue({ id: 'exec-1', status: 'completed', output: { answer: 42 } })
    const run = await invokeAndSettle('agent-1', {}, { wait: noWait })
    expect(getRun).not.toHaveBeenCalled()
    expect(run.output).toEqual({ answer: 42 })
  })

  it('stops at a run that waits for someone, and says so', async () => {
    invoke.mockResolvedValue({ id: 'run-1', mode: 'autonomous', status: 'running' })
    getRun.mockResolvedValue({ id: 'run-1', mode: 'autonomous', status: 'waiting_approval' })
    const run = await invokeAndSettle('agent-1', {}, { wait: noWait })
    expect(runOutcome(run).error).toBe('Waiting for your approval. Open Approvals to decide; the run carries on once you do.')
  })

  it('a workflow run waiting for approval says how many changes, in plain words', () => {
    const outcome = runOutcome({ status: 'waiting_approval', error: 'Waiting for your approval: 3 changes.' })
    expect(outcome.error).toBe('Waiting for your approval: 3 changes. Open Approvals to decide; the run carries on once you do.')
    expect(outcome.error).not.toMatch(/run_code|approvalId/)
  })

  it('a run waiting for input still points at the Runs tab', () => {
    expect(runOutcome({ status: 'waiting_input' }).error).toMatch(/waiting for someone/)
  })

  it('gives a failed run its reason, not its JSON', () => {
    expect(runOutcome({ status: 'failed', error: 'Model not found' })).toEqual({ error: 'Model not found' })
  })

  it('is what the Try it box and the Run panel run an agent with', () => {
    for (const file of ['overview-tab.tsx', 'run-panel.tsx']) {
      const source = readFileSync(join(__dirname, '../../components/agents/detail', file), 'utf8')
      expect(source, file).toContain('invokeAndSettle(agent.id')
      expect(source, file).not.toMatch(/agentsApi\.invoke\(/)
    }
  })
})
