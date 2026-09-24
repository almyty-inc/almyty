import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { QueryClient } from '@tanstack/react-query'

import { render } from '../../../../test/setup'
import { RunPanel } from '../run-panel'
import { agentsApi } from '@/lib/api'

// The run-failure banner at the top of the agent page reads
// ['agent-latest-run', agent.id] with a 15s staleTime. The run panel
// invalidated four other keys but not that one, so a run that had just
// failed here did not raise the banner until the stale window passed.

vi.mock('@/lib/api', () => ({ agentsApi: { invoke: vi.fn() } }))
vi.mock('@/store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}))

describe('invoking an agent refreshes the run-failure banner', () => {
  const agent = { id: 'a1', name: 'Support bot' } as any
  let queryClient: QueryClient

  beforeEach(() => {
    vi.clearAllMocks()
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
  })

  it('invalidates the latest-run key the banner reads', async () => {
    ;(agentsApi.invoke as any).mockResolvedValue({
      id: 'run-1',
      status: 'failed',
      output: null,
      error: 'No models are registered for this organization.',
    })
    // Seeded, not mounted, so nothing refetches it out from under the
    // assertion.
    queryClient.setQueryData(['agent-latest-run', 'a1'], [{ id: 'run-0', status: 'completed' }])

    render(<RunPanel agent={agent} onClose={() => {}} />, { queryClient })
    fireEvent.click(screen.getByRole('button', { name: /run agent/i }))

    await waitFor(() => expect(agentsApi.invoke).toHaveBeenCalled())
    await waitFor(() =>
      expect(
        queryClient.getQueryState(['agent-latest-run', 'a1'])?.isInvalidated,
      ).toBe(true),
    )
  })
})
