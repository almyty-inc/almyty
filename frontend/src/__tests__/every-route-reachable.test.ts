import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')

/**
 * A page with a route and no way in is a page nobody visits.
 *
 * /workspaces was built, routed, tested, and listed in neither the
 * sidebar nor the command palette -- the only way to it was to type the
 * URL, or to land on one from a runner. The runner fleet's whole
 * execution surface was effectively invisible.
 *
 * The bar here is "a user can get there without knowing the URL": a
 * sidebar entry or a palette entry, either is enough. Detail routes
 * (:id) are reached from their list page, and auth routes from logged
 * out, so both are out of scope.
 */
describe('every dashboard route has a way in', () => {
  const routes = [...read('App.tsx').matchAll(/<Route path="([^"]+)"/g)]
    .map(m => m[1])
    .filter(p => !p.includes(':') && !p.includes('*'))
    .filter(p => p.startsWith('/'))

  // The sidebar, the palette, and the header chrome that is on every
  // page -- the three places a user can reach a page from without
  // already being somewhere specific.
  const linked =
    read('components/layout/dashboard-layout.tsx') +
    read('components/command-palette.tsx') +
    read('components/notifications/notification-bell.tsx')

  // Reached from logged-out, from a redirect, or from inside a flow
  // rather than from navigation.
  const NOT_NAVIGATION = new Set([
    '/', '/login', '/register', '/forgot-password', '/reset-password',
    '/verify-email', '/accept-invite', '/oauth/callback',
    // Redirects, not destinations.
    '/llm-providers', '/llm-providers/new', '/models/new', '/connections',
    // Entered by following a link or a CLI prompt from outside the app.
    '/invite/accept', '/cli-login', '/oauth/consent',
  ])

  it('is listed in the sidebar or the command palette', () => {
    const unreachable = routes
      .filter(p => !NOT_NAVIGATION.has(p))
      .filter(p => !new RegExp(`['"]${p}(\\?[^'"]*)?['"]`).test(linked))

    expect(unreachable).toEqual([])
  })
})
