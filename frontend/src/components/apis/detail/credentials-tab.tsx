/**
 * CredentialsTab — upstream credentials section for an API.
 *
 * Renders a list of stored credentials (API key, bearer token, basic auth,
 * OAuth2, JWT, custom header) and provides add/test/delete flows. "Add
 * credential" opens a form in place at the top of the section; delete
 * asks through a one-line confirmation. Used by the API detail page
 * (`pages/api-detail.tsx`).
 */
import { useState, type ChangeEvent, type FormEvent } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Key, Shield, TestTube, Trash2 } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { SecretInput } from '@/components/ui/secret-input'
import { Field, InlineFormActions } from '@/components/layout/form-page'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
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
import { getApiErrorMessage } from '@/lib/api-error'

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
  const [adding, setAdding] = useState(false)
  const [typeError, setTypeError] = useState<string | undefined>()
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [newCredType, setNewCredType] = useState('')
  const [newCredName, setNewCredName] = useState('')
  const [newCredConfig, setNewCredConfig] = useState<Record<string, string>>({})
  // A credential with anything chosen or typed in asks before a navigation
  // throws it away. Cancel closes the form and a successful add resets it,
  // so neither asks.
  const guard = useLeaveGuard(
    adding && (newCredType !== '' || newCredName !== '' || Object.values(newCredConfig).some((v) => v !== '')),
  )

  const { data: credsData, isLoading } = useQuery({
    queryKey: ['api-credentials', apiId],
    queryFn: () => apisApi.getCredentials(apiId),
    enabled: !!apiId,
  })

  const createMutation = useMutation({
    mutationFn: (data: { name: string; type: string; config: Record<string, string> }) => apisApi.createCredential(apiId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['api-credentials', apiId] })
      success('Credential added', 'Credential has been securely stored')
      setAdding(false)
      setNewCredType('')
      setNewCredName('')
      setNewCredConfig({})
    },
    onError: (err: Error & { response?: { data?: { message?: string } } }) => {
      errorNotif('Failed to add credential', getApiErrorMessage(err, 'Please try again'))
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (credId: string) => apisApi.deleteCredential(apiId, credId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['api-credentials', apiId] })
      success('Credential deleted', 'Credential has been removed')
      setDeleteId(null)
    },
    onError: (err: Error & { response?: { data?: { message?: string } } }) => {
      errorNotif('Failed to delete', getApiErrorMessage(err, 'Please try again'))
    },
  })

  const testMutation = useMutation({
    mutationFn: (credId: string) => apisApi.testCredential(apiId, credId),
    onSuccess: () => {
      success('Credential Valid', 'Test request succeeded')
    },
    onError: (err: Error & { response?: { data?: { message?: string } } }) => {
      errorNotif('Test Failed', getApiErrorMessage(err, 'Credential may be invalid'))
    },
  })

  const credsRaw = credsData?.credentials || credsData || []
  const credentials = Array.isArray(credsRaw) ? credsRaw : []

  const handleCreate = (e: FormEvent) => {
    e.preventDefault()
    if (!newCredType) {
      setTypeError('Choose the kind of credential the API expects.')
      document.getElementById('cred-type')?.focus()
      return
    }
    createMutation.mutate({
      name: newCredName || `${apiName} ${CREDENTIAL_TYPE_LABELS[newCredType] || newCredType}`,
      type: newCredType,
      config: newCredConfig,
    })
  }

  const setConfig = (key: string) => (e: ChangeEvent<HTMLInputElement>) =>
    setNewCredConfig({ ...newCredConfig, [key]: e.target.value })
  const value = (key: string) => newCredConfig[key] || ''

  const renderConfigFields = () => {
    switch (newCredType) {
      case 'API_KEY':
        return (
          <>
            <Field id="cred-api-key" label="API key">
              <SecretInput value={value('apiKey')} onChange={setConfig('apiKey')} placeholder="sk-..." />
            </Field>
            <Field id="cred-header-name" label="Header name">
              <Input value={value('headerName')} onChange={setConfig('headerName')} placeholder="X-API-Key (default)" />
            </Field>
          </>
        )
      case 'BEARER_TOKEN':
        return (
          <Field id="cred-bearer-token" label="Bearer token">
            <SecretInput value={value('token')} onChange={setConfig('token')} placeholder="Enter token" />
          </Field>
        )
      case 'BASIC_AUTH':
        return (
          <>
            <Field id="cred-username" label="Username">
              <SecretInput masked={false} value={value('username')} onChange={setConfig('username')} placeholder="Username" />
            </Field>
            <Field id="cred-password" label="Password">
              <SecretInput value={value('password')} onChange={setConfig('password')} placeholder="Password" />
            </Field>
          </>
        )
      case 'OAUTH2':
        return (
          <>
            <Field id="cred-client-id" label="Client ID">
              <SecretInput masked={false} value={value('clientId')} onChange={setConfig('clientId')} placeholder="OAuth client ID" />
            </Field>
            <Field id="cred-client-secret" label="Client secret">
              <SecretInput value={value('clientSecret')} onChange={setConfig('clientSecret')} placeholder="OAuth client secret" />
            </Field>
            <Field id="cred-token-endpoint" label="Token endpoint">
              <Input value={value('tokenUrl')} onChange={setConfig('tokenUrl')} placeholder="https://oauth.example.com/token" />
            </Field>
            <Field id="cred-access-token" label="Access token">
              <SecretInput value={value('accessToken')} onChange={setConfig('accessToken')} placeholder="Current access token (if you have one)" />
            </Field>
            <Field id="cred-refresh-token" label="Refresh token">
              <SecretInput value={value('refreshToken')} onChange={setConfig('refreshToken')} placeholder="Refresh token (for auto-renewal)" />
            </Field>
          </>
        )
      case 'JWT':
        return (
          <>
            <Field id="cred-jwt-token" label="JWT">
              <SecretInput value={value('token')} onChange={setConfig('token')} placeholder="eyJhbGciOiJIUzI1NiIs..." />
            </Field>
            <Field id="cred-header-name-2" label="Header name">
              <Input value={value('headerName')} onChange={setConfig('headerName')} placeholder="Authorization (default)" />
            </Field>
          </>
        )
      case 'CUSTOM':
        return (
          <>
            <Field id="cred-header-name-3" label="Header name">
              <Input value={value('headerName')} onChange={setConfig('headerName')} placeholder="X-Custom-Header" />
            </Field>
            <Field id="cred-header-value" label="Header value">
              <SecretInput value={value('headerValue')} onChange={setConfig('headerValue')} placeholder="Custom header value" />
            </Field>
          </>
        )
      default:
        return null
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Shield className="h-4 w-4" />
              Upstream credentials
            </CardTitle>
            <CardDescription>
              Credentials used when tools call this API. Encrypted at rest.
            </CardDescription>
          </div>
          {!adding && (
            <Button
              size="sm"
              className="shrink-0"
              onClick={() => {
                setNewCredType('')
                setNewCredName('')
                setNewCredConfig({})
                setTypeError(undefined)
                setAdding(true)
              }}
            >
              <Plus className="h-4 w-4 mr-1" />
              Add credential
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {adding && (
          <form
            onSubmit={handleCreate}
            noValidate
            aria-label="Add credential"
            className="space-y-4 rounded-lg border p-4"
            data-testid="add-credential-form"
          >
            <p className="text-sm text-muted-foreground">
              Store credentials for authenticating with {apiName}. Sensitive values are encrypted.
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field id="cred-name" label="Name" hint="Defaults to the API and credential type.">
                <Input value={newCredName} onChange={e => setNewCredName(e.target.value)} placeholder="e.g. Production API key" />
              </Field>
              <Field id="cred-type" label="Type" error={typeError} required>
                <Select value={newCredType} onValueChange={v => { setNewCredType(v); setNewCredConfig({}); setTypeError(undefined) }}>
                  <SelectTrigger id="cred-type" aria-invalid={typeError ? true : undefined} aria-describedby={typeError ? "cred-type-error" : undefined}>
                    <SelectValue placeholder="Select credential type" />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(CREDENTIAL_TYPE_LABELS).map(([type, label]) => (
                      <SelectItem key={type} value={type}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            {newCredType && <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{renderConfigFields()}</div>}
            <InlineFormActions
              onCancel={() => setAdding(false)}
              submitLabel="Save credential"
              submitting={createMutation.isPending}
            />
          </form>
        )}
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
                    aria-label={`Test credential ${cred.name}`}
                    onClick={() => testMutation.mutate(cred.id)}
                    disabled={testMutation.isPending}
                  >
                    <TestTube className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Delete credential ${cred.name}`}
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

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteId} onOpenChange={open => !open && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this credential?</AlertDialogTitle>
            <AlertDialogDescription>
              Tools using this credential will no longer be able to authenticate with the API.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteId && deleteMutation.mutate(deleteId)}
              variant="destructive"
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete credential'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {guard.element}
    </Card>
  )
}
