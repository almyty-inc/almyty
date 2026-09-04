import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { RunFailureBanner } from '../run-failure-banner'
import { agentsApi } from '@/lib/api'
import type { Agent, AgentExecution } from '@/types'

vi.mock('@/lib/api', () => ({
  agentsApi: { listRuns: vi.fn() },
}))

const agent = (overrides: Partial<Agent> = {}): Agent =>
  ({ id: 'a1', name: 'Support', mode: 'workflow', settings: {}, ...overrides }) as unknown as Agent

const exec = (status: AgentExecution['status'], error?: string): AgentExecution =>
  ({ id: 'e1', status, error, createdAt: '2026-09-04T10:40:41.000Z' }) as unknown as AgentExecution

const renderIt = (a: Agent, executions: AgentExecution[]) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RunFailureBanner agent={a} executions={executions} />
    </QueryClientProvider>,
  )

describe('RunFailureBanner', () => {
  beforeEach(() => vi.clearAllMocks())

  it('says nothing when the last execution completed', () => {
    renderIt(agent(), [exec('completed'), exec('failed', 'older')])
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows the last failure and its error for a workflow agent', () => {
    renderIt(agent(), [exec('failed', 'LLM call failed: Request failed with status code 429')])
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('The last run failed')
    expect(alert).toHaveTextContent('status code 429')
    expect(agentsApi.listRuns).not.toHaveBeenCalled()
  })

  it('reads the latest run for an autonomous agent', async () => {
    ;(agentsApi.listRuns as any).mockResolvedValue({
      runs: [{ id: 'r1', status: 'failed', error: 'Request failed with status code 429', createdAt: '2026-09-04T10:40:41.000Z' }],
    })
    renderIt(agent({ mode: 'autonomous' }), [])
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('status code 429'))
    expect(agentsApi.listRuns).toHaveBeenCalledWith('a1', { limit: 1 })
  })

  it('calls a timeout a timeout', () => {
    renderIt(agent(), [exec('timeout')])
    expect(screen.getByRole('alert')).toHaveTextContent('timed out')
  })
})
