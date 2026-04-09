/* useCreateDeepLink — read `?new=1` from the URL, open a local
 * dialog once, strip the param so a refresh or a back-navigation
 * doesn't re-open it.
 *
 * Wired to the command palette's "Create X" actions: each palette
 * entry navigates to `/{page}?new=1`, and the destination page
 * calls this hook to honour the intent.
 *
 * Usage:
 *   const [isCreateOpen, setIsCreateOpen] = useState(false)
 *   useCreateDeepLink(setIsCreateOpen)
 */
import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'

export function useCreateDeepLink(setOpen: (open: boolean) => void) {
  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setOpen(true)
      // Strip the param so navigating away + back or refreshing
      // doesn't keep reopening the dialog. Replace, don't push,
      // so the browser back button still returns to the previous
      // page rather than to the same page without the param.
      const next = new URLSearchParams(searchParams)
      next.delete('new')
      setSearchParams(next, { replace: true })
    }
    // We intentionally depend on searchParams only — setOpen /
    // setSearchParams are stable function references from React.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])
}
