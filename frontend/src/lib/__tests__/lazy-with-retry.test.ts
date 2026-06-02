import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { importWithRetry } from '../lazy-with-retry'

// On a Vite frontend deploy, content-hashed chunks rotate filenames
// and the cached index.html in an open tab still references the old
// ones. The dynamic import throws, the lazy boundary catches it, and
// the route renders blank with no recovery. This guard wraps the
// importer with a one-shot hard reload — the breadcrumb in
// sessionStorage prevents an infinite reload loop if the failure
// repeats after the reload.

const RELOAD_KEY = 'almyty:chunk-reload-attempted'

describe('importWithRetry', () => {
  let reloadSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    sessionStorage.clear()
    reloadSpy = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload: reloadSpy },
    })
  })

  afterEach(() => {
    sessionStorage.clear()
  })

  it('does NOT reload on a successful import and clears any stale breadcrumb', async () => {
    sessionStorage.setItem(RELOAD_KEY, '1')
    const importer = vi.fn().mockResolvedValue({ default: () => null })

    const result = await importWithRetry(importer as any)

    expect(result).toEqual({ default: expect.any(Function) })
    expect(reloadSpy).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(RELOAD_KEY)).toBeNull()
  })

  it('triggers location.reload() on the first failure and writes the breadcrumb', async () => {
    const importer = vi.fn().mockRejectedValue(new TypeError('Failed to fetch dynamically imported module'))

    // The call returns a never-resolving promise so Suspense holds
    // the loading state until the actual page reload finishes.
    const pending = importWithRetry(importer as any)

    // Give the microtask queue a chance to drain past the await.
    await new Promise((r) => setTimeout(r, 0))

    expect(reloadSpy).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem(RELOAD_KEY)).toBe('1')

    // Sanity: the returned promise has not settled.
    let settled = false
    pending.then(() => { settled = true }, () => { settled = true })
    await new Promise((r) => setTimeout(r, 0))
    expect(settled).toBe(false)
  })

  it('does NOT reload twice — second failure rethrows so the error boundary takes over', async () => {
    sessionStorage.setItem(RELOAD_KEY, '1')
    const err = new TypeError('Failed to fetch dynamically imported module')
    const importer = vi.fn().mockRejectedValue(err)

    await expect(importWithRetry(importer as any)).rejects.toBe(err)
    expect(reloadSpy).not.toHaveBeenCalled()
  })
})