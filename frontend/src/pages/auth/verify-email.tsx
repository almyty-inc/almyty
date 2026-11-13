import React, { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { CheckCircle2, XCircle } from 'lucide-react'

import { authApi } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { NEW_LINK_SENT } from '@/components/auth/check-email'

type State = 'verifying' | 'success' | 'error'

/**
 * Landing page for the email-verification link (`/auth/verify-email?token=`).
 * The verification email points here; the page reads the token, calls the
 * backend, and shows the outcome. Renders whether or not the user is logged
 * in (the token is self-authenticating), so it must live in the public
 * `/auth/*` route group — a missing route here previously fell through to the
 * login redirect, which is the bug this fixes.
 *
 * Signing in needs a confirmed address, so success leads to sign-in, and a
 * link that no longer works offers a new one right here: the person cannot
 * sign in to ask for it.
 */
export function VerifyEmailPage() {
  const [params] = useSearchParams()
  const token = params.get('token') || ''
  const [state, setState] = useState<State>('verifying')

  useEffect(() => {
    if (!token) {
      setState('error')
      return
    }
    let cancelled = false
    authApi
      .verifyEmail(token)
      .then(() => {
        if (!cancelled) setState('success')
      })
      .catch(() => {
        // The server says "Invalid verification token" for an expired,
        // reused or mangled link alike; the page says it in plain words.
        if (!cancelled) setState('error')
      })
    return () => {
      cancelled = true
    }
  }, [token])

  return (
    <div className="text-center space-y-4">
      {state === 'verifying' && (
        <div className="flex flex-col items-center gap-3 py-6" role="status" aria-label="Verifying email">
          <LoadingSpinner size="lg" />
          <p className="text-sm text-muted-foreground">Confirming your email…</p>
        </div>
      )}

      {state === 'success' && (
        <div className="flex flex-col items-center gap-3 py-4">
          <CheckCircle2 className="h-10 w-10 text-emerald-500" aria-hidden />
          <h2 className="text-lg font-heading font-medium">Email confirmed</h2>
          <p className="text-sm text-muted-foreground">
            Thanks, your email address is confirmed. Sign in to get started.
          </p>
          <Button asChild className="mt-2">
            <Link to="/auth/login">Sign in</Link>
          </Button>
        </div>
      )}

      {state === 'error' && <LinkDidNotWork />}
    </div>
  )
}

function LinkDidNotWork() {
  const [email, setEmail] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)

  const sendNewLink = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!email.trim()) return
    setSending(true)
    try {
      await authApi.resendVerificationByEmail(email.trim())
    } catch {
      // Same neutral line either way: nothing here says whether the
      // address has an account.
    } finally {
      setSent(true)
      setSending(false)
    }
  }

  return (
    <div className="flex flex-col items-center gap-3 py-4">
      <XCircle className="h-10 w-10 text-red-500" aria-hidden />
      <h2 className="text-lg font-heading font-medium">This link didn&apos;t work</h2>
      <p className="text-sm text-muted-foreground">
        It may have expired, been used already, or been cut short when it was copied. Enter your
        email address and we&apos;ll send you a new one.
      </p>

      {sent ? (
        <div role="status" className="w-full p-3 bg-muted border border-border rounded-md text-left">
          <p className="text-sm text-muted-foreground">
            {NEW_LINK_SENT}
          </p>
        </div>
      ) : (
        <form onSubmit={sendNewLink} className="w-full space-y-3 text-left">
          <div>
            <Label htmlFor="verify-email-address">Email address</Label>
            <Input
              id="verify-email-address"
              type="email"
              autoComplete="email"
              placeholder="name@example.com"
              className="mt-1"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </div>
          <Button type="submit" className="w-full" disabled={sending || !email.trim()} aria-disabled={sending}>
            {sending ? 'Sending…' : 'Send a new link'}
          </Button>
        </form>
      )}

      <Link to="/auth/login" className="text-sm font-medium text-primary hover:text-primary/80">
        Back to sign in
      </Link>
    </div>
  )
}