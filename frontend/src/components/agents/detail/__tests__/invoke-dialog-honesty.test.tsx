import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'

import { render } from '../../../../test/setup'
import { InvokeDialog } from '../invoke-dialog'
import { agentsApi } from '@/lib/api'

vi.mock('@/lib/api', () => ({ agentsApi: { invoke: vi.fn() } }))

const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
vi.mock('@/store/app', () => ({ useNotifications: () => notify }))

/**
 * A run that finishes is not a run that worked.
 *
 * The invoke endpoint answers 200 with `status: 'failed'` and an `error`
 * string in the body, so the mutation's onSuccess fires for failures
 * too. It raised "Execution completed." over them and printed the whole
 * execution row -- agentId, organizationId, userId, nulls -- as the
 * "Result", so a failed run looked like a successful one whose answer
 * happened to be a wall of JSON.
 */
describe('the invoke dialog reports what actually happened', () => {
  const agent = { id: 'a1', name: 'Support bot' } as any

  beforeEach(() => vi.clearAllMocks())

  it('does not congratulate you on a run that failed', async () => {
    ;(agentsApi.invoke as any).mockResolvedValue({
      id: 'run-1',
      status: 'failed',
      output: null,
      error: 'Role "principal" could not be filled: no models are registered.',
    })

    render(<InvokeDialog agent={agent} open onOpenChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /run agent/i }))

    await waitFor(() => expect(notify.error).toHaveBeenCalled())
    expect(notify.success).not.toHaveBeenCalled()
    expect(notify.error.mock.calls[0][1]).toMatch(/could not be filled/)
  })

  it('shows the failure reason instead of a JSON dump', async () => {
    ;(agentsApi.invoke as any).mockResolvedValue({
      id: 'run-1',
      organizationId: 'afca07ae-secret',
      status: 'failed',
      output: null,
      error: 'No models are registered for this organization.',
    })

    render(<InvokeDialog agent={agent} open onOpenChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /run agent/i }))

    expect(await screen.findByTestId('invoke-failed')).toHaveTextContent('No models are registered')
  })

  it('shows the output, not the execution row, when the run worked', async () => {
    ;(agentsApi.invoke as any).mockResolvedValue({
      id: 'run-1',
      organizationId: 'afca07ae-secret',
      status: 'completed',
      output: 'Hello, I can help with that.',
    })

    render(<InvokeDialog agent={agent} open onOpenChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /run agent/i }))

    await waitFor(() => expect(notify.success).toHaveBeenCalled())
    expect(await screen.findByTestId('invoke-output-text')).toHaveTextContent('Hello, I can help with that')
    // The full record is still reachable, just not presented as the answer.
    expect(screen.getByText(/Full execution record/i)).toBeInTheDocument()
  })

  it('says so when a run completes having produced nothing', async () => {
    ;(agentsApi.invoke as any).mockResolvedValue({ id: 'run-1', status: 'completed', output: null })

    render(<InvokeDialog agent={agent} open onOpenChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /run agent/i }))

    expect(await screen.findByTestId('invoke-no-output')).toBeInTheDocument()
  })
})
