import { ComponentType, lazy } from 'react'

// React.lazy() with one-shot reload recovery from a stale chunk map.
//
// Vite emits content-hashed filenames for code-split routes
// (assets/settings-BNyGoE0G.js). After a deploy, the old chunk names
// no longer exist on the CDN, but the user's already-open tab is
// still pointing at the prior index.html and tries to import the
// dead URL. WebKit / Chrome / Firefox all surface the failure as a
// thrown Error or a TypeError out of the dynamic import — once it
// fires, the route renders blank and there's no automatic recovery.
//
// This wrapper catches the throw, sets a sessionStorage breadcrumb,
// and triggers a single hard reload of the page so the browser
// re-fetches index.html and discovers the new chunk hash. The
// breadcrumb prevents an infinite reload loop in the case where the
// reload itself fails for some unrelated reason (network, CDN
// outage, actual broken chunk in the new build).
//
// We don't bother distinguishing 'ChunkLoadError' by name: every
// browser names it slightly differently (or wraps it in TypeError /
// Failed to fetch dynamically imported module), and a hard reload
// on ANY lazy-import failure is the right move — there's no recover
// path otherwise.

const RELOAD_KEY = 'almyty:chunk-reload-attempted'

// Exported so the recovery logic itself can be unit-tested without
// reaching into React.lazy's internal _payload shape.
export async function importWithRetry<T>(
  importer: () => Promise<T>,
): Promise<T> {
  try {
    const mod = await importer()
    try { sessionStorage.removeItem(RELOAD_KEY) } catch {}
    return mod
  } catch (err) {
    let alreadyReloaded = false
    try { alreadyReloaded = sessionStorage.getItem(RELOAD_KEY) === '1' } catch {}

    if (!alreadyReloaded && typeof window !== 'undefined') {
      try { sessionStorage.setItem(RELOAD_KEY, '1') } catch {}
      window.location.reload()
      // Return a never-resolving promise so React's Suspense keeps
      // the loading state up until the reload completes. Resolving
      // anything (or re-throwing) would briefly flash the error
      // boundary, which looks worse than a blank momentary suspense.
      return new Promise<T>(() => {})
    }
    throw err
  }
}

export function lazyWithRetry<T extends ComponentType<any>>(
  importer: () => Promise<{ default: T }>,
): React.LazyExoticComponent<T> {
  return lazy(() => importWithRetry(importer))
}