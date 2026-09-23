/* renderAtRoute -- mount a page under a real data router, the way main.tsx
 * does, so a test can assert where a create page navigates after save.
 *
 * setup.tsx stubs useNavigate/useParams/useLocation for every suite; a
 * test file that uses this helper must undo that first:
 *
 *   vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))
 *
 * Every path in `paths` other than the page's own renders a marker
 * (`<p>at /the/path</p>`), so `await screen.findByText('at /credentials')`
 * proves the navigation happened.
 */
import type { ReactElement } from 'react'
import { render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router-dom'

function Marker() {
  const location = useLocation()
  return <p>at {location.pathname}</p>
}

export function renderAtRoute(
  element: ReactElement,
  {
    path,
    url = path,
    paths = [],
    from,
  }: {
    /** The route pattern the page is mounted at (`/credentials/new`). */
    path: string
    /** The URL to open (defaults to `path`). */
    url?: string
    /** Other routes the page may navigate to; each renders a marker. */
    paths?: string[]
    /** A history entry before the page, so Back has somewhere to go. */
    from?: string
  },
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const router = createMemoryRouter(
    [
      { path, element },
      ...paths.filter((p) => p !== path).map((p) => ({ path: p, element: <Marker /> })),
      { path: '*', element: <Marker /> },
    ],
    { initialEntries: from ? [from, url] : [url], initialIndex: from ? 1 : 0 },
  )
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { ...utils, router, queryClient }
}
