/**
 * A run whose tool could not run because its hosted machine failed to
 * start says so on the step, in a sentence, with the machine's own error
 * behind "Details" -- not a bare "workspace_unavailable" line, and never a
 * token.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'

import { renderWithProviders } from '@/test/setup'
import { RunsTab } from '../runs-tab'
import type { AgentRun } from '@/types'

vi.mock('@/lib/api', () => ({ promotedSkillsApi: { promote: vi.fn() } }))
vi.mock('@/store/app', () => ({ useNotifications: () => ({ success: vi.fn(), error: vi.fn() }) }))

const RUN: AgentRun = {
  id: 'run-1',
  agentId: 'agent-1',
  organizationId: 'org-1',
  mode: 'autonomous',
  status: 'failed',
  error: "The hosted machine for this run couldn't start: Can't reach the cluster: its certificate isn't trusted.",
  thread: [],
  workingMemory: {},
  currentStep: 1,
  maxSteps: 20,
  totalCost: 0,
  totalTokens: 0,
  executionTime: 1200,
  createdAt: '2026-10-21T10:00:00Z',
  updatedAt: '2026-10-21T10:00:02Z',
  steps: [
    {
      type: 'tool_call',
      timestamp: '2026-10-21T10:00:01Z',
      input: { tool: 'env.app.shell.exec', parameters: { command: 'ls' } },
      output: {
        machineError: {
          summary: "Can't reach the cluster: its certificate isn't trusted",
          detail: 'x509: certificate signed by unknown authority (Bearer abc.def.ghi)',
        },
      },
      error: 'workspace_unavailable: The machine for this environment did not start within 180 seconds',
      duration: 4,
    },
  ],
} as AgentRun

describe('a run step whose hosted machine could not start', () => {
  it('names the machine problem with the raw error behind Details', () => {
    renderWithProviders(<RunsTab runs={[RUN]} agentId="agent-1" />)
    fireEvent.click(screen.getByText('failed'))
    const step = screen.getByTestId('run-step-0')
    expect(step).toHaveTextContent("Can't reach the cluster: its certificate isn't trusted")
    expect(screen.getByTestId('run-step-0-machine-detail')).toHaveTextContent('x509')
    expect(screen.getByTestId('run-step-0-machine-detail')).not.toHaveTextContent('abc.def.ghi')
    expect(step).not.toHaveTextContent('Error: workspace_unavailable')
  })
})
