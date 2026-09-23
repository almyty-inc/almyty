/**
 * `?returnTo=` on a create page sends the user back where they came from.
 * Only a path on this origin is honoured: an absolute URL, a
 * protocol-relative `//host`, a backslash trick or anything that resolves
 * to another origin is dropped, so the parameter can never become an open
 * redirect.
 */
export function safeReturnTo(raw: string | null | undefined, origin: string = window.location.origin): string | null {
  if (!raw) return null
  const value = raw.trim()
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null
  try {
    const url = new URL(value, origin)
    if (url.origin !== origin) return null
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return null
  }
}

/** The path to come back to from here, for a `returnTo` parameter. */
export function currentReturnPath(): string {
  if (typeof window === 'undefined') return '/'
  return `${window.location.pathname}${window.location.search}`
}
