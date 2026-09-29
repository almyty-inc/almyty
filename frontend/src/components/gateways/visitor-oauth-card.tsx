import React, { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ChoiceTile, ChoiceTiles } from '@/components/connect/service-tiles'
import { Disclosure } from '@/components/ui/disclosure'
import { gatewaysApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useCopy } from '@/lib/clipboard'

/**
 * The identity provider a hosted chat app signs visitors in with when its
 * access is set to OAuth: Google, GitHub, Microsoft, or any OpenID Connect
 * provider. Configured inline on the gateway page. The client secret is
 * write-only here: it is stored in the credential store and never shown
 * again, only whether one is set.
 */

export type VisitorOAuthPreset = 'google' | 'github' | 'microsoft' | 'oidc' | 'oauth2'

export interface VisitorOAuthProvider {
  preset: VisitorOAuthPreset
  providerLabel: string
  issuer: string | null
  authorizationEndpoint: string
  tokenEndpoint: string
  userinfoEndpoint: string | null
  jwksUri: string | null
  discoveryUrl: string | null
  tenant: string | null
  clientId: string
  scopes: string[]
  allowedEmailDomains: string[]
  hasClientSecret: boolean
  updatedAt: string
}

export interface VisitorOAuthState {
  provider: VisitorOAuthProvider | null
  /** Exactly what to register at the provider as the redirect / callback URL. */
  redirectUris: string[]
}

const PRESET_LABEL: Record<VisitorOAuthPreset, string> = {
  google: 'Google',
  github: 'GitHub',
  microsoft: 'Microsoft Entra ID',
  oidc: 'Other OpenID Connect provider',
  oauth2: 'Other OAuth 2.0 provider',
}

/** The tiles, well-known providers first. "Other" covers any OpenID Connect or OAuth 2.0 provider. */
const PRESET_TILES: Array<{ preset: VisitorOAuthPreset; label: string; mark: string }> = [
  { preset: 'google', label: 'Google', mark: 'G' },
  { preset: 'microsoft', label: 'Microsoft', mark: 'M' },
  { preset: 'github', label: 'GitHub', mark: 'GH' },
  { preset: 'oidc', label: 'Other', mark: '…' },
]

const isOther = (preset: VisitorOAuthPreset) => preset === 'oidc' || preset === 'oauth2'

interface Draft {
  preset: VisitorOAuthPreset
  clientId: string
  clientSecret: string
  tenant: string
  discoveryUrl: string
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  userinfoEndpoint: string
  jwksUri: string
  scopes: string
  allowedEmailDomains: string
}

function draftFrom(p: VisitorOAuthProvider | null): Draft {
  return {
    preset: p?.preset ?? 'google',
    clientId: p?.clientId ?? '',
    clientSecret: '',
    tenant: p?.tenant ?? '',
    discoveryUrl: p?.discoveryUrl ?? '',
    issuer: p && !p.discoveryUrl ? p.issuer ?? '' : '',
    authorizationEndpoint: p && !p.discoveryUrl ? p.authorizationEndpoint : '',
    tokenEndpoint: p && !p.discoveryUrl ? p.tokenEndpoint : '',
    userinfoEndpoint: p && !p.discoveryUrl ? p.userinfoEndpoint ?? '' : '',
    jwksUri: p && !p.discoveryUrl ? p.jwksUri ?? '' : '',
    scopes: p?.scopes.join(' ') ?? '',
    allowedEmailDomains: p?.allowedEmailDomains.join(', ') ?? '',
  }
}

/** Only the fields the chosen provider takes; an empty secret keeps the stored one. */
function bodyFrom(d: Draft): Record<string, unknown> {
  const body: Record<string, unknown> = {
    preset: d.preset,
    clientId: d.clientId.trim(),
    allowedEmailDomains: d.allowedEmailDomains,
  }
  if (d.clientSecret) body.clientSecret = d.clientSecret
  if (d.scopes.trim()) body.scopes = d.scopes
  if (d.preset === 'microsoft') body.tenant = d.tenant.trim()
  if (d.preset === 'oidc' && d.discoveryUrl.trim()) body.discoveryUrl = d.discoveryUrl.trim()
  if ((d.preset === 'oidc' && !d.discoveryUrl.trim()) || d.preset === 'oauth2') {
    body.authorizationEndpoint = d.authorizationEndpoint.trim()
    body.tokenEndpoint = d.tokenEndpoint.trim()
    body.userinfoEndpoint = d.userinfoEndpoint.trim()
    if (d.preset === 'oidc') {
      body.issuer = d.issuer.trim()
      body.jwksUri = d.jwksUri.trim()
    }
  }
  return body
}

