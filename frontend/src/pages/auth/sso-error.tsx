import { useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { ShieldAlert } from 'lucide-react'

import { Button } from '@/components/ui/button'

/**
 * Where a refused or broken single sign-on lands (the API redirects here
 * with `?reason=<code>`), in place of a raw JSON error in the browser. Only
 * the code travels; the words are this page's own.
 */
export const SSO_FAILURE_MESSAGES: Record<string, { title: string; body: string }> = {
  deactivated: {
    title: 'Your access has been turned off',
    body: "Your account in this organization was deactivated, so single sign-on can't sign you in. If you think this is a mistake, ask an admin of the organization to reactivate you.",
  },
  not_member: {
    title: "You're not a member of this organization",
    body: 'Your identity provider vouched for you, but this address has no membership in the organization. Ask an admin to invite you, then accept the invitation.',
  },
  invite_pending: {
    title: 'Accept your invitation first',
    body: 'You have an invitation to this organization that has not been accepted yet. Open the invitation email, accept it, and then use single sign-on.',
  },
  no_account: {
    title: 'No account for this identity',
    body: "This organization doesn't create accounts on first sign-in. Ask an admin to invite you.",
  },
  domain_unverified: {
    title: "Your address isn't on a verified domain",
    body: "Accounts are only created for addresses on a domain the organization has verified. Ask an admin to verify the domain or to invite you.",
  },
  expired: {
    title: 'That sign-in expired',
    body: 'Single sign-on took too long or was opened in another browser. Start again from the sign-in page.',
  },
  not_enabled: {
    title: "Single sign-on isn't set up",
    body: "This organization's single sign-on is switched off or not fully configured. Sign in with your password, or ask an admin.",
  },
  not_entitled: {
    title: "Single sign-on isn't available",
    body: "This organization's plan doesn't include single sign-on. Sign in with your password, or ask an admin.",
  },
  failed: {
    title: "Single sign-on didn't complete",
    body: 'Something went wrong between us and your identity provider. Try again; if it keeps happening, ask an admin.',
  },
}

export function SsoErrorPage() {
  const location = useLocation()
  const reason = new URLSearchParams(location.search).get('reason') ?? 'failed'
  const message = SSO_FAILURE_MESSAGES[reason] ?? SSO_FAILURE_MESSAGES.failed

  useEffect(() => {
    document.title = 'Sign-in problem | almyty'
    return () => {
      document.title = 'almyty'
    }
  }, [])

  return (
    <div data-testid="sso-error">
      <div className="mb-4 flex items-center gap-2 text-destructive">
        <ShieldAlert className="h-5 w-5" aria-hidden />
        <span className="text-sm font-medium">Single sign-on</span>
      </div>
      <h1 className="mb-2 text-2xl font-heading font-bold">{message.title}</h1>
      <p className="mb-6 text-sm text-muted-foreground">{message.body}</p>
      <Button asChild className="w-full">
        <Link to="/auth/login">Back to sign in</Link>
      </Button>
    </div>
  )
}
