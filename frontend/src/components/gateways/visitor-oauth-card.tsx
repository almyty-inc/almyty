import React, { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy } from 'lucide-react'

import { FormSection } from '@/components/layout/form-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
 * provider. Set on the web chat page and saved with it. The client secret is
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

export interface VisitorOAuthDraft {
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
  /** An OpenID Connect provider whose endpoints are entered by hand. */
  manual: boolean
}

export const visitorOAuthKey = (gatewayId: string) => ['gateway-visitor-oauth', gatewayId]

export function draftFrom(p: VisitorOAuthProvider | null): VisitorOAuthDraft {
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
    manual: !!p && p.preset === 'oidc' && !p.discoveryUrl,
  }
}

/** Only the fields the chosen provider takes; an empty secret keeps the stored one. */
export function visitorOAuthBody(draft: VisitorOAuthDraft): Record<string, unknown> {
  const d = draft.manual ? { ...draft, discoveryUrl: '' } : draft
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

/** What is still missing before the provider can be saved, in words; null when nothing is. */
export function visitorOAuthProblem(draft: VisitorOAuthDraft, provider: VisitorOAuthProvider | null): string | null {
  if (!draft.clientId.trim()) return 'Enter the client ID from the provider.'
  if (!provider?.hasClientSecret && !draft.clientSecret) return 'Enter the client secret from the provider.'
  return null
}

export interface VisitorOAuthCardProps {
  gatewayId: string
  authMode?: string
  /** The provider as edited on the page, or null while it is not being changed. Saved with the page. */
  draft: VisitorOAuthDraft | null
  onDraftChange: (draft: VisitorOAuthDraft | null) => void
  error?: string
}

export function VisitorOAuthCard({ gatewayId, authMode, draft, onDraftChange, error }: VisitorOAuthCardProps) {
  const queryClient = useQueryClient()
  const copy = useCopy()
  const key = visitorOAuthKey(gatewayId)
  const { data, isLoading } = useQuery<VisitorOAuthState>({
    queryKey: key,
    queryFn: () => gatewaysApi.getVisitorOAuth(gatewayId),
  })
  const provider = data?.provider ?? null
  const editing = draft !== null
  const value = draft ?? draftFrom(provider)
  const manual = value.manual
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)

  const set = (patch: Partial<VisitorOAuthDraft>) => onDraftChange({ ...value, ...patch })
  const setManual = (on: boolean) => set({ manual: on })

  const remove = useMutation({
    mutationFn: () => gatewaysApi.removeVisitorOAuth(gatewayId),
    onSuccess: () => {
      queryClient.setQueryData(key, { provider: null, redirectUris: data?.redirectUris ?? [] })
      setConfirmRemove(false)
      setRemoveError(null)
      onDraftChange(null)
    },
    onError: (err: unknown) => setRemoveError(getApiErrorMessage(err, 'Please try again.')),
  })

  const showForm = !provider || editing
  const id = (field: string) => `visitor-oauth-${field}-${gatewayId}`
  const needsSecret = !provider?.hasClientSecret
  const shown = error ?? removeError

  return (
    <FormSection
      title="Visitor sign-in provider"
      description={`When access is set to OAuth, visitors sign in with this provider before they can chat.${
        authMode && authMode !== 'oauth' ? ' Access is not set to OAuth right now, so this is not in use.' : ''
      }`}
    >
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
                  <Button type="button" variant="outline" onClick={() => onDraftChange(draftFrom(provider))}>
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
              <div role="group" aria-label="Sign-in provider" className="space-y-3">
                {/* The well-known providers first, as tiles; everything
                    else is "Other", the only one that asks for a URL. */}
                <ChoiceTiles label="Provider">
                  {PRESET_TILES.map((tile) => (
                    <ChoiceTile
                      key={tile.preset}
                      testId={`visitor-oauth-preset-${tile.preset}`}
                      icon={<span className="text-xs font-semibold text-primary">{tile.mark}</span>}
                      label={tile.label}
                      selected={tile.preset === 'oidc' ? isOther(value.preset) : value.preset === tile.preset}
                      onClick={() => set({ preset: tile.preset === 'oidc' && isOther(value.preset) ? value.preset : tile.preset })}
                    />
                  ))}
                </ChoiceTiles>

                {value.preset === 'microsoft' && (
                  <div className="space-y-1.5">
                    <Label htmlFor={id('tenant')}>Tenant ID or primary domain</Label>
                    <Input id={id('tenant')} value={value.tenant} onChange={(e) => set({ tenant: e.target.value })} placeholder="contoso.onmicrosoft.com" />
                    <p className="text-xs text-muted-foreground">One tenant. The shared common and organizations endpoints are not supported.</p>
                  </div>
                )}

                {value.preset === 'oidc' && !manual && (
                  <div className="space-y-1.5">
                    <Label htmlFor={id('discovery')}>Issuer or discovery URL</Label>
                    <Input id={id('discovery')} value={value.discoveryUrl} onChange={(e) => set({ discoveryUrl: e.target.value })} placeholder="https://login.example.com" />
                  </div>
                )}

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor={id('client-id')}>Client ID</Label>
                    <Input id={id('client-id')} value={value.clientId} onChange={(e) => set({ clientId: e.target.value })} autoComplete="off" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={id('client-secret')}>Client secret</Label>
                    <Input
                      id={id('client-secret')}
                      type="password"
                      value={value.clientSecret}
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
                    value={value.allowedEmailDomains}
                    onChange={(e) => set({ allowedEmailDomains: e.target.value })}
                    placeholder="example.com, example.org"
                  />
                  <p className="text-xs text-muted-foreground">
                    Optional. Leave empty to admit anyone with an account at the provider. When set, only addresses the
                    provider has verified count.
                  </p>
                </div>

                <Disclosure title="Advanced" summary={value.scopes.trim() ? `Scopes: ${value.scopes.trim()}` : 'Provider default scopes'}>
                  {isOther(value.preset) && (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-4">
                        <Label htmlFor={id('manual')}>Enter the endpoints by hand</Label>
                        <Switch
                          id={id('manual')}
                          checked={manual || value.preset === 'oauth2'}
                          disabled={value.preset === 'oauth2'}
                          onCheckedChange={setManual}
                        />
                      </div>
                      <div className="flex items-center justify-between gap-4">
                        <Label htmlFor={id('plain')}>Plain OAuth 2.0, without OpenID Connect</Label>
                        <Switch
                          id={id('plain')}
                          checked={value.preset === 'oauth2'}
                          onCheckedChange={(plain) => set({ preset: plain ? 'oauth2' : 'oidc' })}
                        />
                      </div>
                      {(manual || value.preset === 'oauth2') && (
                        <div className="grid gap-3 sm:grid-cols-2">
                          {value.preset === 'oidc' && (
                            <div className="space-y-1.5">
                              <Label htmlFor={id('issuer')}>Issuer</Label>
                              <Input id={id('issuer')} value={value.issuer} onChange={(e) => set({ issuer: e.target.value })} placeholder="https://login.example.com" />
                            </div>
                          )}
                          <div className="space-y-1.5">
                            <Label htmlFor={id('authorize')}>Authorization endpoint</Label>
                            <Input id={id('authorize')} value={value.authorizationEndpoint} onChange={(e) => set({ authorizationEndpoint: e.target.value })} />
                          </div>
                          <div className="space-y-1.5">
                            <Label htmlFor={id('token')}>Token endpoint</Label>
                            <Input id={id('token')} value={value.tokenEndpoint} onChange={(e) => set({ tokenEndpoint: e.target.value })} />
                          </div>
                          <div className="space-y-1.5">
                            <Label htmlFor={id('userinfo')}>User info endpoint</Label>
                            <Input id={id('userinfo')} value={value.userinfoEndpoint} onChange={(e) => set({ userinfoEndpoint: e.target.value })} />
                          </div>
                          {value.preset === 'oidc' && (
                            <div className="space-y-1.5">
                              <Label htmlFor={id('jwks')}>JWKS URI</Label>
                              <Input id={id('jwks')} value={value.jwksUri} onChange={(e) => set({ jwksUri: e.target.value })} />
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="space-y-1.5">
                    <Label htmlFor={id('scopes')}>Scopes</Label>
                    <Input id={id('scopes')} value={value.scopes} onChange={(e) => set({ scopes: e.target.value })} placeholder="Provider default" />
                  </div>
                </Disclosure>

                {editing && provider && (
                  <div>
                    <Button type="button" variant="ghost" onClick={() => onDraftChange(null)}>
                      Keep the saved provider
                    </Button>
                  </div>
                )}
              </div>
            )}

            {shown && (
              <p role="alert" className="text-sm text-destructive">
                {shown}
              </p>
            )}
          </>
        )}
    </FormSection>
  )
}
