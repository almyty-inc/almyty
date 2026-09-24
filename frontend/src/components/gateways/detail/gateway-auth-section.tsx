/**
 * GatewayAuthSection — manages auth methods + API keys for a single gateway.
 *
 * Renders the active auth-method list (api_key/bearer/basic/oauth2/jwt/custom/none),
 * an API key list when api_key auth is configured, and inline forms for adding a
 * method and generating a key. A generated key is shown once, in place, with a
 * copy button and a plain "you won't see it again".
 * Used by GatewayDetailPage for non-skills gateways.
 */
import React, { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Key, Lock, Plus, Shield, Trash2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { CopyField } from '@/components/ui/copy-field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Field, InlineFormActions } from '@/components/layout/form-page'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { useConfirm } from '@/components/ui/confirm-dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { gatewaysApi } from '@/lib/api'
import { useNotifications } from '@/store/app'
import { getApiErrorMessage } from '@/lib/api-error'

const AUTH_TYPE_LABELS: Record<string, string> = {
  api_key: 'API Key',
  bearer_token: 'Bearer Token',
  basic_auth: 'Basic Auth',
  oauth2: 'OAuth 2.0',
  jwt: 'JWT',
  none: 'None (Public)',
  custom: 'Custom',
}

const AUTH_TYPE_DESCRIPTIONS: Record<string, string> = {
  api_key: 'Clients authenticate with an API key in the x-api-key header',
  bearer_token: 'Clients authenticate with a Bearer token in the Authorization header',
  basic_auth: 'Clients authenticate with a username and password (Basic auth)',
  oauth2: 'Clients authenticate via OAuth 2.0 (authorization code + PKCE)',
  jwt: 'Clients authenticate with a signed JWT token',
  none: 'No authentication required — gateway is publicly accessible',
  custom: 'Custom authentication scheme with configurable header/value',
}

export interface GatewayAuthSectionProps {
  gatewayId: string
  gatewayName?: string
}

export function GatewayAuthSection({ gatewayId, gatewayName }: GatewayAuthSectionProps) {
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  // API key state. `generating` opens the inline name form; a generated
  // key replaces it until the user says they have saved it.
  const [generating, setGenerating] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [generatedKey, setGeneratedKey] = useState<string | null>(null)

  // Auth config state
  const [addingAuth, setAddingAuth] = useState(false)
  const [authTypeError, setAuthTypeError] = useState<string | undefined>()
  const [newAuthType, setNewAuthType] = useState('')
  const [newAuthConfig, setNewAuthConfig] = useState<Record<string, string>>({})

  // Either inline form with something chosen or typed in asks before a
  // navigation throws it away. Cancel closes the form and a successful save
  // resets it, so neither asks.
  const guard = useLeaveGuard(
    (addingAuth && (newAuthType !== '' || Object.values(newAuthConfig).some((v) => v !== ''))) ||
      (generating && newKeyName !== ''),
  )

  // Fetch auth configs
  const { data: authConfigsData, isLoading: authLoading } = useQuery({
    queryKey: ['gateway-auth-configs', gatewayId],
    queryFn: () => gatewaysApi.getAuthConfigs(gatewayId),
    enabled: !!gatewayId,
  })

  // Fetch API keys
  const { data: keysData, isLoading: keysLoading } = useQuery({
    queryKey: ['gateway-api-keys', gatewayId],
    queryFn: () => gatewaysApi.listApiKeys(gatewayId),
    enabled: !!gatewayId,
  })

  const createAuthConfigMutation = useMutation({
    mutationFn: (data: { type: string; configuration: Record<string, any> }) =>
      gatewaysApi.createAuthConfig(gatewayId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['gateway-auth-configs', gatewayId] })
      queryClient.invalidateQueries({ queryKey: ['gateway', gatewayId] })
      success('Authentication method added', `${AUTH_TYPE_LABELS[newAuthType] || newAuthType} authentication enabled`)
      setAddingAuth(false)
      setNewAuthType('')
      setNewAuthConfig({})
    },
    onError: (err: any) => {
      errorNotif('Failed to add auth config', getApiErrorMessage(err, 'Please try again'))
    },
  })

  const deleteAuthConfigMutation = useMutation({
    mutationFn: (authId: string) => gatewaysApi.deleteAuthConfig(gatewayId, authId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['gateway-auth-configs', gatewayId] })
      queryClient.invalidateQueries({ queryKey: ['gateway', gatewayId] })
      success('Authentication method removed', 'Clients can no longer use it.')
    },
    onError: (err: any) => {
      errorNotif('Failed to remove auth config', getApiErrorMessage(err, 'Please try again'))
    },
  })

  const generateKeyMutation = useMutation({
    mutationFn: (name: string) => gatewaysApi.generateApiKey(gatewayId, { name }),
    onSuccess: (response: any) => {
      const key = response?.key
      setGeneratedKey(key)
      setGenerating(false)
      queryClient.invalidateQueries({ queryKey: ['gateway-api-keys', gatewayId] })
      success('API key generated', 'Copy and save it now. It will not be shown again.')
    },
    onError: () => {
      errorNotif('Failed to generate key', 'Could not generate API key')
    },
  })

  const revokeKeyMutation = useMutation({
    mutationFn: (keyId: string) => gatewaysApi.revokeApiKey(gatewayId, keyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['gateway-api-keys', gatewayId] })
      success('Key revoked', 'API key has been revoked')
    },
    onError: () => {
      errorNotif('Failed to revoke', 'Could not revoke API key')
    },
  })

  const { confirm, dialog: confirmDialog } = useConfirm()
  const handleRevokeKey = async (key: { id: string; name?: string }) => {
    const ok = await confirm({
      title: 'Revoke this API key?',
      description: `${key.name ? `"${key.name}"` : 'This key'} stops working immediately. Clients still using it will be refused. This cannot be undone.`,
      confirmLabel: 'Revoke key',
      destructive: true,
    })
    if (ok) revokeKeyMutation.mutate(key.id)
  }

  const authConfigsRaw = authConfigsData?.authConfigs || authConfigsData || []
  const authConfigs = Array.isArray(authConfigsRaw) ? authConfigsRaw : []
  // The endpoint returns the keys as a bare array. Don't probe `keysData?.keys`
  // first: on an array that resolves to Array.prototype.keys (a function, so
  // truthy), which swallowed the data and always rendered the empty state.
  const keys = Array.isArray(keysData) ? keysData : Array.isArray((keysData as any)?.keys) ? (keysData as any).keys : []

  const hasApiKeyAuth = authConfigs.some((c: any) => c.type === 'api_key')
  const existingTypes = authConfigs.map((c: any) => c.type)

  const handleAddAuth = (e: React.FormEvent) => {
    e.preventDefault()
    if (!newAuthType) {
      setAuthTypeError('Choose how clients authenticate.')
      return
    }
    setAuthTypeError(undefined)
    const configuration: Record<string, any> = { ...newAuthConfig }
    if (newAuthType === 'api_key') {
      configuration.keyHeader = configuration.keyHeader || 'x-api-key'
    }
    createAuthConfigMutation.mutate({ type: newAuthType, configuration })
  }

  const renderAuthConfigFields = () => {
    switch (newAuthType) {
      case 'api_key':
        return (
          <div>
            <Label htmlFor="gwauth-header-name">Header name</Label>
            <Input id="gwauth-header-name"
              value={newAuthConfig.keyHeader || 'x-api-key'}
              onChange={e => setNewAuthConfig({ ...newAuthConfig, keyHeader: e.target.value })}
              placeholder="x-api-key"
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">Header where clients send their API key</p>
          </div>
        )
      case 'bearer_token':
        return (
          <div>
            <Label htmlFor="gwauth-token-prefix">Token prefix</Label>
            <Input id="gwauth-token-prefix"
              value={newAuthConfig.tokenPrefix || 'Bearer'}
              onChange={e => setNewAuthConfig({ ...newAuthConfig, tokenPrefix: e.target.value })}
              placeholder="Bearer"
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">Prefix in the Authorization header (usually "Bearer")</p>
          </div>
        )
      case 'basic_auth':
        return (
          <p className="text-sm text-muted-foreground">
            Clients will send credentials as <code className="text-xs bg-muted px-1 py-0.5 rounded">Authorization: Basic base64(username:password)</code>
          </p>
        )
      case 'oauth2':
        return (
          <div className="space-y-3">
            <div>
              <Label htmlFor="gwauth-scopes">Scopes (comma-separated)</Label>
              <Input id="gwauth-scopes"
                value={newAuthConfig.scopes || ''}
                onChange={e => setNewAuthConfig({ ...newAuthConfig, scopes: e.target.value })}
                placeholder="read, write, admin"
                className="mt-1"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              OAuth 2.1 with PKCE. The authorization server metadata, client registration, and token endpoints are auto-configured at the gateway URL.
            </p>
          </div>
        )
      case 'jwt':
        return (
          <div className="space-y-3">
            <div>
              <Label htmlFor="gwauth-jwks-url">JWKS URL (optional)</Label>
              <Input id="gwauth-jwks-url"
                value={newAuthConfig.jwksUrl || ''}
                onChange={e => setNewAuthConfig({ ...newAuthConfig, jwksUrl: e.target.value })}
                placeholder="https://auth.example.com/.well-known/jwks.json"
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="gwauth-issuer">Issuer (optional)</Label>
              <Input id="gwauth-issuer"
                value={newAuthConfig.issuer || ''}
                onChange={e => setNewAuthConfig({ ...newAuthConfig, issuer: e.target.value })}
                placeholder="https://auth.example.com"
                className="mt-1"
              />
            </div>
          </div>
        )
      case 'custom':
        return (
          <div className="space-y-3">
            <div>
              <Label htmlFor="gwauth-header-name-2">Header name</Label>
              <Input id="gwauth-header-name-2"
                value={newAuthConfig.headerName || ''}
                onChange={e => setNewAuthConfig({ ...newAuthConfig, headerName: e.target.value })}
                placeholder="X-Custom-Auth"
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="gwauth-validation-regex">Validation regex (optional)</Label>
              <Input id="gwauth-validation-regex"
                value={newAuthConfig.validationRegex || ''}
                onChange={e => setNewAuthConfig({ ...newAuthConfig, validationRegex: e.target.value })}
                placeholder="^[a-zA-Z0-9]{32}$"
                className="mt-1"
              />
            </div>
          </div>
        )
      case 'none':
        return (
          <p className="text-sm text-muted-foreground">
            This will make the gateway publicly accessible without any authentication.
          </p>
        )
      default:
        return null
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-y-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              Authentication
            </CardTitle>
            <CardDescription>
              Configure how clients authenticate with this gateway
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {hasApiKeyAuth && (
              <Button
                size="sm"
                variant="outline"
                aria-expanded={generating}
                onClick={() => {
                  setNewKeyName('')
                  setGeneratedKey(null)
                  setGenerating(true)
                }}
              >
                <Key className="h-4 w-4 mr-1" />
                Generate key
              </Button>
            )}
            <Button
              size="sm"
              aria-expanded={addingAuth}
              onClick={() => {
                setNewAuthType('')
                setNewAuthConfig({})
                setAuthTypeError(undefined)
                setAddingAuth(true)
              }}
            >
              <Plus className="h-4 w-4 mr-1" />
              Add auth method
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {addingAuth && (
          <form
            noValidate
            onSubmit={handleAddAuth}
            aria-label="Add authentication method"
            className="space-y-4 rounded-lg border bg-muted/30 p-4"
          >
            <p className="text-sm font-medium">Add authentication method</p>
            <Field
              id="gwauth-auth-type"
              label="Method"
              required
              hint={newAuthType ? AUTH_TYPE_DESCRIPTIONS[newAuthType] : `How clients prove who they are to ${gatewayName || 'this gateway'}.`}
              error={authTypeError}
            >
              <Select
                value={newAuthType}
                onValueChange={(v) => {
                  setNewAuthType(v)
                  setNewAuthConfig({})
                  setAuthTypeError(undefined)
                }}
              >
                <SelectTrigger id="gwauth-auth-type" className="sm:max-w-sm" aria-invalid={authTypeError ? true : undefined}>
                  <SelectValue placeholder="Select authentication type" />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(AUTH_TYPE_LABELS)
                    .filter(([type]) => !existingTypes.includes(type))
                    .map(([type, label]) => (
                      <SelectItem key={type} value={type}>{label}</SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </Field>
            {newAuthType && renderAuthConfigFields()}
            <InlineFormActions
              onCancel={() => setAddingAuth(false)}
              submitLabel="Add auth method"
              submitting={createAuthConfigMutation.isPending}
            />
          </form>
        )}

        {generating && (
          <form
            noValidate
            aria-label="Generate API key"
            className="space-y-4 rounded-lg border bg-muted/30 p-4"
            onSubmit={(e) => {
              e.preventDefault()
              generateKeyMutation.mutate(newKeyName.trim() || `${gatewayName || 'Gateway'} Key`)
            }}
          >
            <p className="text-sm font-medium">Generate API key</p>
            <Field
              id="gwauth-key-name"
              label="Key name"
              hint="So you can tell keys apart later, e.g. Production or CI. The key itself is shown once."
            >
              <Input
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder="e.g. Production, CI/CD, Development"
                autoComplete="off"
                className="sm:max-w-sm"
              />
            </Field>
            <InlineFormActions
              onCancel={() => setGenerating(false)}
              submitLabel="Generate key"
              submitting={generateKeyMutation.isPending}
            />
          </form>
        )}

        {generatedKey && (
          <div
            data-testid="generated-api-key"
            className="space-y-3 rounded-lg border border-amber-400/60 bg-amber-50 p-4 dark:bg-amber-950/30"
          >
            <p className="text-sm font-medium">Your new API key</p>
            <CopyField value={generatedKey} label="API key" />
            <p className="text-sm text-amber-800 dark:text-amber-300">
              Copy it now. You won't see it again: once you close this, only its first characters are shown.
            </p>
            <div className="flex justify-end">
              <Button type="button" size="sm" variant="outline" onClick={() => setGeneratedKey(null)}>
                I've saved it
              </Button>
            </div>
          </div>
        )}

        {/* Auth Configs */}
        {authLoading ? (
          <div className="flex justify-center py-4"><LoadingSpinner /></div>
        ) : authConfigs.length === 0 ? (
          <div className="text-center py-4 text-muted-foreground text-sm">
            No authentication configured. Gateway will deny all requests by default.
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">Active auth methods</p>
            {authConfigs.length > 1 && (
              <p className="text-xs text-muted-foreground">Clients can authenticate with any of the methods below.</p>
            )}
            {authConfigs.map((config: any) => (
              <div key={config.id} className="flex items-center justify-between px-3 py-2 bg-muted rounded-lg">
                <div className="flex items-center gap-3">
                  <Lock className="h-4 w-4 text-muted-foreground" />
                  <Badge variant={config.type === 'none' ? 'secondary' : 'default'}>
                    {AUTH_TYPE_LABELS[config.type] || config.type}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {config.type === 'api_key' && `Header: ${config.configuration?.keyHeader || 'x-api-key'}`}
                    {config.type === 'bearer_token' && 'Authorization: Bearer <token>'}
                    {config.type === 'basic_auth' && 'Authorization: Basic <credentials>'}
                    {config.type === 'oauth2' && 'OAuth 2.1 + PKCE'}
                    {config.type === 'jwt' && (config.configuration?.issuer ? `Issuer: ${config.configuration.issuer}` : 'JWT validation')}
                    {config.type === 'custom' && (config.configuration?.headerName ? `Header: ${config.configuration.headerName}` : 'Custom header')}
                    {config.type === 'none' && 'Public access'}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Delete auth configuration"
                  className="text-destructive hover:text-destructive"
                  disabled={deleteAuthConfigMutation.isPending && deleteAuthConfigMutation.variables === config.id}
                  onClick={async () => {
                    const ok = await confirm({
                      title: 'Remove this authentication method?',
                      description: 'Clients using this authentication method will no longer be able to access the gateway. This cannot be undone.',
                      confirmLabel: 'Remove method',
                      destructive: true,
                    })
                    if (ok) deleteAuthConfigMutation.mutate(config.id)
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* API Keys (only show when API_KEY auth is configured) */}
        {hasApiKeyAuth && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">API keys</p>
            {keysLoading ? (
              <div className="flex justify-center py-4"><LoadingSpinner /></div>
            ) : keys.length === 0 ? (
              <div className="text-center py-4 text-muted-foreground text-sm">
                No API keys yet. Generate one to allow clients to access this gateway.
              </div>
            ) : (
              <div className="space-y-2">
                {keys.map((key: any) => (
                  <div key={key.id} className="flex items-center justify-between px-3 py-2 bg-muted rounded-lg">
                    <div className="flex items-center gap-3">
                      <Key className="h-4 w-4 text-muted-foreground" />
                      <code className="text-xs font-mono bg-background px-2 py-1 rounded">{key.keyPrefix}...</code>
                      <span className="text-sm font-medium">{key.name}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      {key.lastUsedAt && (
                        <span className="text-xs text-muted-foreground">
                          Last used {new Date(key.lastUsedAt).toLocaleDateString()}
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground">
                        Created {new Date(key.createdAt).toLocaleDateString()}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => void handleRevokeKey(key)}
                        disabled={revokeKeyMutation.isPending}
                      >
                        Revoke
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>

      {confirmDialog}
      {guard.element}
    </Card>
  )
}
