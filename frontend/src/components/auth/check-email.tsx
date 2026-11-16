import React from 'react'
import { Link } from 'react-router-dom'
import { MailCheck } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { authApi } from '@/lib/api'

/** After "Send a new link": neutral, so it never says whether an account exists. */
export const NEW_LINK_SENT =
  'If that address is waiting to be confirmed, a new link is on its way. It can take a minute; check your spam folder too.'
interface CheckEmailProps {
  /** The address the confirmation link went to. */
  email: string
  heading?: string
  /** What happened, above the "we sent a link" line. */
  lead?: React.ReactNode
  /** Where "Sign in" goes once the address is confirmed. */
  signInTo?: string
  /** Shown instead of the sign-in link when the caller has its own way back. */
  onBack?: () => void
}

/**
 * "Check your email": the page after sign-up, and after a sign-in refused
 * because the address is not confirmed yet. One action, send a new link,
 * and a way to sign in once the link has been opened.
 *
 * The resend answers the same whether or not the address has an account
 * waiting, so the confirmation stays neutral.
 */
export function CheckEmail({
  email,
  heading = 'Check your email',
  lead,
  signInTo = '/auth/login',
  onBack,
}: CheckEmailProps) {
  const [sending, setSending] = React.useState(false)
  const [sent, setSent] = React.useState(false)

  const sendNewLink = async () => {
    setSending(true)
    try {
      await authApi.resendVerificationByEmail(email)
    } catch {
      // Same neutral line either way: nothing here says whether the
      // address has an account.
    } finally {
      setSent(true)
      setSending(false)
    }
  }

  return (
    <div>
      <div className="flex justify-center mb-4">
        <MailCheck className="h-10 w-10 text-violet-500" aria-hidden />
      </div>
      <h1 className="text-2xl font-heading font-bold mb-2 text-center">{heading}</h1>
      {lead && <p className="text-sm text-muted-foreground mb-2 text-center">{lead}</p>}
      <p className="text-sm text-muted-foreground mb-6 text-center">
        We sent a link to <span className="font-medium text-foreground">{email}</span>. Open it to
        confirm your address, then sign in.
      </p>

      {sent ? (
        <div role="status" className="mb-4 p-3 bg-muted border border-border rounded-md">
          <p className="text-sm text-muted-foreground">
            {NEW_LINK_SENT}
          </p>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={sendNewLink}
          disabled={sending}
          aria-disabled={sending}
        >
          {sending ? 'Sending…' : 'Send a new link'}
        </Button>
      )}

      <div className="mt-6 text-center">
        {onBack ? (
          <button
            type="button"
            className="text-sm font-medium text-primary hover:text-primary/80"
            onClick={onBack}
          >
            Back to sign in
          </button>
        ) : (
          <p className="text-sm text-muted-foreground">
            Already confirmed?{' '}
            <Link to={signInTo} className="font-medium text-primary hover:text-primary/80">
              Sign in
            </Link>
          </p>
        )}
      </div>
    </div>
  )
}
