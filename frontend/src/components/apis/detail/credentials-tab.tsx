/**
 * CredentialsTab — upstream credentials section for an API.
 *
 * Renders a list of stored credentials (API key, bearer token, basic auth,
 * OAuth2, JWT, custom header) and provides add/test/delete flows. Used by
 * the API detail page (`pages/api-detail.tsx`).
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Key, Shield, TestTube, Trash2 } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
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

import { apisApi } from '@/lib/api'
import { useNotifications } from '@/store/app'
import { ApiCredential } from '@/types'

const CREDENTIAL_TYPE_LABELS: Record<string, string> = {
  API_KEY: 'API Key',
  BEARER_TOKEN: 'Bearer Token',
  BASIC_AUTH: 'Basic Auth',
  OAUTH2: 'OAuth 2.0',
  JWT: 'JWT',
  CUSTOM: 'Custom',
}

interface CredentialsTabProps {
  apiId: string
  apiName: string
}

export function CredentialsTab({ apiId, apiName }: CredentialsTabProps) {
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [newCredType, setNewCredType] = useState('')
  const [newCredName, setNewCredName] = useState('')
  const [newCredConfig, setNewCredConfig] = useState<Record<string, string>>({})

  const { data: credsData, isLoading } = useQuery({
    queryKey: ['api-credentials', apiId],
    queryFn: () => apisApi.getCredentials(apiId),
    enabled: !!apiId,
  })

  const createMutation = useMutation({
    mutationFn: (data: { name: string; type: string; config: Record<string, string> }) => apisApi.createCredential(apiId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['api-credentials', apiId] })
      success('Credential Added', 'Credential has been securely stored')
      setAddDialogOpen(false)
      setNewCredType('')
      setNewCredName('')
      setNewCredConfig({})
    },
    onError: (err: Error & { response?: { data?: { message?: string } } }) => {
      errorNotif('Failed to add credential', err.response?.data?.message || 'Please try again')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (credId: string) => apisApi.deleteCredential(apiId, credId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['api-credentials', apiId] })
      success('Credential Deleted', 'Credential has been removed')
      setDeleteId(null)
    },
    onError: (err: Error & { response?: { data?: { message?: string } } }) => {
      errorNotif('Failed to delete', err.response?.data?.message || 'Please try again')
    },
  })

  const testMutation = useMutation({
    mutationFn: (credId: string) => apisApi.testCredential(apiId, credId),
    onSuccess: () => {
      success('Credential Valid', 'Test request succeeded')
    },
    onError: (err: Error & { response?: { data?: { message?: string } } }) => {
      errorNotif('Test Failed', err.response?.data?.message || 'Credential may be invalid')
    },
  })

  const credsRaw = credsData?.credentials || credsData || []
  const credentials = Array.isArray(credsRaw) ? credsRaw : []

  const handleCreate = () => {
    createMutation.mutate({
      name: newCredName || `${apiName} ${CREDENTIAL_TYPE_LABELS[newCredType] || newCredType}`,
      type: newCredType,
      config: newCredConfig,
    })
  }

  const renderConfigFields = () => {
    switch (newCredType) {
      case 'API_KEY':
        return (
          <>
            <div>
              <Label>API Key</Label>
              <Input
                type="password"
                value={newCredConfig.apiKey || ''}
                onChange={e => setNewCredConfig({ ...newCredConfig, apiKey: e.target.value })}
                placeholder="sk-..."
                className="mt-1"
              />
            </div>
            <div>
              <Label>Header Name</Label>
              <Input
                value={newCredConfig.headerName || ''}
                onChange={e => setNewCredConfig({ ...newCredConfig, headerName: e.target.value })}
                placeholder="X-API-Key (default)"
                className="mt-1"
              />
            </div>
          </>
        )
      case 'BEARER_TOKEN':
        return (
          <div>
            <Label>Bearer Token</Label>
            <Input
              type="password"
              value={newCredConfig.token || ''}
              onChange={e => setNewCredConfig({ ...newCredConfig, token: e.target.value })}
              placeholder="Enter token"
              className="mt-1"
            />
          </div>
        )
      case 'BASIC_AUTH':
        return (
          <>
            <div>
              <Label>Username</Label>
              <Input
                value={newCredConfig.username || ''}
                onChange={e => setNewCredConfig({ ...newCredConfig, username: e.target.value })}
                placeholder="Username"
                className="mt-1"
              />
            </div>
            <div>
              <Label>Password</Label>
              <Input
                type="password"
                value={newCredConfig.password || ''}
                onChange={e => setNewCredConfig({ ...newCredConfig, password: e.target.value })}
                placeholder="Password"
                className="mt-1"
              />
            </div>
          </>
        )
      case 'OAUTH2':
        return (
          <>
            <div>
              <Label>Client ID</Label>
              <Input
                value={newCredConfig.clientId || ''}
                onChange={e => setNewCredConfig({ ...newCredConfig, clientId: e.target.value })}
                placeholder="OAuth client ID"
                className="mt-1"
              />
            </div>
            <div>
              <Label>Client Secret</Label>
              <Input
                type="password"
                value={newCredConfig.clientSecret || ''}
                onChange={e => setNewCredConfig({ ...newCredConfig, clientSecret: e.target.value })}
                placeholder="OAuth client secret"
                className="mt-1"
              />
            </div>
            <div>
              <Label>Token Endpoint</Label>
              <Input
                value={newCredConfig.tokenUrl || ''}
                onChange={e => setNewCredConfig({ ...newCredConfig, tokenUrl: e.target.value })}
                placeholder="https://oauth.example.com/token"
                className="mt-1"
              />
            </div>
            <div>
              <Label>Access Token</Label>
              <Input
                type="password"
                value={newCredConfig.accessToken || ''}
                onChange={e => setNewCredConfig({ ...newCredConfig, accessToken: e.target.value })}
                placeholder="Current access token (if you have one)"
                className="mt-1"
              />
            </div>
            <div>
              <Label>Refresh Token</Label>
              <Input
                type="password"
                value={newCredConfig.refreshToken || ''}
                onChange={e => setNewCredConfig({ ...newCredConfig, refreshToken: e.target.value })}
                placeholder="Refresh token (for auto-renewal)"
                className="mt-1"
              />
            </div>
          </>
        )
      case 'JWT':
        return (
          <>
            <div>
              <Label>JWT Token</Label>
              <Input
                type="password"
                value={newCredConfig.token || ''}
                onChange={e => setNewCredConfig({ ...newCredConfig, token: e.target.value })}
                placeholder="eyJhbGciOiJIUzI1NiIs..."
                className="mt-1"
              />
            </div>
            <div>
              <Label>Header Name</Label>
              <Input
                value={newCredConfig.headerName || ''}
                onChange={e => setNewCredConfig({ ...newCredConfig, headerName: e.target.value })}
                placeholder="Authorization (default)"
                className="mt-1"
              />
            </div>
          </>
        )
      case 'CUSTOM':
        return (
          <>
            <div>
              <Label>Header Name</Label>
              <Input
                value={newCredConfig.headerName || ''}
                onChange={e => setNewCredConfig({ ...newCredConfig, headerName: e.target.value })}
                placeholder="X-Custom-Header"
                className="mt-1"
              />
            </div>
            <div>
              <Label>Header Value</Label>
              <Input
                type="password"
                value={newCredConfig.headerValue || ''}
                onChange={e => setNewCredConfig({ ...newCredConfig, headerValue: e.target.value })}
                placeholder="Custom header value"
                className="mt-1"
              />
            </div>
          </>
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
            <CardTitle className="flex items-center gap-2 text-sm">
              <Shield className="h-4 w-4" />
              Upstream Credentials
            </CardTitle>
            <CardDescription>
              Credentials used when tools call this API. Encrypted at rest.
            </CardDescription>
          </div>
          <Button
            size="sm"
            onClick={() => {
              setNewCredType('')
              setNewCredName('')
              setNewCredConfig({})
              setAddDialogOpen(true)
            }}
          >
            <Plus className="h-4 w-4 mr-1" />
            Add Credential
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex justify-center py-4"><LoadingSpinner /></div>
        ) : credentials.length === 0 ? (
          <div className="text-center py-4 text-muted-foreground text-sm">
            No credentials configured. Tools will call this API without authentication.
          </div>
        ) : (
          <div className="space-y-2">
            {credentials.map((cred: ApiCredential) => (
              <div key={cred.id} className="flex items-center justify-between px-3 py-2 bg-muted rounded-lg">
                <div className="flex items-center gap-3">
                  <Key className="h-4 w-4 text-muted-foreground" />
                  <Badge variant="outline">{CREDENTIAL_TYPE_LABELS[cred.type] || cred.type}</Badge>
                  <span className="text-sm font-medium">{cred.name}</span>
                  {cred.isExpired && <Badge variant="destructive">Expired</Badge>}
                </div>
                <div className="flex items-center gap-2">
                  {cred.lastUsedAt && (
                    <span className="text-xs text-muted-foreground">
                      Used {new Date(cred.lastUsedAt).toLocaleDateString()}
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => testMutation.mutate(cred.id)}
                    disabled={testMutation.isPending}
                  >
                    <TestTube className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setDeleteId(cred.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      {/* Add Credential Dialog */}
      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add Credential</DialogTitle>
            <DialogDescription>
              Store credentials for authenticating with {apiName}. Sensitive values are encrypted.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Name</Label>
              <Input
                value={newCredName}
                onChange={e => setNewCredName(e.target.value)}
                placeholder="e.g. Production API Key"
                className="mt-1"
              />
            </div>
            <div>
              <Label>Type</Label>
              <Select value={newCredType} onValueChange={v => { setNewCredType(v); setNewCredConfig({}) }}>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Select credential type" />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(CREDENTIAL_TYPE_LABELS).map(([type, label]) => (
                    <SelectItem key={type} value={type}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {newCredType && renderConfigFields()}
            <Button
              className="w-full"
              onClick={handleCreate}
              disabled={!newCredType || createMutation.isPending}
            >
              {createMutation.isPending ? 'Saving...' : 'Save Credential'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteId} onOpenChange={open => !open && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Credential</AlertDialogTitle>
            <AlertDialogDescription>
              Tools using this credential will no longer be able to authenticate with the API.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteId && deleteMutation.mutate(deleteId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
