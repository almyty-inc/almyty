import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { MailWarning, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { authApi } from '@/lib/api'
import { useAuthStore } from '@/store/auth'

/**
 * Slim dismissible banner shown while the signed-in user's email is
 * unverified.
 *
 * Guard: only renders when the backend explicitly says
 * `emailVerified === false`. If the field is absent/undefined (the
 * backend hasn't shipped it yet, or an older session payload), we
 * treat the address as verified and stay silent — no nagging
 * existing sessions.
 */
export function EmailVerificationBanner() {
  const user = useAuthStore((state) => state.user)
  const [dismissed, setDismissed] = useState(false)

  const resend = useMutation({
    mutationFn: () => authApi.resendVerification(),
  })

  const needsVerification = (user as { emailVerified?: boolean } | null)?.emailVerified === false
  if (!needsVerification || dismissed) return null

  return (
    <div
      role="status"
      className="flex items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-sm"
    >
      <MailWarning className="h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-foreground">
        Verify your email - check your inbox
      </span>
      {resend.isError && (
        <span className="text-xs text-red-500">Failed to send, try again</span>
      )}
      {resend.isSuccess ? (
        <span className="text-xs text-muted-foreground">Verification email sent</span>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => resend.mutate()}
          disabled={resend.isPending}
        >
          {resend.isPending ? 'Sending...' : 'Resend'}
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-muted-foreground hover:text-foreground"
        aria-label="Dismiss"
        onClick={() => setDismissed(true)}
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  )
}
