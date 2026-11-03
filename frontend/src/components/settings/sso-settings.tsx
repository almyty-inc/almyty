import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, KeyRound, ShieldCheck } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { EntitlementGate } from '@/components/entitlement-gate'
import { UpgradePrompt } from '@/components/plan-indicator'
import { useNotifications } from '@/store/app'
import { useCopySensitive } from '@/lib/clipboard'
import { ssoApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { SsoDomains } from './sso-domains'
import { useOrganizationStore } from '@/store/organization'

type Protocol = 'saml' | 'oidc'

interface SsoConfigView {
  configured: boolean
  protocol: Protocol
  enabled: boolean
  jitProvisioning: boolean
  defaultRole: string
  samlEntryPoint?: string | null
  samlIssuer?: string | null
  samlCert?: string | null
  oidcIssuerUrl?: string | null
  oidcClientId?: string | null
  oidcClientSecretSet?: boolean
  oidcRedirectUri?: string | null
  scimEnabled: boolean
  scimBaseUrl: string
  scimTokenSet: boolean
}

export function SsoSettings() {
  return (
    <EntitlementGate
      feature="sso"
      mode="lock"
      fallback={
        <UpgradePrompt
          feature="sso"
          title="Single sign-on"
          description="Let people sign in with their company account, and keep your member list in sync with your identity provider."
        />
      }
    >
      <SsoSettingsForm />
    </EntitlementGate>
  )
}

function SsoSettingsForm() {
  const queryClient = useQueryClient()
  const { success, error } = useNotifications()
  const copySensitive = useCopySensitive()
  const { currentOrganization } = useOrganizationStore()

  const { data, isLoading } = useQuery<SsoConfigView>({
    queryKey: ['sso-config'],
    queryFn: () => ssoApi.getConfig(),
  })

  const [form, setForm] = useState<Partial<SsoConfigView> & { oidcClientSecret?: string }>({})
  const [newToken, setNewToken] = useState<string | null>(null)

  useEffect(() => {
    if (data) setForm({ ...data, oidcClientSecret: '' })
  }, [data])

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const saveMutation = useMutation({
    mutationFn: () => {
      const payload: any = {
        protocol: form.protocol,
        enabled: form.enabled,
        jitProvisioning: form.jitProvisioning,
        defaultRole: form.defaultRole,
        samlEntryPoint: form.samlEntryPoint,
        samlIssuer: form.samlIssuer,
        samlCert: form.samlCert,
        oidcIssuerUrl: form.oidcIssuerUrl,
        oidcClientId: form.oidcClientId,
        oidcRedirectUri: form.oidcRedirectUri,
      }
      // Only send the client secret when the admin actually typed a new one.
      if (form.oidcClientSecret) payload.oidcClientSecret = form.oidcClientSecret
      return ssoApi.saveConfig(payload)
    },
    onSuccess: async () => {
      success('Single sign-on saved', 'Your identity provider settings are updated.')
      await queryClient.invalidateQueries({ queryKey: ['sso-config'] })
    },
    onError: (err: any) =>
      error('Failed to save', getApiErrorMessage(err, 'Please try again.')),
  })

  const rotateTokenMutation = useMutation({
    mutationFn: () => ssoApi.rotateScimToken(),
    onSuccess: async (res: any) => {
      setNewToken(res.token)
      success('SCIM token generated', 'Copy it now. You will not see it in full again.')
      await queryClient.invalidateQueries({ queryKey: ['sso-config'] })
    },
    onError: (err: any) =>
      error('Failed to generate token', getApiErrorMessage(err, 'Please try again.')),
  })

  const { confirm, dialog: confirmDialog } = useConfirm()
  // Identity provider settings edited but not saved ask before a
  // navigation throws them away. A save refetches the config, which
  // brings the form back in line.
  const guard = useLeaveGuard(
    !!data && !saveMutation.isPending && JSON.stringify(form) !== JSON.stringify({ ...data, oidcClientSecret: '' }),
  )
  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          Loading single sign-on settings...
        </CardContent>
      </Card>
    )
  }

  const protocol: Protocol = (form.protocol as Protocol) || 'saml'
  // The addresses an identity provider needs: the API's own base (the SCIM
  // base URL without its path) and this organization's id.
  const orgId = currentOrganization?.id
  const apiBase = (data?.scimBaseUrl || '').replace(/\/scim\/v2\/?$/, '')

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" /> Single sign-on
          </CardTitle>
          <CardDescription>
            Let people sign in with their company account, through your identity provider (SAML or OIDC).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <Label>Use single sign-on</Label>
              <p className="text-xs text-muted-foreground">
                When on, people can sign in with their company account.
              </p>
            </div>
            <Switch
              checked={!!form.enabled}
              onCheckedChange={(v) => set('enabled', v)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="sso-protocol">Protocol</Label>
            <Select value={protocol} onValueChange={(v) => set('protocol', v as Protocol)}>
              <SelectTrigger id="sso-protocol" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="saml">SAML 2.0</SelectItem>
                <SelectItem value="oidc">OpenID Connect</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label>Add people when they first sign in</Label>
              <p className="text-xs text-muted-foreground">
                Anyone with an address on a verified email domain (below)
                becomes a member the first time they sign in. Everyone else
                needs an invite, or must be added by your identity provider.
              </p>
            </div>
            <Switch
              checked={!!form.jitProvisioning}
              onCheckedChange={(v) => set('jitProvisioning', v)}
            />
          </div>

          {protocol === 'saml' ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="saml-entry">IdP SSO URL (entry point)</Label>
                <Input
                  id="saml-entry"
                  value={form.samlEntryPoint || ''}
                  onChange={(e) => set('samlEntryPoint', e.target.value)}
                  placeholder="https://idp.example.com/app/sso/saml"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="saml-issuer">SP entity ID (issuer)</Label>
                <Input
                  id="saml-issuer"
                  value={form.samlIssuer || ''}
                  onChange={(e) => set('samlIssuer', e.target.value)}
                  placeholder="almyty"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="saml-cert">IdP signing certificate (PEM)</Label>
                <Textarea
                  id="saml-cert"
                  rows={4}
                  value={form.samlCert || ''}
                  onChange={(e) => set('samlCert', e.target.value)}
                  placeholder="-----BEGIN CERTIFICATE-----&#10;..."
                  className="font-mono text-xs"
                />
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="oidc-issuer">Issuer URL</Label>
                <Input
                  id="oidc-issuer"
                  value={form.oidcIssuerUrl || ''}
                  onChange={(e) => set('oidcIssuerUrl', e.target.value)}
                  placeholder="https://idp.example.com"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="oidc-client-id">Client ID</Label>
                <Input
                  id="oidc-client-id"
                  value={form.oidcClientId || ''}
                  onChange={(e) => set('oidcClientId', e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="oidc-secret">
                  Client secret {form.oidcClientSecretSet && '(saved, leave blank to keep it)'}
                </Label>
                <Input
                  id="oidc-secret"
                  type="password"
                  value={form.oidcClientSecret || ''}
                  onChange={(e) => set('oidcClientSecret', e.target.value)}
                  placeholder={form.oidcClientSecretSet ? '••••••••' : ''}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="oidc-redirect">Redirect URI</Label>
                <Input
                  id="oidc-redirect"
                  value={form.oidcRedirectUri || ''}
                  onChange={(e) => set('oidcRedirectUri', e.target.value)}
                  placeholder="https://api.example.com/sso/<org-id>/oidc/callback"
                />
              </div>
            </div>
          )}

          {orgId && apiBase && (
            <div className="space-y-3 rounded-md border bg-muted/30 p-3" data-testid="sso-idp-addresses">
              <p className="text-sm font-medium">For your identity provider</p>
              {protocol === 'saml' ? (
                <>
                  <IdpAddress id="sso-saml-acs" label="Reply URL (assertion consumer service)" value={`${apiBase}/sso/${orgId}/saml/callback`} />
                  <IdpAddress id="sso-saml-metadata" label="Service provider metadata" value={`${apiBase}/sso/${orgId}/saml/metadata`} />
                </>
              ) : (
                <IdpAddress
                  id="sso-oidc-callback"
                  label="Redirect URI to register"
                  hint="Register it with your identity provider, and enter the same address under Redirect URI above."
                  value={`${apiBase}/sso/${orgId}/oidc/callback`}
                />
              )}
              <IdpAddress
                id="sso-login-url"
                label="Sign-in link"
                hint="Where your people sign in with their company account. Put it in your identity provider's app portal, or share it."
                value={`${apiBase}/sso/${orgId}/${protocol}/login`}
              />
            </div>
          )}
          <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? 'Saving...' : 'Save SSO settings'}
          </Button>
        </CardContent>
      </Card>

      <SsoDomains />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-primary" /> Automatic member sync (SCIM)
          </CardTitle>
          <CardDescription>
            Give your identity provider this address and token, and it adds
            and removes people and groups here for you.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="sso-scim-base-url">SCIM base URL</Label>
            <div className="flex gap-2">
              <Input id="sso-scim-base-url" readOnly value={data?.scimBaseUrl || ''} className="font-mono text-xs" />
              <Button
                variant="outline"
                size="icon"
                aria-label="Copy SCIM base URL"
                onClick={() => copySensitive(data?.scimBaseUrl || '', 'SCIM base URL')}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {newToken && (
            <div className="space-y-2">
              <Label htmlFor="sso-scim-new-token">New SCIM token (shown once)</Label>
              <div className="flex gap-2">
                <Input id="sso-scim-new-token" readOnly value={newToken} className="font-mono text-xs" />
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Copy new SCIM token"
                  onClick={() => copySensitive(newToken, 'SCIM token')}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}

          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              onClick={async () => {
                // Generating the first token breaks nothing; rotating
                // invalidates the one your identity provider is using.
                if (data?.scimTokenSet) {
                  const ok = await confirm({
                    title: 'Rotate the SCIM token?',
                    description: 'The current token stops working immediately. Provisioning from your identity provider fails until you give it the new token.',
                    confirmLabel: 'Rotate token',
                    destructive: true,
                  })
                  if (!ok) return
                }
                rotateTokenMutation.mutate()
              }}
              disabled={rotateTokenMutation.isPending}
            >
              {data?.scimTokenSet ? 'Rotate SCIM token' : 'Generate SCIM token'}
            </Button>
            <span className="text-xs text-muted-foreground">
              {data?.scimTokenSet
                ? 'A token is set. Rotating it stops the old one from working.'
                : 'No token yet. Generate one to turn on member sync.'}
            </span>
          </div>
        </CardContent>
      </Card>
      {confirmDialog}
      {guard.element}
    </div>
  )
}

/** One address an identity provider needs from us, read-only with a copy button. */
function IdpAddress({ id, label, hint, value }: { id: string; label: string; hint?: string; value: string }) {
  const copySensitive = useCopySensitive()
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input id={id} readOnly value={value} className="font-mono text-xs" />
        <Button type="button" variant="outline" size="icon" aria-label={`Copy ${label}`} onClick={() => copySensitive(value, label)}>
          <Copy className="h-4 w-4" />
        </Button>
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
