import React, { useEffect, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '@/store/auth'
import { authApi } from '@/lib/api'
import { Button } from '@/components/ui/button'

/**
 * CLI login page — used by the @almyty/auth browser-based login flow.
 *
 *   1. The CLI starts a tiny HTTP server on 127.0.0.1:RANDOM and opens
 *      the user's browser to /cli-login?callback=…&state=…
 *   2. This page checks that the callback is on loopback, makes sure
 *      the user is signed in (kicking through /auth/login if not), mints
 *      a DEDICATED API key via POST /auth/api-keys, and POSTs
 *      `{ token, state }` to the callback URL.
 *   3. The local server validates `state` and stores the token.
 *
 * Security:
 * - We REQUIRE `callback` to start with `http://127.0.0.1:` or
 *   `http://localhost:`. Anything else is rejected so this page can't
 *   be tricked into shipping a token to a public URL.
 * - The token travels in a POST body, never in a URL — so it doesn't
 *   land in browser history, server logs, or a reverse-proxy access log.
 * - We never auto-submit. The user clicks "Connect CLI" so the flow
 *   matches the consent expectation set by other CLIs.
 * - The token sent to the CLI is a FRESH API key minted specifically
 *   for this CLI session — NOT the user's browser JWT. The browser
 *   JWT now lives in an httpOnly cookie and is unreadable by JavaScript
 *   (XSS mitigation), so we can't forward it even if we wanted to.
 *   The API key is tied to the caller's identity via the cookie that
 *   authenticates the `POST /auth/api-keys` call, and the user can
 *   revoke it from Settings → API keys at any time.
 */
export function CliLoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { isAuthenticated, user, hasHydrated } = useAuthStore()

  const params = new URLSearchParams(location.search)
  const callback = params.get('callback') || ''
  const success = params.get('success') || ''
  const state = params.get('state') || ''

  const [status, setStatus] = useState<'idle' | 'sending' | 'done' | 'error'>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // Validate the callback URL — must be loopback only.
  const callbackError = (() => {
    if (!callback) return 'Missing required `callback` parameter.'
    if (!state) return 'Missing required `state` parameter.'
    try {
      const u = new URL(callback)
      const isLoopback =
        u.protocol === 'http:' &&
        (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]')
      if (!isLoopback) {
        return `Refusing to send token to a non-loopback callback (${u.origin}).`
      }
      return null
    } catch {
      return 'Callback parameter is not a valid URL.'
    }
  })()

  // Wait for the auth store to hydrate before deciding whether to redirect.
  useEffect(() => {
    if (!hasHydrated) return
    if (callbackError) return
    if (!isAuthenticated) {
      // Punt through the normal login flow, then come back here.
      const returnTo = `${location.pathname}${location.search}`
      navigate(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`, { replace: true })
    }
  }, [hasHydrated, isAuthenticated, callbackError, location.pathname, location.search, navigate])

  const handleConnect = async () => {
    if (!isAuthenticated) {
      setStatus('error')
      setErrorMessage('Not authenticated. Please log in and try again.')
      return
    }
    if (callbackError) {
      setStatus('error')
      setErrorMessage(callbackError)
      return
    }

    setStatus('sending')
    setErrorMessage(null)
    try {
      // Mint a fresh API key for this CLI session via the
      // cookie-authenticated endpoint. The raw key value is only
      // returned in the response to this call — it's never
      // persisted in localStorage and never flows through the URL.
      const hostLabel =
        typeof navigator !== 'undefined' && navigator.platform
          ? ` (${navigator.platform})`
          : ''
      const keyResponse: any = await authApi.createApiKey({
        name: `CLI login${hostLabel} ${new Date().toISOString().slice(0, 10)}`,
      })
      const rawKey: string | undefined =
        keyResponse?.apiKey ?? keyResponse?.data?.apiKey ?? keyResponse
      if (!rawKey || typeof rawKey !== 'string') {
        throw new Error('Backend did not return a new API key')
      }

      const res = await fetch(callback, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: rawKey, state }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Local server replied ${res.status}: ${text || '(no body)'}`)
      }
      setStatus('done')
      // Redirect to the local server's success page so the user gets a
      // friendly confirmation that the connection completed. The success
      // URL was sent by the CLI alongside the callback URL.
      if (success && /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):/i.test(success)) {
        window.location.href = success
      }
    } catch (err: any) {
      setStatus('error')
      setErrorMessage(err?.message ?? String(err))
    }
  }

  if (callbackError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-950 text-zinc-100 p-6">
        <div className="max-w-md w-full bg-zinc-900 border border-zinc-800 rounded-lg p-6">
          <h1 className="text-xl font-semibold text-rose-400 mb-2">Invalid CLI login request</h1>
          <p className="text-sm text-zinc-400 mb-4">{callbackError}</p>
          <p className="text-xs text-zinc-500">
            This page is only meant to be reached by the <code>npx @almyty/auth login</code> CLI flow,
            which constructs the URL with a loopback callback.
          </p>
        </div>
      </div>
    )
  }

  if (!hasHydrated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-950 text-zinc-100">
        <p className="text-sm text-zinc-400">Loading…</p>
      </div>
    )
  }

  if (!isAuthenticated) {
    // The useEffect above will redirect to /auth/login. Render a placeholder
    // in the meantime so the user doesn't see a flash of the connect screen.
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-950 text-zinc-100">
        <p className="text-sm text-zinc-400">Redirecting to sign in…</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950 text-zinc-100 p-6">
      <div className="max-w-md w-full bg-zinc-900 border border-zinc-800 rounded-lg p-6">
        <h1 className="text-xl font-semibold mb-2 bg-gradient-to-r from-violet-400 to-cyan-400 bg-clip-text text-transparent">
          Connect almyty CLI
        </h1>
        <p className="text-sm text-zinc-400 mb-6">
          A local CLI tool is requesting permission to connect to your almyty account.
        </p>

        <dl className="text-xs space-y-2 mb-6 bg-zinc-950 border border-zinc-800 rounded p-3">
          <div className="flex justify-between">
            <dt className="text-zinc-500">Account</dt>
            <dd className="text-zinc-200">{user?.email ?? '—'}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-zinc-500">Callback</dt>
            <dd className="text-zinc-200 truncate ml-4 max-w-[60%]" title={callback}>
              {(() => {
                try {
                  return new URL(callback).origin
                } catch {
                  return callback
                }
              })()}
            </dd>
          </div>
        </dl>

        {status === 'idle' && (
          <Button onClick={handleConnect} className="w-full">
            Connect CLI
          </Button>
        )}
        {status === 'sending' && (
          <Button disabled className="w-full">
            Sending token to local server…
          </Button>
        )}
        {status === 'done' && (
          <div className="text-emerald-400 text-sm text-center py-2">
            ✓ Connected. You can close this tab and return to your terminal.
          </div>
        )}
        {status === 'error' && (
          <div className="space-y-2">
            <div className="text-rose-400 text-sm">Failed: {errorMessage}</div>
            <Button onClick={handleConnect} variant="outline" className="w-full">
              Try again
            </Button>
          </div>
        )}

        <p className="mt-6 text-[10px] text-zinc-600 text-center">
          The token is sent directly from your browser to your local CLI on{' '}
          <code>127.0.0.1</code>. It never leaves your machine.
        </p>
      </div>
    </div>
  )
}

export default CliLoginPage
