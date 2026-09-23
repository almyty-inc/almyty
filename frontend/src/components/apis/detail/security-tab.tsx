/**
 * SecurityTab — upstream authentication for an API, inline on the API
 * detail page.
 *
 * Shows the configured method; "Edit" (here, or on the overview's
 * Authentication row) turns the section into a form with type-specific
 * fields (API key, bearer token, basic auth, OAuth2) that saves through
 * `apisApi.update`. The parent owns `editing` because the overview's
 * Authentication row opens it too.
 */
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Edit, Lock } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { SecretInput } from '@/components/ui/secret-input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Field, InlineFormActions } from '@/components/layout/form-page'

import { apisApi } from '@/lib/api'
import { useNotifications } from '@/store/app'
import { Api, ApiAuthType } from '@/types'
import { getApiErrorMessage } from '@/lib/api-error'

const AUTH_LABELS: Record<string, string> = {
  [ApiAuthType.NONE]: 'No authentication',
  [ApiAuthType.API_KEY]: 'API key',
  [ApiAuthType.BEARER_TOKEN]: 'Bearer token',
  [ApiAuthType.BASIC_AUTH]: 'Basic auth',
  [ApiAuthType.OAUTH2]: 'OAuth 2.0',
  [ApiAuthType.CUSTOM]: 'Custom',
}

interface SecurityTabProps {
  api: Api
  editing: boolean
  onEditingChange: (editing: boolean) => void
}

export function SecurityTab({ api, editing, onEditingChange }: SecurityTabProps) {
  const queryClient = useQueryClient()
  const { success, error } = useNotifications()
  const [authType, setAuthType] = useState<ApiAuthType>(ApiAuthType.NONE)
  const [authConfig, setAuthConfig] = useState<Record<string, string>>({})
  const sectionRef = useRef<HTMLDivElement>(null)

  // Seed the form from the saved settings each time editing starts. Only
  // on that edge: the parent rebuilds `api` every render, and re-seeding
  // on it would wipe what the user is typing.
  useEffect(() => {
    if (editing) {
      setAuthType(api.authentication?.type || ApiAuthType.NONE)
      setAuthConfig(api.authentication?.config || {})
      sectionRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing])

  const saveMutation = useMutation({
    mutationFn: () =>
      apisApi.update(api.id, {
        authentication: { type: authType, config: authConfig },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['api', api.id] })
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      success('Authentication updated', 'API authentication settings saved')
      onEditingChange(false)
    },
    onError: (err: unknown) => {
      error('Failed to update', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    saveMutation.mutate()
  }

  const set = (key: string) => (e: ChangeEvent<HTMLInputElement>) =>
    setAuthConfig({ ...authConfig, [key]: e.target.value })

  const currentType = api.authentication?.type || ApiAuthType.NONE

  return (
    <Card ref={sectionRef} id="api-authentication">
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Lock className="h-4 w-4" />
            Authentication
          </CardTitle>
          <CardDescription>How tools authenticate when they call this API.</CardDescription>
        </div>
        {!editing && (
          <Button size="sm" variant="outline" onClick={() => onEditingChange(true)}>
            <Edit className="mr-1 h-4 w-4" />
            Edit
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {!editing ? (
          <p className="text-sm" data-testid="api-auth-summary">
            {AUTH_LABELS[currentType] ?? currentType}
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4" noValidate aria-label="Configure authentication">
            <Field id="apisec-authentication-type" label="Authentication type">
              <Select value={authType} onValueChange={(value) => setAuthType(value as ApiAuthType)}>
                <SelectTrigger id="apisec-authentication-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ApiAuthType.NONE}>No authentication</SelectItem>
                  <SelectItem value={ApiAuthType.API_KEY}>API key</SelectItem>
                  <SelectItem value={ApiAuthType.BEARER_TOKEN}>Bearer token</SelectItem>
                  <SelectItem value={ApiAuthType.BASIC_AUTH}>Basic auth</SelectItem>
                  <SelectItem value={ApiAuthType.OAUTH2}>OAuth 2.0</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            {authType === ApiAuthType.API_KEY && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field id="apisec-header-name" label="Header name" hint="The request header the key is sent in.">
                  <Input placeholder="X-API-Key" value={authConfig.headerName || ''} onChange={set('headerName')} />
                </Field>
                <Field id="apisec-api-key" label="API key">
                  <SecretInput placeholder="Enter API key" value={authConfig.apiKey || ''} onChange={set('apiKey')} />
                </Field>
              </div>
            )}

            {authType === ApiAuthType.BEARER_TOKEN && (
              <Field id="apisec-bearer-token" label="Bearer token">
                <SecretInput placeholder="Enter bearer token" value={authConfig.token || ''} onChange={set('token')} />
              </Field>
            )}

            {authType === ApiAuthType.BASIC_AUTH && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field id="apisec-username" label="Username">
                  <SecretInput masked={false} placeholder="Enter username" value={authConfig.username || ''} onChange={set('username')} />
                </Field>
                <Field id="apisec-password" label="Password">
                  <SecretInput placeholder="Enter password" value={authConfig.password || ''} onChange={set('password')} />
                </Field>
              </div>
            )}

            {authType === ApiAuthType.OAUTH2 && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field id="apisec-client-id" label="Client ID" hint="From the provider's OAuth app settings.">
                  <SecretInput masked={false} placeholder="Enter OAuth client ID" value={authConfig.clientId || ''} onChange={set('clientId')} />
                </Field>
                <Field id="apisec-client-secret" label="Client secret">
                  <SecretInput placeholder="Enter client secret" value={authConfig.clientSecret || ''} onChange={set('clientSecret')} />
                </Field>
                <Field id="apisec-token-url" label="Token URL">
                  <Input placeholder="https://oauth.example.com/token" value={authConfig.tokenUrl || ''} onChange={set('tokenUrl')} />
                </Field>
                <Field id="apisec-authorization-url" label="Authorization URL (optional)">
                  <Input placeholder="https://oauth.example.com/authorize" value={authConfig.authUrl || ''} onChange={set('authUrl')} />
                </Field>
              </div>
            )}

            <InlineFormActions onCancel={() => onEditingChange(false)} submitting={saveMutation.isPending} />
          </form>
        )}
      </CardContent>
    </Card>
  )
}
