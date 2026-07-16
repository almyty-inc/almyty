import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { CheckCircle2, XCircle } from 'lucide-react'

import { authApi } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/ui/loading-spinner'

type State = 'verifying' | 'success' | 'error'

/**
 * Landing page for the email-verification link (`/auth/verify-email?token=`).
 * The verification email points here; the page reads the token, calls the
 * backend, and shows the outcome. Renders whether or not the user is logged
 * in (the token is self-authenticating), so it must live in the public
 * `/auth/*` route group — a missing route here previously fell through to the
 * login redirect, which is the bug this fixes.
 */
export function VerifyEmailPage() {
  const [params] = useSearchParams()
  const token = params.get('token') || ''
  const [state, setState] = useState<State>('verifying')
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!token) {
      setState('error')
      setMessage('This verification link is missing its token.')
      return
    }
    let cancelled = false
    authApi
      .verifyEmail(token)
      .then(() => {
        if (!cancelled) setState('success')
      })
      .catch((err: any) => {
        if (cancelled) return
        setState('error')
        setMessage(
          err?.response?.data?.message ||
            'This verification link is invalid or has expired. Request a new one from your account.',
        )
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
          <p className="text-sm text-muted-foreground">Verifying your email…</p>
        </div>
      )}

      {state === 'success' && (
        <div className="flex flex-col items-center gap-3 py-4">
          <CheckCircle2 className="h-10 w-10 text-emerald-500" aria-hidden />
          <h2 className="text-lg font-heading font-medium">Email verified</h2>
          <p className="text-sm text-muted-foreground">
            Your email is confirmed. You're all set.
          </p>
          <Button asChild className="mt-2">
            <Link to="/dashboard">Go to dashboard</Link>
          </Button>
        </div>
      )}

      {state === 'error' && (
        <div className="flex flex-col items-center gap-3 py-4">
          <XCircle className="h-10 w-10 text-red-500" aria-hidden />
          <h2 className="text-lg font-heading font-medium">Verification failed</h2>
          <p className="text-sm text-muted-foreground">{message}</p>
          <Button asChild variant="outline" className="mt-2">
            <Link to="/dashboard">Back to app</Link>
          </Button>
        </div>
      )}
    </div>
  )
}
