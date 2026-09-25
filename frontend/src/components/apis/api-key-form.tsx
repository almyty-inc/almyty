/**
 * The key an API's tools send: paste it, or connect an account instead.
 * How it is sent (the header, bearer, basic, OAuth 2.0) comes from the
 * API's description and is a one-line "Change" away. Same shape as
 * connecting a model provider: the key, then "or Connect an account".
 *
 * Used on "Finish connecting" (/apis/:id/setup) and by the API page's
 * Key card.
 */
import { useEffect, useState, type FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SecretInput } from '@/components/ui/secret-input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ConnectAccountButton } from '@/components/connections/connect-sheet'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { apisApi, credentialsApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import type { ApiKeyType, ApiKeyView } from '@/types/api-connect'

/** How a key is sent, in words. */
export function keySentAs(view: Pick<ApiKeyView, 'type' | 'headerName' | 'location'>): string {
  switch (view.type) {
    case 'api_key':
      return view.location === 'query'
        ? `Sent as the ${view.headerName || 'api_key'} query parameter`
        : `Sent in the ${view.headerName || 'X-API-Key'} header`
    case 'bearer':
      return 'Sent as a bearer token'
    case 'basic':
      return 'Sent as a username and password (basic auth)'
    case 'oauth2':
      return 'Sent as an OAuth 2.0 token'
    default:
      return 'Called without a key'
  }
}

const SENT_OPTIONS: Array<{ value: Exclude<ApiKeyType, 'none' | 'oauth2'>; label: string }> = [
  { value: 'api_key', label: 'In a header' },
  { value: 'bearer', label: 'As a bearer token' },
  { value: 'basic', label: 'As a username and password' },
]

interface ApiKeyFormProps {
  apiId: string
  apiName: string
  view: ApiKeyView
  onSaved: (view: ApiKeyView) => void
  onCancel?: () => void
  /** Where an OAuth 2.0 sign-in comes back to. */
  returnTo: string
  submitLabel?: string
}

