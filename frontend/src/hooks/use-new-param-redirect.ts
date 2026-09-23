/* useNewParamRedirect -- `?new=1` on a list page now means "go to the
 * create page".
 *
 * Create flows used to be dialogs that a list page opened when it saw
 * `?new=1` (a hook since deleted). They are pages now, with their own route,
 * and every in-app entry point links there directly. This keeps any
 * `?new=1` link that still exists -- a bookmark, a doc, an email --
 * landing on the create page instead of on a list that ignores it. The
 * redirect replaces the history entry, so Back returns to where the user
 * came from rather than bouncing through the list.
 */
import { useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

export function useNewParamRedirect(createPath: string) {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const wantsNew = searchParams.get('new') === '1'
  useEffect(() => {
    if (wantsNew) navigate(createPath, { replace: true })
  }, [wantsNew, createPath, navigate])
}
