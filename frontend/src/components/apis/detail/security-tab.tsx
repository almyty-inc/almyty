/**
 * SecurityTab — configure upstream authentication for an API.
 *
 * Renders a controlled dialog with type-specific fields (API key, bearer
 * token, basic auth, OAuth2) and persists changes via `apisApi.update`.
 * Used by the API detail page (`pages/api-detail.tsx`); the parent owns
 * the open state because the trigger lives in the configuration card.
 */
import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

import { apisApi } from '@/lib/api'
import { useNotifications } from '@/store/app'
import { Api, ApiAuthType } from '@/types'
import { getApiErrorMessage } from '@/lib/api-error'

interface SecurityTabProps {
  api: Api
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SecurityTab({ api, open, onOpenChange }: SecurityTabProps) {
  const queryClient = useQueryClient()
  const { success, error } = useNotifications()
  const [authType, setAuthType] = useState<ApiAuthType>(ApiAuthType.NONE)
  const [authConfig, setAuthConfig] = useState<Record<string, string>>({})

  // Initialize auth state when API loads or changes
  useEffect(() => {
    if (api) {
      setAuthType(api.authentication?.type || ApiAuthType.NONE)
      setAuthConfig(api.authentication?.config || {})
    }
  }, [api])

  const handleSave = async () => {
    try {
      await apisApi.update(api.id, {
        authentication: { type: authType, config: authConfig },
      })
      queryClient.invalidateQueries({ queryKey: ['api', api.id] })
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      success('Authentication updated', 'API authentication settings saved')
      onOpenChange(false)
    } catch (err: any) {
      error('Failed to update', getApiErrorMessage(err, 'Please try again.'))
    }
  }

  const handleCancel = () => {
    onOpenChange(false)
    setAuthType(api.authentication?.type || ApiAuthType.NONE)
    setAuthConfig(api.authentication?.config || {})
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Configure authentication</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="apisec-authentication-type">Authentication Type</Label>
            <Select value={authType} onValueChange={(value) => setAuthType(value as ApiAuthType)}>
              <SelectTrigger id="apisec-authentication-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ApiAuthType.NONE}>No Authentication</SelectItem>
                <SelectItem value={ApiAuthType.API_KEY}>API Key</SelectItem>
                <SelectItem value={ApiAuthType.BEARER_TOKEN}>Bearer Token</SelectItem>
                <SelectItem value={ApiAuthType.BASIC_AUTH}>Basic Auth</SelectItem>
                <SelectItem value={ApiAuthType.OAUTH2}>OAuth 2.0</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {authType === ApiAuthType.API_KEY && (
            <>
              <div>
                <Label htmlFor="apisec-header-name">Header Name</Label>
                <Input id="apisec-header-name"
                  placeholder="X-API-Key"
                  value={authConfig.headerName || ''}
                  onChange={(e) => setAuthConfig({...authConfig, headerName: e.target.value})}
                />
              </div>
              <div>
                <Label htmlFor="apisec-api-key">API Key</Label>
                <Input id="apisec-api-key"
                  type="password"
                  placeholder="Enter API key"
                  value={authConfig.apiKey || ''}
                  onChange={(e) => setAuthConfig({...authConfig, apiKey: e.target.value})}
                />
              </div>
            </>
          )}

          {authType === ApiAuthType.BEARER_TOKEN && (
            <div>
              <Label htmlFor="apisec-bearer-token">Bearer Token</Label>
              <Input id="apisec-bearer-token"
                type="password"
                placeholder="Enter bearer token"
                value={authConfig.token || ''}
                onChange={(e) => setAuthConfig({...authConfig, token: e.target.value})}
              />
            </div>
          )}

          {authType === ApiAuthType.BASIC_AUTH && (
            <>
              <div>
                <Label htmlFor="apisec-username">Username</Label>
                <Input id="apisec-username"
                  placeholder="Enter username"
                  value={authConfig.username || ''}
                  onChange={(e) => setAuthConfig({...authConfig, username: e.target.value})}
                />
              </div>
              <div>
                <Label htmlFor="apisec-password">Password</Label>
                <Input id="apisec-password"
                  type="password"
                  placeholder="Enter password"
                  value={authConfig.password || ''}
                  onChange={(e) => setAuthConfig({...authConfig, password: e.target.value})}
                />
              </div>
            </>
          )}

          {authType === ApiAuthType.OAUTH2 && (
            <>
              <div>
                <Label htmlFor="apisec-client-id">Client ID</Label>
                <Input id="apisec-client-id"
                  placeholder="Enter OAuth client ID"
                  value={authConfig.clientId || ''}
                  onChange={(e) => setAuthConfig({...authConfig, clientId: e.target.value})}
                />
              </div>
              <div>
                <Label htmlFor="apisec-client-secret">Client Secret</Label>
                <Input id="apisec-client-secret"
                  type="password"
                  placeholder="Enter client secret"
                  value={authConfig.clientSecret || ''}
                  onChange={(e) => setAuthConfig({...authConfig, clientSecret: e.target.value})}
                />
              </div>
              <div>
                <Label htmlFor="apisec-token-url">Token URL</Label>
                <Input id="apisec-token-url"
                  placeholder="https://oauth.example.com/token"
                  value={authConfig.tokenUrl || ''}
                  onChange={(e) => setAuthConfig({...authConfig, tokenUrl: e.target.value})}
                />
              </div>
              <div>
                <Label htmlFor="apisec-authorization-url">Authorization URL (Optional)</Label>
                <Input id="apisec-authorization-url"
                  placeholder="https://oauth.example.com/authorize"
                  value={authConfig.authUrl || ''}
                  onChange={(e) => setAuthConfig({...authConfig, authUrl: e.target.value})}
                />
              </div>
            </>
          )}

          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={handleCancel}>
              Cancel
            </Button>
            <Button onClick={handleSave}>
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
