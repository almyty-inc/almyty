import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '../../../test/setup'
import { useSeedSampleWorkspace } from '../getting-started-card'
import { onboardingApi } from '@/lib/api'

/**
 * "Load sample workspace" failed silently, on every screen that offers it.
 *
 * The seed 400s -- it always did, because it put draft tools on a gateway
 * -- and this mutation had no onError at all, so the only thing a user
 * saw was the button's label going from "Loading…" back to "Load sample
 * workspace". The same hook backs the dashboard card and the empty states
 * of /agents, /tools and /apis: one missing handler, four dead buttons.
 */

vi.mock('@/lib/api', () => ({
  onboardingApi: { seedSample: vi.fn(), get: vi.fn() },
}))

const notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('@/store/app', () => ({ useNotifications: () => notify }))

vi.mock('@/lib/analytics', () => ({ captureEvent: vi.fn() }))

function Probe() {
  const seed = useSeedSampleWorkspace('org-1')
  return (
    <button onClick={() => seed.mutate()}>
      {seed.isPending ? 'Loading…' : 'Load sample workspace'}
    </button>
  )
}

describe('the sample workspace button reports what happened', () => {
  beforeEach(() => vi.clearAllMocks())

  it('says so when the seed is refused', async () => {
    vi.mocked(onboardingApi.seedSample).mockRejectedValue({
      response: { status: 400, data: { message: "Tool 'listPets' is draft." } },
    })

    const user = userEvent.setup()
    render(<Probe />)
    await user.click(screen.getByRole('button'))

    await waitFor(() => expect(notify.error).toHaveBeenCalled())
    expect(notify.error.mock.calls[0][0]).toBe("Couldn't load the sample workspace")
    expect(notify.error.mock.calls[0][1]).toMatch(/draft/)
    expect(notify.success).not.toHaveBeenCalled()
  })

  it('confirms a successful seed', async () => {
    vi.mocked(onboardingApi.seedSample).mockResolvedValue({ created: true } as any)

    const user = userEvent.setup()
    render(<Probe />)
    await user.click(screen.getByRole('button'))

    await waitFor(() => expect(notify.success).toHaveBeenCalled())
    expect(notify.success.mock.calls[0][0]).toBe('Sample workspace loaded')
    expect(notify.error).not.toHaveBeenCalled()
  })

  it('does not pretend a second run built anything', async () => {
    vi.mocked(onboardingApi.seedSample).mockResolvedValue({ created: false } as any)

    const user = userEvent.setup()
    render(<Probe />)
    await user.click(screen.getByRole('button'))

    await waitFor(() => expect(notify.success).toHaveBeenCalled())
    expect(notify.success.mock.calls[0][0]).toBe('Sample workspace already loaded')
  })
})
