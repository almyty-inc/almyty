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

/**
 * Where the login page may send the user after signing in: a path on this
 * origin, or the one kind of API URL that bounces through login, the MCP
 * OAuth `/authorize` endpoint of a gateway. Any other API URL is refused:
 * the API has routes that redirect onward (an organization's SSO login goes
 * to whatever IdP that organization configured), so "anything on the API
 * origin" was an open redirect one hop removed.
 */
export function loginReturnTo(
  raw: string | null | undefined,
  apiBase: string | null | undefined,
  origin: string = window.location.origin,
): string | null {
  const local = safeReturnTo(raw, origin)
  if (local) return local
  if (!raw || !apiBase) return null
  try {
    const url = new URL(raw)
    const api = new URL(apiBase)
    if (url.origin !== api.origin) return null
    if (url.username || url.password) return null
    // The API may sit under a path prefix (`/api` behind a shared host).
    const prefix = api.pathname.replace(/\/+$/, '')
    if (prefix && !url.pathname.startsWith(`${prefix}/`)) return null
    const path = url.pathname.slice(prefix.length)
    if (!/^\/[^/]+\/[^/]+\/authorize\/?$/.test(path)) return null
    return url.toString()
  } catch {
    return null
  }
}

/** The path to come back to from here, for a `returnTo` parameter. */
export function currentReturnPath(): string {
  if (typeof window === 'undefined') return '/'
  return `${window.location.pathname}${window.location.search}`
}