export function VisitorOAuthCard({ gatewayId, authMode }: { gatewayId: string; authMode?: string }) {
  const queryClient = useQueryClient()
  const copy = useCopy()
  const key = ['gateway-visitor-oauth', gatewayId]
  const { data, isLoading } = useQuery<VisitorOAuthState>({
    queryKey: key,
    queryFn: () => gatewaysApi.getVisitorOAuth(gatewayId),
  })
  const provider = data?.provider ?? null
  const [draft, setDraft] = useState<Draft>(() => draftFrom(null))
  const [editing, setEditing] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [manual, setManual] = useState(false)

  useEffect(() => {
    if (!editing) {
      setDraft(draftFrom(provider))
      setManual(!!provider && provider.preset === 'oidc' && !provider.discoveryUrl)
    }
  }, [provider, editing])

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))
  const onFail = (err: unknown) => setError(getApiErrorMessage(err, 'Please try again.'))

  const save = useMutation({
    mutationFn: () => gatewaysApi.setVisitorOAuth(gatewayId, bodyFrom(manual ? { ...draft, discoveryUrl: '' } : draft)),
    onSuccess: (next: VisitorOAuthState) => {
      queryClient.setQueryData(key, next)
      setEditing(false)
      setError(null)
    },
    onError: onFail,
  })
  const remove = useMutation({
    mutationFn: () => gatewaysApi.removeVisitorOAuth(gatewayId),
    onSuccess: () => {
      queryClient.setQueryData(key, { provider: null, redirectUris: data?.redirectUris ?? [] })
      setConfirmRemove(false)
      setError(null)
    },
    onError: onFail,
  })

  const showForm = !provider || editing
  const id = (field: string) => `visitor-oauth-${field}-${gatewayId}`
  const needsSecret = !provider?.hasClientSecret

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Visitor sign-in provider</CardTitle>
        <CardDescription>
          When access is set to OAuth, visitors sign in with this provider before they can chat.
          {authMode && authMode !== 'oauth' && ' Access is not set to OAuth right now, so this is not in use.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : (
          <>
            {(data?.redirectUris?.length ?? 0) > 0 && (
              <div className="space-y-1.5" aria-label="Redirect URIs">
                <p className="text-sm text-muted-foreground">
                  Register {data!.redirectUris.length > 1 ? 'these redirect URIs' : 'this redirect URI'} with the provider, exactly as shown:
                </p>
                {data!.redirectUris.map((uri) => (
                  <div key={uri} className="flex items-center gap-2 rounded-md border p-2">
                    <code className="min-w-0 flex-1 break-all font-mono text-xs">{uri}</code>
                    <Button type="button" variant="ghost" size="sm" aria-label={`Copy ${uri}`} onClick={() => copy(uri, 'Redirect URI')}>
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {provider && !editing && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{PRESET_LABEL[provider.preset]}</span>
                  <Badge variant={provider.hasClientSecret ? 'default' : 'secondary'}>
                    {provider.hasClientSecret ? 'Ready' : 'Secret missing'}
                  </Badge>
                </div>
                <dl className="grid gap-1 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
                  <dt className="text-muted-foreground">Client ID</dt>
                  <dd className="break-all font-mono text-xs">{provider.clientId}</dd>
                  {provider.issuer && (
                    <>
                      <dt className="text-muted-foreground">Issuer</dt>
                      <dd className="break-all font-mono text-xs">{provider.issuer}</dd>
                    </>
                  )}
                  <dt className="text-muted-foreground">Scopes</dt>
                  <dd className="font-mono text-xs">{provider.scopes.join(' ') || 'none'}</dd>
                  <dt className="text-muted-foreground">Who may sign in</dt>
                  <dd>
                    {provider.allowedEmailDomains.length
                      ? `Verified addresses at ${provider.allowedEmailDomains.join(', ')}`
                      : `Anyone with a ${provider.providerLabel} account`}
                  </dd>
                </dl>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" onClick={() => setEditing(true)}>
                    Edit provider
                  </Button>
                  {confirmRemove ? (
                    <span className="flex items-center gap-2 text-sm">
                      Remove the provider and its secret? Visitors can no longer sign in.
                      <Button type="button" variant="destructive" size="sm" onClick={() => remove.mutate()} disabled={remove.isPending}>
                        Remove
                      </Button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmRemove(false)}>
                        Keep
                      </Button>
                    </span>
                  ) : (
                    <Button type="button" variant="ghost" onClick={() => setConfirmRemove(true)}>
                      Remove provider
                    </Button>
                  )}
                </div>
              </div>
            )}

            {showForm && (
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault()
                  save.mutate()
                }}
              >
                {/* The well-known providers first, as tiles; everything
                    else is "Other", the only one that asks for a URL. */}
                <ChoiceTiles label="Provider">
                  {PRESET_TILES.map((tile) => (
                    <ChoiceTile
                      key={tile.preset}
                      testId={`visitor-oauth-preset-${tile.preset}`}
                      icon={<span className="text-xs font-semibold text-primary">{tile.mark}</span>}
                      label={tile.label}
                      selected={tile.preset === 'oidc' ? isOther(draft.preset) : draft.preset === tile.preset}
                      onClick={() => set({ preset: tile.preset === 'oidc' && isOther(draft.preset) ? draft.preset : tile.preset })}
                    />
                  ))}
                </ChoiceTiles>

                {draft.preset === 'microsoft' && (
                  <div className="space-y-1.5">
                    <Label htmlFor={id('tenant')}>Tenant ID or primary domain</Label>
                    <Input id={id('tenant')} value={draft.tenant} onChange={(e) => set({ tenant: e.target.value })} placeholder="contoso.onmicrosoft.com" />
                    <p className="text-xs text-muted-foreground">One tenant. The shared common and organizations endpoints are not supported.</p>
                  </div>
                )}

                {draft.preset === 'oidc' && !manual && (
                  <div className="space-y-1.5">
                    <Label htmlFor={id('discovery')}>Issuer or discovery URL</Label>
                    <Input id={id('discovery')} value={draft.discoveryUrl} onChange={(e) => set({ discoveryUrl: e.target.value })} placeholder="https://login.example.com" />
                  </div>
                )}

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor={id('client-id')}>Client ID</Label>
                    <Input id={id('client-id')} value={draft.clientId} onChange={(e) => set({ clientId: e.target.value })} autoComplete="off" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={id('client-secret')}>Client secret</Label>
                    <Input
                      id={id('client-secret')}
                      type="password"
                      value={draft.clientSecret}
                      onChange={(e) => set({ clientSecret: e.target.value })}
                      autoComplete="new-password"
                      placeholder={needsSecret ? '' : 'Stored. Leave blank to keep it.'}
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor={id('domains')}>Allowed email domains</Label>
                  <Input
                    id={id('domains')}
                    value={draft.allowedEmailDomains}
                    onChange={(e) => set({ allowedEmailDomains: e.target.value })}
                    placeholder="example.com, example.org"
                  />
                  <p className="text-xs text-muted-foreground">
                    Optional. Leave empty to admit anyone with an account at the provider. When set, only addresses the
                    provider has verified count.
                  </p>
                </div>

                <Disclosure title="Advanced" summary={draft.scopes.trim() ? `Scopes: ${draft.scopes.trim()}` : 'Provider default scopes'}>
                  {isOther(draft.preset) && (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-4">
                        <Label htmlFor={id('manual')}>Enter the endpoints by hand</Label>
                        <Switch
                          id={id('manual')}
                          checked={manual || draft.preset === 'oauth2'}
                          disabled={draft.preset === 'oauth2'}
                          onCheckedChange={setManual}
                        />
                      </div>
                      <div className="flex items-center justify-between gap-4">
                        <Label htmlFor={id('plain')}>Plain OAuth 2.0, without OpenID Connect</Label>
                        <Switch
                          id={id('plain')}
                          checked={draft.preset === 'oauth2'}
                          onCheckedChange={(plain) => set({ preset: plain ? 'oauth2' : 'oidc' })}
                        />
                      </div>
                      {(manual || draft.preset === 'oauth2') && (
                        <div className="grid gap-3 sm:grid-cols-2">
                          {draft.preset === 'oidc' && (
                            <div className="space-y-1.5">
                              <Label htmlFor={id('issuer')}>Issuer</Label>
                              <Input id={id('issuer')} value={draft.issuer} onChange={(e) => set({ issuer: e.target.value })} placeholder="https://login.example.com" />
                            </div>
                          )}
                          <div className="space-y-1.5">
                            <Label htmlFor={id('authorize')}>Authorization endpoint</Label>
                            <Input id={id('authorize')} value={draft.authorizationEndpoint} onChange={(e) => set({ authorizationEndpoint: e.target.value })} />
                          </div>
                          <div className="space-y-1.5">
                            <Label htmlFor={id('token')}>Token endpoint</Label>
                            <Input id={id('token')} value={draft.tokenEndpoint} onChange={(e) => set({ tokenEndpoint: e.target.value })} />
                          </div>
                          <div className="space-y-1.5">
                            <Label htmlFor={id('userinfo')}>User info endpoint</Label>
                            <Input id={id('userinfo')} value={draft.userinfoEndpoint} onChange={(e) => set({ userinfoEndpoint: e.target.value })} />
                          </div>
                          {draft.preset === 'oidc' && (
                            <div className="space-y-1.5">
                              <Label htmlFor={id('jwks')}>JWKS URI</Label>
                              <Input id={id('jwks')} value={draft.jwksUri} onChange={(e) => set({ jwksUri: e.target.value })} />
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="space-y-1.5">
                    <Label htmlFor={id('scopes')}>Scopes</Label>
                    <Input id={id('scopes')} value={draft.scopes} onChange={(e) => set({ scopes: e.target.value })} placeholder="Provider default" />
                  </div>
                </Disclosure>

                <div className="flex gap-2">
                  <Button type="submit" disabled={save.isPending || !draft.clientId.trim() || (needsSecret && !draft.clientSecret)}>
                    {save.isPending ? 'Saving...' : 'Save provider'}
                  </Button>
                  {editing && (
                    <Button type="button" variant="ghost" onClick={() => { setEditing(false); setError(null) }}>
                      Cancel
                    </Button>
                  )}
                </div>
              </form>
            )}

            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
