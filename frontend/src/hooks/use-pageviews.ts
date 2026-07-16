/* usePageviews — capture a PostHog $pageview on every client-side
 * route change.
 *
 * PostHog's built-in capture_pageview only fires on the initial hard
 * page load. In a react-router SPA, subsequent navigations swap the
 * view without a full reload, so no further pageviews are recorded and
 * the funnel looks like every user visits exactly one page. We disable
 * the automatic pageview at init (see lib/analytics.ts) and instead
 * fire one manually here whenever the location changes. PostHog emits
 * the matching $pageleave automatically.
 *
 * Mount ONCE, under the Router (so useLocation resolves). It renders
 * nothing. Safe no-op when analytics is disabled — capturePageview
 * short-circuits when there is no client.
 *
 * Usage (in App, inside <BrowserRouter>):
 *   usePageviews()
 */
import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

import { capturePageview } from '@/lib/analytics'

export function usePageviews(): void {
  const location = useLocation()

  useEffect(() => {
    // Include search + hash so tab-scoped routes (e.g.
    // /tools?tab=hub) register as distinct pageviews.
    capturePageview(location.pathname + location.search + location.hash)
  }, [location.pathname, location.search, location.hash])
}
