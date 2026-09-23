/**
 * apis/api-form -- the Connect API and Edit API page body.
 *
 * Step 1 of connecting an API: its name, type, address, upstream
 * authentication and visibility. Creating an OpenAPI, GraphQL, SOAP or
 * gRPC API then lands on `/apis/:id/import` (step 2, the schema import),
 * so an import the user walks away from resumes from the API's own page.
 * Custom HTTP and SDK APIs have no schema to import and go straight to
 * the API. Editing an existing API is the same form at `/apis/:id/edit`.
 */
import React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Cloud, Database, Globe, Package, Plus, Server, Webhook, XCircle } from 'lucide-react'

import { Field, FormPage, FormSection } from '@/components/layout/form-page'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SecretInput } from '@/components/ui/secret-input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { CredentialPicker } from '@/components/credential-picker'
import { VisibilityField, type VisibilityValue } from '@/components/ui/visibility-field'
import { useLeaveGuard } from '@/hooks/use-leave-guard'

import { apisApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import { Api, ApiAuthType, ApiType } from '@/types'

import {
  createApiSchema,
  type CreateApiFormData,
  type CreateApiFormInput,
} from './schema'

/** Types whose operations come from a schema: they continue to the import step. */
export const SCHEMA_API_TYPES: ApiType[] = [ApiType.OPENAPI, ApiType.GRAPHQL, ApiType.SOAP, ApiType.GRPC]

// Get supported auth methods per API type
export function getSupportedAuthMethods(apiType: ApiType): ApiAuthType[] {
  switch (apiType) {
    case ApiType.OPENAPI:
      return [ApiAuthType.NONE, ApiAuthType.API_KEY, ApiAuthType.BEARER_TOKEN, ApiAuthType.BASIC_AUTH, ApiAuthType.OAUTH2]
    case ApiType.GRAPHQL:
      return [ApiAuthType.NONE, ApiAuthType.API_KEY, ApiAuthType.BEARER_TOKEN]
    case ApiType.SOAP:
      return [ApiAuthType.NONE, ApiAuthType.BASIC_AUTH, ApiAuthType.CUSTOM]
    case ApiType.GRPC:
      return [ApiAuthType.NONE, ApiAuthType.BEARER_TOKEN, ApiAuthType.CUSTOM]
    case ApiType.HTTP:
      return [ApiAuthType.NONE, ApiAuthType.API_KEY, ApiAuthType.BEARER_TOKEN, ApiAuthType.BASIC_AUTH]
    case ApiType.SDK:
      return [ApiAuthType.NONE]
    default:
      return [ApiAuthType.NONE, ApiAuthType.CUSTOM]
  }
}

const AUTH_LABELS: Record<ApiAuthType, string> = {
  [ApiAuthType.NONE]: 'No authentication',
  [ApiAuthType.API_KEY]: 'API key',
  [ApiAuthType.BEARER_TOKEN]: 'Bearer token',
  [ApiAuthType.BASIC_AUTH]: 'Basic auth',
  [ApiAuthType.OAUTH2]: 'OAuth 2.0',
  [ApiAuthType.CUSTOM]: 'Custom',
} as Record<ApiAuthType, string>

function urlPlaceholder(apiType: ApiType): string {
  switch (apiType) {
    case ApiType.OPENAPI: return 'https://api.example.com/v1'
    case ApiType.GRAPHQL: return 'https://api.example.com/graphql'
    case ApiType.SOAP: return 'https://api.example.com/soap'
    case ApiType.GRPC: return 'grpc://api.example.com:443'
    default: return 'https://api.example.com'
  }
}

function urlHint(apiType: ApiType): string | undefined {
  switch (apiType) {
    case ApiType.GRPC: return 'gRPC uses the grpc:// protocol with a port number.'
    case ApiType.GRAPHQL: return 'GraphQL usually has a single /graphql endpoint.'
    case ApiType.SOAP: return 'SOAP services usually expose their WSDL at /soap or /?wsdl.'
    case ApiType.OPENAPI: return 'REST APIs can have versioned paths like /v1 or /api/v2.'
    case ApiType.HTTP: return 'Tools use paths relative to this URL.'
    default: return undefined
  }
}

const DEFAULT_VALUES: CreateApiFormInput = {
  name: '',
  baseUrl: '',
  description: '',
  version: '',
  type: ApiType.OPENAPI,
  authentication: { type: ApiAuthType.NONE, config: {} },
}

export function ApiForm({ editingApi }: { editingApi?: Api | null }) {
  const { success, error } = useNotifications()
  const queryClient = useQueryClient()
  const { currentOrganization } = useOrganizationStore()
  const isEdit = !!editingApi

  const createForm = useForm<CreateApiFormInput, any, CreateApiFormData>({
    resolver: zodResolver(createApiSchema),
    defaultValues: editingApi
      ? {
          name: editingApi.name,
          baseUrl: editingApi.baseUrl,
          type: editingApi.type,
          description: editingApi.description || '',
          version: editingApi.version || '',
          authentication: editingApi.authentication || { type: ApiAuthType.NONE, config: {} },
        }
      : DEFAULT_VALUES,
  })
  const { errors } = createForm.formState
  const selectedApiType = (createForm.watch('type') ?? ApiType.OPENAPI) as ApiType
  const authentication = createForm.watch('authentication')
  const selectedAuthType = (authentication?.type ?? ApiAuthType.NONE) as ApiAuthType
  const authConfig = (authentication?.config ?? {}) as Record<string, string>
  const setAuthConfig = (key: string, value: string) =>
    createForm.setValue(`authentication.config.${key}` as 'authentication.config', value as any, { shouldDirty: true })

  const [apiKeyCredentialId, setApiKeyCredentialId] = React.useState('')
  const [bearerCredentialId, setBearerCredentialId] = React.useState('')
  const [oauthCredentialId, setOauthCredentialId] = React.useState('')
  // SDK API creation state
  const [sdkPackages, setSdkPackages] = React.useState<Array<{ name: string; version: string }>>([])
  const [packagesError, setPackagesError] = React.useState<string | undefined>()
  const [newPkgName, setNewPkgName] = React.useState('')
  const [newPkgVersion, setNewPkgVersion] = React.useState('*')
  const [usePrivateRegistry, setUsePrivateRegistry] = React.useState(false)
  const [registryUrl, setRegistryUrl] = React.useState('')
  const [registryToken, setRegistryToken] = React.useState('')
  const [registryScope, setRegistryScope] = React.useState('')
  const initialVisibility: VisibilityValue = {
    visibility: editingApi?.visibility ?? 'org',
    teamId: editingApi?.teamId ?? null,
  }
  const [visibility, setVisibility] = React.useState<VisibilityValue>(initialVisibility)

  const dirty =
    createForm.formState.isDirty ||
    sdkPackages.length > 0 ||
    usePrivateRegistry ||
    visibility.visibility !== initialVisibility.visibility ||
    visibility.teamId !== initialVisibility.teamId
  const guard = useLeaveGuard(dirty)

  const createApiMutation = useMutation({
    mutationFn: apisApi.create,
    onSuccess: (response: Api) => {
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      success('API created', 'Now import a schema to generate its operations and tools.')
      // Step 2: the schema import, on the API's own route.
      guard.leave(response?.id ? `/apis/${response.id}/import?created=1` : '/apis')
    },
    onError: (err: any) => {
      error('Failed to create API', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  const updateApiMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Api> }) => apisApi.update(id, data),
    onSuccess: (_res, vars) => {
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      queryClient.invalidateQueries({ queryKey: ['api', vars.id] })
      success('API updated', 'API has been updated successfully.')
      guard.leave(`/apis/${vars.id}`)
    },
    onError: (err: any) => {
      error('Failed to update API', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  const createHttpApiMutation = useMutation({
    mutationFn: (data: any) => apisApi.createHttpApi(data),
    onSuccess: (response: any) => {
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      success('API created', 'Custom HTTP API has been created successfully.')
      guard.leave(response?.id ? `/apis/${response.id}` : '/apis')
    },
    onError: (err: any) => {
      error('Failed to create API', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  const createSdkApiMutation = useMutation({
    mutationFn: (data: any) => apisApi.createSdkApi(data),
    onSuccess: (response: any) => {
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      success('API created', 'SDK API has been created successfully. Packages are being analyzed.')
      guard.leave(response?.id ? `/apis/${response.id}` : '/apis')
    },
    onError: (err: any) => {
      error('Failed to create SDK API', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  const submitting =
    createApiMutation.isPending ||
    updateApiMutation.isPending ||
    createHttpApiMutation.isPending ||
    createSdkApiMutation.isPending

  const addPackage = () => {
    if (!newPkgName.trim()) return
    setSdkPackages([...sdkPackages, { name: newPkgName.trim(), version: newPkgVersion }])
    setNewPkgName('')
    setNewPkgVersion('*')
    setPackagesError(undefined)
  }

  const handleCreateApi = (data: CreateApiFormData) => {
    const visibilityFields = { visibility: visibility.visibility, teamId: visibility.teamId }
    if (editingApi) {
      // The type of an existing API cannot change.
      const { type: _type, ...updateData } = data
      updateApiMutation.mutate({ id: editingApi.id, data: { ...updateData, ...visibilityFields } as Partial<Api> })
    } else if (data.type === ApiType.SDK) {
      if (sdkPackages.length === 0) {
        setPackagesError('Add at least one npm package.')
        return
      }
      const dependencies: Record<string, string> = {}
      sdkPackages.forEach((pkg) => { dependencies[pkg.name] = pkg.version })
      const sdkData: any = {
        name: data.name,
        description: data.description,
        dependencies,
        ...visibilityFields,
      }
      if (usePrivateRegistry) {
        sdkData.npmRegistry = {
          url: registryUrl || undefined,
          token: registryToken || undefined,
          scope: registryScope || undefined,
        }
      }
      createSdkApiMutation.mutate(sdkData)
    } else if (data.type === ApiType.HTTP) {
      createHttpApiMutation.mutate({ ...data, ...visibilityFields })
    } else {
      createApiMutation.mutate({ ...data, ...visibilityFields })
    }
  }

  const willImport = !isEdit && SCHEMA_API_TYPES.includes(selectedApiType)

  return (
    <FormPage
      title={isEdit ? 'Edit API' : 'Connect API'}
      description={
        isEdit
          ? 'Update the API configuration and settings.'
          : 'Connect an existing API to automatically generate tools your agents can call.'
      }
      back={isEdit ? { to: `/apis/${editingApi!.id}`, label: editingApi!.name } : { to: '/apis', label: 'APIs' }}
      guard={guard}
      onSubmit={createForm.handleSubmit(handleCreateApi)}
      submitLabel={isEdit ? 'Save changes' : willImport ? 'Continue to schema import' : 'Connect API'}
      submitting={submitting}
      footerStart={
        willImport ? <span className="text-sm text-muted-foreground">Step 1 of 2</span> : undefined
      }
    >
      <FormSection title="API">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field id="api-name" label="API name" error={errors.name?.message} required>
            <Input placeholder="Enter API name" {...createForm.register('name')} />
          </Field>
          <Field
            id="api-type"
            label="API type"
            hint={isEdit ? 'The type of an existing API cannot change.' : undefined}
          >
            <Select
              disabled={isEdit}
              value={selectedApiType}
              onValueChange={(value) => {
                createForm.setValue('type', value as ApiType, { shouldDirty: true })
                // Auth methods differ per type.
                createForm.setValue('authentication', { type: ApiAuthType.NONE, config: {} }, { shouldDirty: true })
              }}
            >
              <SelectTrigger id="api-type">
                <SelectValue placeholder="Select API type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ApiType.OPENAPI}>
                  <div className="flex items-center space-x-2"><Globe className="h-4 w-4" /><span>OpenAPI/REST</span></div>
                </SelectItem>
                <SelectItem value={ApiType.GRAPHQL}>
                  <div className="flex items-center space-x-2"><Database className="h-4 w-4" /><span>GraphQL</span></div>
                </SelectItem>
                <SelectItem value={ApiType.SOAP}>
                  <div className="flex items-center space-x-2"><Cloud className="h-4 w-4" /><span>SOAP</span></div>
                </SelectItem>
                <SelectItem value={ApiType.GRPC}>
                  <div className="flex items-center space-x-2"><Server className="h-4 w-4" /><span>gRPC</span></div>
                </SelectItem>
                <SelectItem value={ApiType.HTTP}>
                  <div className="flex items-center space-x-2"><Webhook className="h-4 w-4" /><span>Custom HTTP</span></div>
                </SelectItem>
                <SelectItem value={ApiType.SDK}>
                  <div className="flex items-center space-x-2"><Package className="h-4 w-4" /><span>SDK / npm library</span></div>
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>

        {selectedApiType === ApiType.SDK ? (
          <div className="space-y-4">
            <Field
              id="sdk-package-name"
              label="Packages"
              hint={sdkPackages.length === 0 ? 'Add at least one npm package to create an SDK API.' : undefined}
              error={packagesError}
            >
              <div id="sdk-packages" className="rounded-lg border">
                {sdkPackages.length > 0 && (
                  <div className="divide-y">
                    {sdkPackages.map((pkg, idx) => (
                      <div key={idx} className="flex items-center gap-2 p-2">
                        <div className="min-w-0 flex-1 truncate font-mono text-sm">{pkg.name}</div>
                        <div className="w-24 text-sm text-muted-foreground">{pkg.version}</div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          aria-label={`Remove ${pkg.name}`}
                          onClick={() => setSdkPackages(sdkPackages.filter((_, i) => i !== idx))}
                        >
                          <XCircle className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-2 border-t p-2 first:border-t-0">
                  <Input
                    id="sdk-package-name"
                    aria-label="Package name"
                    placeholder="Package name (e.g. @aws-sdk/client-s3)"
                    value={newPkgName}
                    onChange={(e) => setNewPkgName(e.target.value)}
                    className="h-8 min-w-0 flex-1"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        addPackage()
                      }
                    }}
                  />
                  <Input
                    aria-label="Package version"
                    placeholder="Version"
                    value={newPkgVersion}
                    onChange={(e) => setNewPkgVersion(e.target.value)}
                    className="h-8 w-20 sm:w-32"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    aria-label="Add package"
                    onClick={addPackage}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </Field>

            <div className="flex items-center space-x-2">
              <Checkbox
                id="private-registry"
                checked={usePrivateRegistry}
                onCheckedChange={(checked) => setUsePrivateRegistry(checked === true)}
              />
              <Label htmlFor="private-registry" className="cursor-pointer text-sm font-normal">
                Use private npm registry
              </Label>
            </div>
            {usePrivateRegistry && (
              <div className="grid grid-cols-1 gap-4 rounded-lg border bg-muted/30 p-3 sm:grid-cols-2">
                <Field id="registry-url" label="Registry URL" className="sm:col-span-2">
                  <Input
                    placeholder="https://registry.example.com"
                    value={registryUrl}
                    onChange={(e) => setRegistryUrl(e.target.value)}
                  />
                </Field>
                <Field id="registry-token" label="Auth token" hint="An npm token with read access to the registry.">
                  <SecretInput
                    placeholder="npm auth token"
                    value={registryToken}
                    onChange={(e) => setRegistryToken(e.target.value)}
                  />
                </Field>
                <Field id="registry-scope" label="Scope (optional)">
                  <Input
                    placeholder="@myorg"
                    value={registryScope}
                    onChange={(e) => setRegistryScope(e.target.value)}
                  />
                </Field>
              </div>
            )}
          </div>
        ) : (
          <>
            <Field
              id="api-base-url"
              label={selectedApiType === ApiType.GRPC ? 'gRPC server address' : 'Base URL'}
              hint={urlHint(selectedApiType)}
              error={errors.baseUrl?.message}
              required
            >
              <Input placeholder={urlPlaceholder(selectedApiType)} {...createForm.register('baseUrl')} />
            </Field>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field id="api-version" label="Version (optional)">
                <Input placeholder="v1.0" {...createForm.register('version')} />
              </Field>
              <Field id="api-auth-type" label="Authentication">
                <Select
                  value={selectedAuthType}
                  onValueChange={(value) =>
                    createForm.setValue('authentication', { type: value as ApiAuthType, config: {} }, { shouldDirty: true })
                  }
                >
                  <SelectTrigger id="api-auth-type">
                    <SelectValue placeholder="Select auth type" />
                  </SelectTrigger>
                  <SelectContent>
                    {getSupportedAuthMethods(selectedApiType).map((authType) => (
                      <SelectItem key={authType} value={authType}>
                        {AUTH_LABELS[authType] ?? authType}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
          </>
        )}

        {selectedAuthType === ApiAuthType.API_KEY && (
          <div className="space-y-4">
            <CredentialPicker
              label="API key"
              value={apiKeyCredentialId}
              onSelect={(id) => {
                setApiKeyCredentialId(id)
                setAuthConfig('credentialId', id)
              }}
              onNewKey={(key) => setAuthConfig('apiKey', key)}
              newKeyValue=""
              filterType="api_key"
            />
            <Field id="api-header-name" label="Header name" hint="The request header the key is sent in.">
              <Input
                placeholder="X-API-Key"
                value={authConfig.headerName ?? ''}
                onChange={(e) => setAuthConfig('headerName', e.target.value)}
              />
            </Field>
          </div>
        )}

        {selectedAuthType === ApiAuthType.BEARER_TOKEN && (
          <CredentialPicker
            label="Bearer token"
            value={bearerCredentialId}
            onSelect={(id) => {
              setBearerCredentialId(id)
              setAuthConfig('credentialId', id)
            }}
            onNewKey={(key) => setAuthConfig('token', key)}
            newKeyValue=""
            placeholder="Enter bearer token"
            filterType="bearer_token"
          />
        )}

        {selectedAuthType === ApiAuthType.BASIC_AUTH && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field id="api-basic-username" label="Username">
              <SecretInput
                masked={false}
                placeholder="Enter username"
                value={authConfig.username ?? ''}
                onChange={(e) => setAuthConfig('username', e.target.value)}
              />
            </Field>
            <Field id="api-basic-password" label="Password">
              <SecretInput
                placeholder="Enter password"
                value={authConfig.password ?? ''}
                onChange={(e) => setAuthConfig('password', e.target.value)}
              />
            </Field>
          </div>
        )}

        {selectedAuthType === ApiAuthType.OAUTH2 && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field id="api-oauth-client-id" label="Client ID" hint="From the provider's OAuth app settings.">
                <SecretInput
                  masked={false}
                  placeholder="Your OAuth client ID"
                  value={authConfig.clientId ?? ''}
                  onChange={(e) => setAuthConfig('clientId', e.target.value)}
                />
              </Field>
              <CredentialPicker
                label="Client secret"
                value={oauthCredentialId}
                onSelect={(id) => {
                  setOauthCredentialId(id)
                  setAuthConfig('credentialId', id)
                }}
                onNewKey={(key) => setAuthConfig('clientSecret', key)}
                newKeyValue=""
                placeholder="Your OAuth client secret"
                filterType="oauth2"
              />
            </div>
            <Field id="api-oauth-auth-url" label="Authorization URL">
              <Input
                type="url"
                placeholder="https://api.example.com/oauth/authorize"
                value={authConfig.authUrl ?? ''}
                onChange={(e) => setAuthConfig('authUrl', e.target.value)}
              />
            </Field>
            <Field id="api-oauth-token-url" label="Token URL">
              <Input
                type="url"
                placeholder="https://api.example.com/oauth/token"
                value={authConfig.tokenUrl ?? ''}
                onChange={(e) => setAuthConfig('tokenUrl', e.target.value)}
              />
            </Field>
          </div>
        )}

        <Field id="api-description" label="Description (optional)" error={errors.description?.message}>
          <Textarea placeholder="Enter API description" {...createForm.register('description')} />
        </Field>
      </FormSection>

      <FormSection title="Visibility">
        <VisibilityField
          organizationId={currentOrganization?.id ?? ''}
          value={visibility}
          onChange={setVisibility}
          noun="this API"
        />
      </FormSection>
    </FormPage>
  )
}
