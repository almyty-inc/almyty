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
import { useNotifications } from '@/store/app'
import { useCopySensitive } from '@/lib/clipboard'
import { ssoApi } from '@/lib/api'

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

/** Upsell shown when the deployment's license does not include SSO. */
function SsoLocked() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" /> Single Sign-On (Enterprise)
        </CardTitle>
        <CardDescription>
          SAML / OIDC login and SCIM provisioning are part of the almyty
          Enterprise edition. Add an enterprise license to enable them.
        </CardDescription>
      </CardHeader>
    </Card>
  )
}

export function SsoSettings() {
  return (
    <EntitlementGate feature="sso" mode="lock" fallback={<SsoLocked />}>
      <SsoSettingsForm />
    </EntitlementGate>
  )
}

function SsoSettingsForm() {
  const queryClient = useQueryClient()
  const { success, error } = useNotifications()
  const copySensitive = useCopySensitive()

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
      success('SSO configuration saved', 'Identity provider settings updated.')
      await queryClient.invalidateQueries({ queryKey: ['sso-config'] })
    },
    onError: (err: any) =>
      error('Failed to save', err.response?.data?.message || 'Please try again.'),
  })

  const rotateTokenMutation = useMutation({
    mutationFn: () => ssoApi.rotateScimToken(),
    onSuccess: async (res: any) => {
      setNewToken(res.token)
      success('SCIM token generated', 'Copy it now — it will not be shown again in full.')
      await queryClient.invalidateQueries({ queryKey: ['sso-config'] })
    },
    onError: (err: any) =>
      error('Failed to generate token', err.response?.data?.message || 'Please try again.'),
  })

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          Loading SSO configuration...
        </CardContent>
      </Card>
    )
  }

  const protocol: Protocol = (form.protocol as Protocol) || 'saml'

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" /> Single Sign-On
          </CardTitle>
          <CardDescription>
            Let members sign in through your identity provider (SAML or OIDC).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <Label>Enable SSO login</Label>
              <p className="text-xs text-muted-foreground">
                When on, members can sign in via your IdP.
              </p>
            </div>
            <Switch
              checked={!!form.enabled}
              onCheckedChange={(v) => set('enabled', v)}
            />
          </div>

          <div className="space-y-2">
            <Label>Protocol</Label>
            <Select value={protocol} onValueChange={(v) => set('protocol', v as Protocol)}>
              <SelectTrigger className="w-48">
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
              <Label>Just-in-time provisioning</Label>
              <p className="text-xs text-muted-foreground">
                Auto-create members on first successful login (otherwise the
                user must already exist / be provisioned via SCIM).
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
                  Client secret {form.oidcClientSecretSet && '(set — leave blank to keep)'}
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

          <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? 'Saving...' : 'Save SSO Settings'}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-primary" /> SCIM Provisioning
          </CardTitle>
          <CardDescription>
            Point your identity provider at this base URL and bearer token to
            sync users and groups automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>SCIM base URL</Label>
            <div className="flex gap-2">
              <Input readOnly value={data?.scimBaseUrl || ''} className="font-mono text-xs" />
              <Button
                variant="outline"
                size="icon"
                onClick={() => copySensitive(data?.scimBaseUrl || '', 'SCIM base URL')}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {newToken && (
            <div className="space-y-2">
              <Label>New SCIM token (shown once)</Label>
              <div className="flex gap-2">
                <Input readOnly value={newToken} className="font-mono text-xs" />
                <Button
                  variant="outline"
                  size="icon"
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
              onClick={() => rotateTokenMutation.mutate()}
              disabled={rotateTokenMutation.isPending}
            >
              {data?.scimTokenSet ? 'Rotate SCIM token' : 'Generate SCIM token'}
            </Button>
            <span className="text-xs text-muted-foreground">
              {data?.scimTokenSet
                ? 'A token is configured. Rotating invalidates the old one.'
                : 'No token yet — generate one to enable SCIM.'}
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
