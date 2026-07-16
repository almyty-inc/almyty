import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useNavigate } from 'react-router-dom'

import { usePageviews } from '../use-pageviews'

// The global test setup (src/test/setup.tsx) stubs react-router-dom's
// useLocation to a fixed '/'. This hook's whole job is to react to
// location changes, so restore the REAL router hooks for this file.
vi.mock('react-router-dom', async (importOriginal) => await importOriginal())

// Mock the analytics wrapper so we assert on capturePageview directly
// without booting posthog-js.
const capturePageview = vi.fn()
vi.mock('@/lib/analytics', () => ({
  capturePageview: (...args: unknown[]) => capturePageview(...args),
}))

// Harness: mounts the hook and exposes a button that navigates
// client-side, so we can prove pageviews fire on route changes.
function Harness() {
  usePageviews()
  const navigate = useNavigate()
  return (
    <button type="button" onClick={() => navigate('/tools/42?tab=hub')}>
      go
    </button>
  )
}

beforeEach(() => {
  capturePageview.mockClear()
})

describe('usePageviews', () => {
  it('captures a pageview for the initial route (path + search)', () => {
    render(
      <MemoryRouter initialEntries={['/agents?tab=runs']}>
        <Harness />
      </MemoryRouter>,
    )
    expect(capturePageview).toHaveBeenCalledTimes(1)
    expect(capturePageview).toHaveBeenCalledWith('/agents?tab=runs')
  })

  it('fires again on a client-side route change', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Harness />
      </MemoryRouter>,
    )
    expect(capturePageview).toHaveBeenNthCalledWith(1, '/dashboard')

    await user.click(screen.getByRole('button', { name: 'go' }))

    // The pageview fires from a passive effect after the router state
    // update flushes, so wait for it rather than asserting synchronously.
    await waitFor(() => expect(capturePageview).toHaveBeenCalledTimes(2))
    expect(capturePageview).toHaveBeenNthCalledWith(2, '/tools/42?tab=hub')
  })

  it('does not re-capture when the location is unchanged on re-render', () => {
    const tree = (
      <MemoryRouter initialEntries={['/settings']}>
        <Harness />
      </MemoryRouter>
    )
    const { rerender } = render(tree)
    // Re-render the SAME element (no navigation) — the effect deps
    // (path/search/hash) are unchanged, so no extra pageview fires.
    rerender(tree)
    expect(capturePageview).toHaveBeenCalledTimes(1)
    expect(capturePageview).toHaveBeenCalledWith('/settings')
  })
})