export function ApiKeyForm({ apiId, apiName, view, onSaved, onCancel, returnTo, submitLabel = 'Save key' }: ApiKeyFormProps) {
  const [type, setType] = useState<ApiKeyType>(view.type === 'none' ? 'api_key' : view.type)
  const [key, setKey] = useState('')
  const [username, setUsername] = useState('')
  const [headerName, setHeaderName] = useState(view.headerName ?? 'X-API-Key')
  const [location, setLocation] = useState<'header' | 'query'>(view.location ?? 'header')
  const [changing, setChanging] = useState(view.type === 'none')
  const [pasteToken, setPasteToken] = useState(false)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [error, setError] = useState<string | null>(null)

  const oauth = type === 'oauth2' && view.oauth2?.tokenUrl && !pasteToken ? view.oauth2 : null
  // Set when an OAuth sign-in sends the browser to the provider.
  const [redirectTo, setRedirectTo] = useState<string | null>(null)
  // A half-typed key asks before a navigation throws it away (not the
  // sign-in's own redirect, which is the point).
  const guard = useLeaveGuard(!redirectTo && !!(key || username || clientId || clientSecret))
  useEffect(() => {
    if (redirectTo) window.location.assign(redirectTo)
  }, [redirectTo])

  const save = useMutation({
    mutationFn: (body: Parameters<typeof apisApi.setKey>[1]) => apisApi.setKey(apiId, body),
    onSuccess: (next) => {
      setKey('')
      setError(null)
      onSaved(next)
    },
    onError: (err) => setError(getApiErrorMessage(err, 'The key was not saved.')),
  })

  const signIn = useMutation({
    mutationFn: async () => {
      const base = { apiId, clientId: clientId.trim(), clientSecret: clientSecret.trim(), tokenUrl: oauth!.tokenUrl!, scopes: oauth!.scopes, credentialName: `${apiName} sign-in` }
      if (oauth!.flow === 'client_credentials' || !oauth!.authorizationUrl) {
        await credentialsApi.oauth2ClientCredentials(base)
        return { redirect: null as string | null }
      }
      const res = await credentialsApi.oauth2Authorize({ ...base, authorizationUrl: oauth!.authorizationUrl, returnTo })
      return { redirect: res.authorizationUrl }
    },
    onSuccess: async ({ redirect }) => {
      if (redirect) {
        setRedirectTo(redirect)
        return
      }
      onSaved(await apisApi.getKey(apiId))
    },
    onError: (err) => setError(getApiErrorMessage(err, 'Signing in did not work.')),
  })

  const busy = save.isPending || signIn.isPending

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (oauth) {
      if (!clientId.trim() || !clientSecret.trim()) {
        setError('Enter the client ID and secret from your app at the provider.')
        return
      }
      signIn.mutate()
      return
    }
    if (!key.trim()) {
      setError(type === 'basic' ? 'Enter the password.' : 'Paste the key.')
      return
    }
    if (type === 'basic' && !username.trim()) {
      setError('Enter the username.')
      return
    }
    save.mutate({
      type,
      key: key.trim(),
      ...(type === 'basic' ? { username: username.trim() } : {}),
      ...(type === 'api_key' ? { headerName: headerName.trim() || 'X-API-Key', location } : {}),
    })
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate aria-label={`Key for ${apiName}`}>
      {changing && type !== 'oauth2' ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="api-key-sent">How it is sent</Label>
            <Select value={type} onValueChange={(v) => setType(v as ApiKeyType)} disabled={busy}>
              <SelectTrigger id="api-key-sent" className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SENT_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {type === 'api_key' && (
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <div>
                <Label htmlFor="api-key-header">{location === 'query' ? 'Parameter' : 'Header'}</Label>
                <Input id="api-key-header" className="mt-1" value={headerName} onChange={(e) => setHeaderName(e.target.value)} disabled={busy} />
              </div>
              <div>
                <Label htmlFor="api-key-location">In</Label>
                <Select value={location} onValueChange={(v) => setLocation(v as 'header' | 'query')} disabled={busy}>
                  <SelectTrigger id="api-key-location" className="mt-1 w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="header">Header</SelectItem>
                    <SelectItem value="query">Query</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm" data-testid="api-key-sent-as">
          <span className="text-muted-foreground">{keySentAs({ type, headerName, location })}</span>
          {type !== 'oauth2' && (
            <>
              {' · '}
              <button type="button" className="text-primary hover:underline" onClick={() => setChanging(true)} disabled={busy}>
                Change
              </button>
            </>
          )}
        </p>
      )}

      {oauth ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Sign in at {new URL(oauth.authorizationUrl || oauth.tokenUrl!).hostname} with the client ID and secret of your app there.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="api-oauth-client-id">Client ID</Label>
              <Input id="api-oauth-client-id" className="mt-1" value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={busy} />
            </div>
            <div>
              <Label htmlFor="api-oauth-client-secret">Client secret</Label>
              <SecretInput id="api-oauth-client-secret" className="mt-1" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} disabled={busy} />
            </div>
          </div>
          <button type="button" className="text-xs text-primary hover:underline" onClick={() => setPasteToken(true)} disabled={busy}>
            Paste an access token instead
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {type === 'basic' && (
            <div>
              <Label htmlFor="api-key-username">Username</Label>
              <Input id="api-key-username" className="mt-1" value={username} onChange={(e) => setUsername(e.target.value)} disabled={busy} autoComplete="off" />
            </div>
          )}
          <div>
            <Label htmlFor="api-key-value">{type === 'basic' ? 'Password' : type === 'oauth2' ? 'Access token' : 'Paste your key'}</Label>
            <SecretInput
              id="api-key-value"
              className="mt-1"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={type === 'basic' ? '' : 'Paste your key'}
              disabled={busy}
            />
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive" data-testid="api-key-error">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy}>
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
          {oauth ? (oauth.flow === 'client_credentials' || !oauth.authorizationUrl ? 'Connect' : 'Sign in') : submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
        <span className="text-xs text-muted-foreground">or</span>
        <ConnectAccountButton
          onConnected={(connection) => save.mutate({ type: type === 'none' ? 'api_key' : type, connectionId: connection.id, ...(type === 'api_key' ? { headerName, location } : {}) })}
        />
      </div>
      {guard.element}
    </form>
  )
}
