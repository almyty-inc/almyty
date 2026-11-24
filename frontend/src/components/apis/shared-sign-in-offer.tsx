/**
 * One sign-in for several APIs of the same provider (Google Calendar,
 * Gmail and Tasks from one Google OAuth client). When the org already has
 * a sign-in with this API's provider, the API's sign-in spot offers it:
 * used as it is when it holds every permission ticked here, or extended
 * with one more consent (only the added permissions) when it does not.
 * Inline, no dialog; the regular sign-in stays right below it.
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { apisApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import type { ApiKeyView, SharedSignIn } from '@/types/api-connect'

interface SharedSignInOfferProps {
  apiId: string
  /** Where the API signs in (its description's authorization URL). */
  authorizationUrl: string
  /** The permissions ticked for this API. */
  scopes: string[]
  /** Where the consent comes back to. */
  returnTo: string
  disabled?: boolean
  onSaved: (view: ApiKeyView) => void
  onRedirect: (url: string) => void
  onError: (message: string) => void
}

/** "Google" for Google's sign-in page, else the host. */
export function providerName(authorizationUrl: string): string {
  try {
    const host = new URL(authorizationUrl).hostname
    return host === 'accounts.google.com' ? 'Google' : host
  } catch {
    return 'provider'
  }
}

/** The account when the sign-in knows it (an email), else its name. */
function whose(signIn: SharedSignIn): string {
  return signIn.accountLabel && signIn.accountLabel.includes('@') ? signIn.accountLabel : signIn.name
}

/** A scope URL in a few words: its last path segment. */
function shortScope(scope: string): string {
  const parts = scope.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? scope
}

export function SharedSignInOffer({ apiId, authorizationUrl, scopes, returnTo, disabled, onSaved, onRedirect, onError }: SharedSignInOfferProps) {
  const query = useQuery({ queryKey: ['api-shared-sign-ins', apiId], queryFn: () => apisApi.sharedSignIns(apiId) })
  const use = useMutation({
    mutationFn: (credentialId: string) => apisApi.useSharedSignIn(apiId, credentialId, { scopes, returnTo }),
    onSuccess: (result) => {
      if (result.authorizationUrl) onRedirect(result.authorizationUrl)
      else if (result.key) onSaved(result.key)
    },
    onError: (err) => onError(getApiErrorMessage(err, 'The existing sign-in could not be used.')),
  })

  const provider = providerName(authorizationUrl)
  const offers = (query.data ?? [])
    .map((signIn) => ({ signIn, missing: scopes.filter((s) => !signIn.grantedScopes.includes(s)) }))
    .filter(({ signIn, missing }) => missing.length === 0 || signIn.canAddAccess)
  if (offers.length === 0) return null

  return (
    <div className="space-y-2 rounded-md border p-3" data-testid="api-shared-sign-ins">
      <p className="text-sm text-muted-foreground">
        Your organization already signed in with {provider} for another API. The same sign-in can cover this one too.
      </p>
      {offers.map(({ signIn, missing }) => (
        <div key={signIn.id} className="space-y-1">
          <Button
            type="button"
            variant="outline"
            onClick={() => use.mutate(signIn.id)}
            disabled={disabled || use.isPending}
          >
            {use.isPending && use.variables === signIn.id && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
            {missing.length === 0
              ? `Use your existing ${provider} sign-in (${whose(signIn)})`
              : `Add access to the existing ${provider} sign-in (${whose(signIn)})`}
          </Button>
          {missing.length > 0 && (
            <p className="text-xs text-muted-foreground">
              One more {provider} consent adds: <span className="font-mono">{missing.map(shortScope).join(', ')}</span>. Nothing else changes.
            </p>
          )}
        </div>
      ))}
    </div>
  )
}
