/**
 * GatewayAuthSection — manages auth methods + API keys for a single gateway.
 *
 * Renders the active auth-method list (api_key/bearer/basic/oauth2/jwt/custom/none),
 * an API key list when api_key auth is configured, and dialogs for adding methods
 * and generating keys. Generated key copy uses useCopySensitive to surface a
 * sensitive-value warning rather than a plain success toast.
 * Used by GatewayDetailPage for non-skills gateways.
 */
import React, { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, Key, Lock, Plus, Shield, Trash2 } from 'lucide-react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { gatewaysApi } from '@/lib/api'
import { useCopySensitive } from '@/lib/clipboard'
import { useNotifications } from '@/store/app'

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
  gatewayName: string
}

export function GatewayAuthSection({ gatewayId, gatewayName }: GatewayAuthSectionProps) {
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  const copySensitive = useCopySensitive()

  // API key state
  const [generateDialogOpen, setGenerateDialogOpen] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [generatedKey, setGeneratedKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // Auth config state
  const [addAuthDialogOpen, setAddAuthDialogOpen] = useState(false)
  const [newAuthType, setNewAuthType] = useState('')
  const [newAuthConfig, setNewAuthConfig] = useState<Record<string, string>>({})
  const [deleteAuthId, setDeleteAuthId] = useState<string | null>(null)

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
      success('Auth Config Added', `${AUTH_TYPE_LABELS[newAuthType] || newAuthType} authentication enabled`)
      setAddAuthDialogOpen(false)
      setNewAuthType('')
      setNewAuthConfig({})
    },
    onError: (err: any) => {
      errorNotif('Failed to add auth config', err.response?.data?.message || 'Please try again')
    },
  })

  const deleteAuthConfigMutation = useMutation({
    mutationFn: (authId: string) => gatewaysApi.deleteAuthConfig(gatewayId, authId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['gateway-auth-configs', gatewayId] })
      queryClient.invalidateQueries({ queryKey: ['gateway', gatewayId] })
      success('Auth Config Removed', 'Authentication method has been removed')
      setDeleteAuthId(null)
    },
    onError: (err: any) => {
      errorNotif('Failed to remove auth config', err.response?.data?.message || 'Please try again')
    },
  })

  const generateKeyMutation = useMutation({
    mutationFn: (name: string) => gatewaysApi.generateApiKey(gatewayId, { name }),
    onSuccess: (response: any) => {
      const key = response?.key
      setGeneratedKey(key)
      queryClient.invalidateQueries({ queryKey: ['gateway-api-keys', gatewayId] })
      success('API Key Generated', 'Copy and save it now — it will not be shown again.')
    },
    onError: () => {
      errorNotif('Failed to generate key', 'Could not generate API key')
    },
  })

  const revokeKeyMutation = useMutation({
    mutationFn: (keyId: string) => gatewaysApi.revokeApiKey(gatewayId, keyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['gateway-api-keys', gatewayId] })
      success('Key Revoked', 'API key has been revoked')
    },
    onError: () => {
      errorNotif('Failed to revoke', 'Could not revoke API key')
    },
  })

  const authConfigsRaw = authConfigsData?.authConfigs || authConfigsData || []
  const authConfigs = Array.isArray(authConfigsRaw) ? authConfigsRaw : []
  const keysExtracted = keysData?.keys || keysData || []
  const keys = Array.isArray(keysExtracted) ? keysExtracted : []

  const hasApiKeyAuth = authConfigs.some((c: any) => c.type === 'api_key')
  const existingTypes = authConfigs.map((c: any) => c.type)

  const handleAddAuth = () => {
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
            <Label>Header Name</Label>
            <Input
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
            <Label>Token Prefix</Label>
            <Input
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
              <Label>Scopes (comma-separated)</Label>
              <Input
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
              <Label>JWKS URL (optional)</Label>
              <Input
                value={newAuthConfig.jwksUrl || ''}
                onChange={e => setNewAuthConfig({ ...newAuthConfig, jwksUrl: e.target.value })}
                placeholder="https://auth.example.com/.well-known/jwks.json"
                className="mt-1"
              />
            </div>
            <div>
              <Label>Issuer (optional)</Label>
              <Input
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
              <Label>Header Name</Label>
              <Input
                value={newAuthConfig.headerName || ''}
                onChange={e => setNewAuthConfig({ ...newAuthConfig, headerName: e.target.value })}
                placeholder="X-Custom-Auth"
                className="mt-1"
              />
            </div>
            <div>
              <Label>Validation Regex (optional)</Label>
              <Input
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
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              Authentication
            </CardTitle>
            <CardDescription>
              Configure how clients authenticate with this gateway
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {hasApiKeyAuth && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setNewKeyName('')
                  setGeneratedKey(null)
                  setCopied(false)
                  setGenerateDialogOpen(true)
                }}
              >
                <Key className="h-4 w-4 mr-1" />
                Generate Key
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => {
                setNewAuthType('')
                setNewAuthConfig({})
                setAddAuthDialogOpen(true)
              }}
            >
              <Plus className="h-4 w-4 mr-1" />
              Add Auth Method
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Auth Configs */}
        {authLoading ? (
          <div className="flex justify-center py-4"><LoadingSpinner /></div>
        ) : authConfigs.length === 0 ? (
          <div className="text-center py-4 text-muted-foreground text-sm">
            No authentication configured. Gateway will deny all requests by default.
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">Active Auth Methods</p>
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
                  className="text-destructive hover:text-destructive"
                  onClick={() => setDeleteAuthId(config.id)}
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
            <p className="text-sm font-medium text-muted-foreground">API Keys</p>
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
                        onClick={() => revokeKeyMutation.mutate(key.id)}
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

      {/* Add Auth Method Dialog */}
      <Dialog open={addAuthDialogOpen} onOpenChange={setAddAuthDialogOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add Authentication Method</DialogTitle>
            <DialogDescription>
              Choose how clients will authenticate with {gatewayName}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Auth Type</Label>
              <Select value={newAuthType} onValueChange={(v) => { setNewAuthType(v); setNewAuthConfig({}) }}>
                <SelectTrigger className="mt-1">
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
              {newAuthType && (
                <p className="text-xs text-muted-foreground mt-1">{AUTH_TYPE_DESCRIPTIONS[newAuthType]}</p>
              )}
            </div>
            {newAuthType && renderAuthConfigFields()}
            <Button
              className="w-full"
              onClick={handleAddAuth}
              disabled={!newAuthType || createAuthConfigMutation.isPending}
            >
              {createAuthConfigMutation.isPending ? 'Adding...' : 'Add Auth Method'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Generate Key Dialog */}
      <Dialog open={generateDialogOpen} onOpenChange={setGenerateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Generate API Key</DialogTitle>
            <DialogDescription>
              Create a new API key for {gatewayName}. The key will only be shown once.
            </DialogDescription>
          </DialogHeader>
          {generatedKey ? (
            <div className="space-y-4">
              <div>
                <Label>Your API Key</Label>
                <div className="flex gap-2 mt-1">
                  <Input value={generatedKey} readOnly className="font-mono text-xs" />
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label="Copy gateway API key"
                    onClick={async () => {
                      await copySensitive(generatedKey, 'Gateway API key')
                      setCopied(true)
                      setTimeout(() => setCopied(false), 2000)
                    }}
                  >
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
                <p className="text-xs text-destructive mt-2">
                  Save this key now. It will not be shown again.
                </p>
              </div>
              <Button className="w-full" onClick={() => setGenerateDialogOpen(false)}>
                Done
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <Label>Key Name</Label>
                <Input
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  placeholder="e.g. Production, CI/CD, Development"
                  className="mt-1"
                />
              </div>
              <Button
                className="w-full"
                onClick={() => generateKeyMutation.mutate(newKeyName || `${gatewayName} Key`)}
                disabled={generateKeyMutation.isPending}
              >
                {generateKeyMutation.isPending ? 'Generating...' : 'Generate Key'}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Auth Config Confirmation */}
      <AlertDialog open={!!deleteAuthId} onOpenChange={(open) => !open && setDeleteAuthId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Authentication Method</AlertDialogTitle>
            <AlertDialogDescription>
              Clients using this authentication method will no longer be able to access the gateway. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteAuthId && deleteAuthConfigMutation.mutate(deleteAuthId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteAuthConfigMutation.isPending ? 'Removing...' : 'Remove'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
