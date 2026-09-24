/* Assertions for useLeaveGuard on a component mounted with renderAtRoute.
 *
 * A dirty form asks before a navigation leaves it; a clean one leaves
 * without asking. Both go through the real data router, so they exercise
 * the same blocker main.tsx mounts. A test file using these must undo the
 * router stub in setup.tsx first:
 *
 *   vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))
 *
 *   const { router } = renderAtRoute(<MyForm />, { path: '/here' })
 *   await expectLeaveAsks(router)            // dirty
 *   await expectLeavesWithoutAsking(router)  // clean
 */
import { act, screen, waitFor } from '@testing-library/react'
import { expect } from 'vitest'

import { LEAVE_TITLE } from '@/hooks/use-leave-guard'

interface TestRouter {
  navigate: (to: string) => Promise<void>
  state: { location: { pathname: string } }
}

/** Try to leave; expect the discard confirm and to stay put. */
export async function expectLeaveAsks(router: TestRouter, to = '/elsewhere') {
  const from = router.state.location.pathname
  await act(async () => {
    await router.navigate(to)
  })
  expect(await screen.findByText(LEAVE_TITLE)).toBeInTheDocument()
  expect(router.state.location.pathname).toBe(from)
}

/** Try to leave; expect to arrive without being asked. */
export async function expectLeavesWithoutAsking(router: TestRouter, to = '/elsewhere') {
  await act(async () => {
    await router.navigate(to)
  })
  await waitFor(() => expect(router.state.location.pathname).toBe(to))
  expect(screen.queryByText(LEAVE_TITLE)).not.toBeInTheDocument()
}
