/* useLeaveGuard -- keep a half-filled form from being lost by accident.
 *
 * Create and configure flows are pages, not dialogs, so "close" is a
 * navigation: the back button, a sidebar link, Cancel, a refresh. A dirty
 * form asks once before any of those throws the work away.
 *
 *   const guard = useLeaveGuard(form.formState.isDirty)
 *   // after a successful save, leave without being asked:
 *   onSuccess: (g) => guard.leave(`/gateways/${g.id}`)
 *   <FormPage guard={guard} ...>
 *
 * In-app navigation is caught with react-router's `useBlocker`, which only
 * exists under a data router (main.tsx mounts one). Under a plain
 * <MemoryRouter> -- most unit tests -- the blocker is not mounted, and
 * Cancel asks through the guarded `navigate` below instead.
 *
 * A router honours only its most recently mounted blocker, so the blocker
 * is mounted only while the form is dirty. A page can then carry several
 * inline forms (a detail page with an add-role form and a run panel) and a
 * clean one mounted later never masks a dirty one mounted earlier.
 *
 * Inline forms that close in place (Cancel collapses the form rather than
 * navigating) just pass their dirty state and render `guard.element`; a
 * cancelled or saved form is clean again, so leaving never asks.
 *
 * A delete that leaves the page navigates with `LEAVE_WITHOUT_ASKING`:
 * its confirm already asked, and the edits died with the item.
 *
 * `allowPrefix` lets a multi-step flow move between its own step routes
 * (`/apis/new/schema` -> `/apis/new/review`) without asking.
 */
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import {
  UNSAFE_DataRouterContext,
  useBlocker,
  useNavigate,
  type NavigateOptions,
  type To,
} from 'react-router-dom'

import { useConfirm } from '@/components/ui/confirm-dialog'

export interface LeaveGuard {
  /** True while the form holds unsaved changes. */
  dirty: boolean
  /** Navigate without asking (after a successful save). */
  leave: (to: To, options?: NavigateOptions) => void
  /** Navigate the way a user would: asks first when dirty. */
  navigate: (to: To, options?: NavigateOptions) => void
  /** Render once inside the page (FormPage does this for you). */
  element: ReactNode
}

export interface LeaveGuardOptions {
  /** Navigations whose pathname starts with this never ask. */
  allowPrefix?: string
}

export const LEAVE_TITLE = 'Discard unsaved changes?'

/**
 * Navigation state for a move the user has already confirmed, such as
 * leaving a page whose item they just deleted. Every leave guard on the
 * page lets it through: the delete confirm was the one question, and
 * asking "Discard unsaved changes?" about edits to an item that no longer
 * exists would be a second prompt for the same decision.
 *
 *   navigate('/models', { state: LEAVE_WITHOUT_ASKING })
 */
export const LEAVE_WITHOUT_ASKING = { leaveGuard: 'skip' } as const

function confirmedElsewhere(state: unknown): boolean {
  return !!state && typeof state === 'object' && (state as { leaveGuard?: unknown }).leaveGuard === 'skip'
}
const LEAVE_OPTIONS = {
  title: LEAVE_TITLE,
  description: 'You have changes on this page that have not been saved.',
  confirmLabel: 'Discard changes',
  cancelLabel: 'Keep editing',
  destructive: true,
}

function Blocker({
  shouldBlock,
  onBlocked,
}: {
  shouldBlock: (nextPath: string) => boolean
  onBlocked: (proceed: () => void, reset: () => void) => void
}) {
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      currentLocation.pathname !== nextLocation.pathname &&
      !confirmedElsewhere(nextLocation.state) &&
      shouldBlock(nextLocation.pathname),
  )
  useEffect(() => {
    if (blocker.state === 'blocked') {
      onBlocked(
        () => blocker.proceed?.(),
        () => blocker.reset?.(),
      )
    }
  }, [blocker, onBlocked])
  return null
}

export function useLeaveGuard(dirty: boolean, options: LeaveGuardOptions = {}): LeaveGuard {
  const navigate = useNavigate()
  const inDataRouter = useContext(UNSAFE_DataRouterContext) != null
  const { confirm, dialog } = useConfirm()
  const bypass = useRef(false)
  const dirtyRef = useRef(dirty)
  // Synced after commit, not during render; every reader runs in an event
  // or navigation handler, which always comes after the layout effect.
  useLayoutEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])
  const { allowPrefix } = options

  // A refresh or a closed tab cannot be intercepted in-app; the browser's
  // own prompt is the only option there.
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (bypass.current) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  const shouldBlock = useCallback(
    (nextPath: string) => {
      if (bypass.current || !dirtyRef.current) return false
      if (allowPrefix && nextPath.startsWith(allowPrefix)) return false
      return true
    },
    [allowPrefix],
  )

  const onBlocked = useCallback(
    async (proceed: () => void, reset: () => void) => {
      if (await confirm(LEAVE_OPTIONS)) proceed()
      else reset()
    },
    [confirm],
  )

  const leave = useCallback(
    (to: To, navOptions?: NavigateOptions) => {
      bypass.current = true
      navigate(to, navOptions)
    },
    [navigate],
  )

  const guardedNavigate = useCallback(
    async (to: To, navOptions?: NavigateOptions) => {
      // Under a data router the blocker asks; without one, ask here.
      if (!inDataRouter && dirtyRef.current && !bypass.current && !confirmedElsewhere(navOptions?.state)) {
        if (!(await confirm(LEAVE_OPTIONS))) return
        bypass.current = true
      }
      navigate(to, navOptions)
    },
    [confirm, inDataRouter, navigate],
  )

  const element = (
    <>
      {inDataRouter && dirty && <Blocker shouldBlock={shouldBlock} onBlocked={onBlocked} />}
      {dialog}
    </>
  )

  return { dirty, leave, navigate: guardedNavigate, element }
}
