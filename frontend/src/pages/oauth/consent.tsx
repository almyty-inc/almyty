import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ShieldCheck } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '@/components/ui/card'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { apiGet, apiPost } from '@/lib/api'

interface ConsentInfo {
  clientName: string
  gatewayName: string
  scopes: string[]
}

// Friendly descriptions for the scopes we issue. Unknown scopes fall back
// to the raw value so a new scope is never silently hidden from the user.
const SCOPE_LABELS: Record<string, string> = {
  'mcp:*': 'Full access to this gateway’s MCP tools and resources',
  'mcp:tools': 'Call this gateway’s tools',
  'mcp:resources': 'Read this gateway’s resources',
}

/**
 * OAuth 2.1 consent screen for the MCP authorization-code flow.
 *
 * The backend authorize endpoint redirects an authenticated user here
 * instead of silently issuing a code. We validate the request server-side
 * (GET .../oauth-consent), show the client + requested scopes, and only
 * issue a code after the user explicitly approves (POST .../authorize).
 */
export function OAuthConsentPage() {
  const [params] = useSearchParams()

  const org = params.get('org') || ''
  const gateway = params.get('gateway') || ''
  const clientId = params.get('client_id') || ''
  const redirectUri = params.get('redirect_uri') || ''
  const scope = params.get('scope') || ''
  const state = params.get('state') || ''
  const responseType = params.get('response_type') || 'code'
  const codeChallenge = params.get('code_challenge') || ''
  const codeChallengeMethod = params.get('code_challenge_method') || ''

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<ConsentInfo | null>(null)
  const [submitting, setSubmitting] = useState(false)
  // Kept apart from `error`: a rejected approval must leave the consent UI
  // (scopes + Approve/Deny) on screen so the user can retry or deny.
  const [submitError, setSubmitError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      if (!org || !gateway || !clientId || !redirectUri) {
        setError('This authorization request is missing required parameters.')
        setLoading(false)
        return
      }
      try {
        const data = await apiGet<ConsentInfo>(
          `/${encodeURIComponent(org)}/${encodeURIComponent(gateway)}/oauth-consent`,
          { params: { client_id: clientId, redirect_uri: redirectUri, scope } },
        )
        if (!cancelled) {
          setInfo(data)
          setLoading(false)
        }
      } catch (err: any) {
        if (cancelled) return
        const status = err?.response?.status
        if (status === 401) {
          // Not logged in — bounce through login and come straight back.
          const returnTo = window.location.pathname + window.location.search
          window.location.href = `/auth/login?returnTo=${encodeURIComponent(returnTo)}`
          return
        }
        setError(
          err?.response?.data?.error_description ||
            'This authorization request could not be validated.',
        )
        setLoading(false)
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [org, gateway, clientId, redirectUri, scope])

  // Build a redirect back to the client, preserving `state`. Used for both
  // the approved (code) and denied (error) outcomes. Returns false when the
  // client's redirect URI is unusable so the caller can re-enable the buttons.
  function redirectToClient(extra: Record<string, string>): boolean {
    let url: URL
    try {
      url = new URL(redirectUri)
    } catch {
      setSubmitError('The client supplied an invalid redirect URI.')
      setSubmitting(false)
      return false
    }
    // Only http(s) is a place to send the browser. Anything else --
    // `javascript://localhost/...` parses fine and has host localhost --
    // would run as script in this origin when assigned to location.href.
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      setSubmitError('The client supplied an invalid redirect URI.')
      setSubmitting(false)
      return false
    }
    for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v)
    if (state) url.searchParams.set('state', state)
    window.location.href = url.toString()
    return true
  }

  async function approve() {
    setSubmitting(true)
    setSubmitError(null)
    try {
      const res = await apiPost<{ code: string }>(
        `/${encodeURIComponent(org)}/${encodeURIComponent(gateway)}/authorize`,
        {
          response_type: responseType,
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          code_challenge_method: codeChallengeMethod,
          scope,
          state,
        },
      )
      redirectToClient({ code: res.code })
    } catch (err: any) {
      setSubmitting(false)
      // A failed approval is recoverable, so it must not land in `error`:
      // that flag hides the scopes and both buttons, which would strand the
      // user and leave the MCP client waiting on a redirect forever.
      setSubmitError(
        err?.response?.data?.error_description ||
          'Authorization failed. Please try again.',
      )
    }
  }

  function deny() {
    redirectToClient({ error: 'access_denied' })
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-2 flex h-11 w-11 items-center justify-center rounded-lg bg-violet-600/10 text-violet-600">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <CardTitle>Authorize access</CardTitle>
          <CardDescription>
            {info
              ? `${info.clientName} is requesting access to ${info.gatewayName}.`
              : 'Review this authorization request.'}
          </CardDescription>
        </CardHeader>

        <CardContent>
          {loading && (
            <div className="flex items-center gap-3 py-6 text-sm text-muted-foreground">
              <LoadingSpinner /> Validating request…
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
            >
              {error}
            </div>
          )}

          {info && !error && (
            <div className="space-y-3">
              {/*
                A rejected approval (expired PKCE, revoked client, any 5xx) is
                recoverable: it is reported through `submitError`, never through
                the fatal `error` that gates this block and the footer below.
                Folding the two together used to strip the scope list AND both
                buttons, leaving "Please try again." with nothing to try and the
                MCP client hanging on a redirect that never carried access_denied.
              */}
              {submitError && (
                <div
                  role="alert"
                  className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
                >
                  {submitError}
                </div>
              )}
              <p className="text-sm font-medium text-foreground">
                This will allow it to:
              </p>
              <ul className="space-y-2">
                {info.scopes.map((s) => (
                  <li key={s} className="flex items-start gap-2 text-sm text-muted-foreground">
                    <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-violet-600" />
                    <span>{SCOPE_LABELS[s] || s}</span>
                  </li>
                ))}
              </ul>
              <p className="pt-1 text-xs text-muted-foreground">
                You can revoke this access at any time from your gateway settings.
              </p>
            </div>
          )}
        </CardContent>

        {info && !error && (
          <CardFooter className="flex gap-3">
            <Button variant="outline" className="flex-1" onClick={deny} disabled={submitting}>
              Deny
            </Button>
            <Button className="flex-1" onClick={approve} disabled={submitting}>
              {submitting ? 'Authorizing…' : submitError ? 'Try again' : 'Approve'}
            </Button>
          </CardFooter>
        )}
      </Card>
    </div>
  )
}
