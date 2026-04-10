/**
 * apis/create-api-dialog — Connect / Edit API multi-step dialog.
 *
 * Owns the create form, all 4 create/update mutations (REST/OpenAPI,
 * HTTP, SDK, plus update), the auth-method picker, the SDK package
 * manager, and the inline schema-import second step. Used by
 * `pages/apis.tsx`.
 */
import React from 'react'
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  CheckCircle, Cloud, Database, FileText, Globe, Package, Plus,
  Server, Upload, Webhook, XCircle,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { CredentialPicker } from '@/components/credential-picker'

import { apisApi } from '@/lib/api'
import { useNotifications } from '@/store/app'
import { Api, ApiAuthType, ApiType } from '@/types'

import {
  createApiSchema,
  type CreateApiFormData,
  type CreateApiFormInput,
} from './schema'

interface CreateApiDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingApi: Api | null
  uploadFile: File | null
  setUploadFile: (file: File | null) => void
  importSchemaMutation: UseMutationResult<any, any, { id: string; data: any; file?: File }, unknown>
  onSelectApi: (api: Api | null) => void
}

// Get supported auth methods per API type
function getSupportedAuthMethods(apiType: ApiType): ApiAuthType[] {
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

// Get URL placeholder and validation per API type
function getUrlInfo(apiType: ApiType) {
  switch (apiType) {
    case ApiType.OPENAPI:
      return { placeholder: 'https://api.example.com/v1', pattern: /^https?:\/\/.+/ }
    case ApiType.GRAPHQL:
      return { placeholder: 'https://api.example.com/graphql', pattern: /^https?:\/\/.+/ }
    case ApiType.SOAP:
      return { placeholder: 'https://api.example.com/soap', pattern: /^https?:\/\/.+/ }
    case ApiType.GRPC:
      return { placeholder: 'grpc://api.example.com:443', pattern: /^grpc:\/\/.+:\d+$/ }
    case ApiType.HTTP:
      return { placeholder: 'https://api.example.com', pattern: /^https?:\/\/.+/ }
    case ApiType.SDK:
      return { placeholder: 'npm://package-name', pattern: /.*/ }
    default:
      return { placeholder: 'https://api.example.com', pattern: /^https?:\/\/.+/ }
  }
}

export function CreateApiDialog({
  open,
  onOpenChange,
  editingApi,
  uploadFile,
  setUploadFile,
  importSchemaMutation,
  onSelectApi,
}: CreateApiDialogProps) {
  const { success, error } = useNotifications()
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const [createStep, setCreateStep] = React.useState<'details' | 'schema'>('details')
  const [createdApiForSchema, setCreatedApiForSchema] = React.useState<Api | null>(null)
  const [selectedAuthType, setSelectedAuthType] = React.useState<ApiAuthType>(ApiAuthType.NONE)
  const [apiKeyCredentialId, setApiKeyCredentialId] = React.useState('')
  const [bearerCredentialId, setBearerCredentialId] = React.useState('')
  const [oauthCredentialId, setOauthCredentialId] = React.useState('')
  const [selectedApiType, setSelectedApiType] = React.useState<ApiType>(ApiType.OPENAPI)
  // SDK API creation state
  const [sdkPackages, setSdkPackages] = React.useState<Array<{ name: string; version: string }>>([])
  const [newPkgName, setNewPkgName] = React.useState('')
  const [newPkgVersion, setNewPkgVersion] = React.useState('*')
  const [usePrivateRegistry, setUsePrivateRegistry] = React.useState(false)
  const [registryUrl, setRegistryUrl] = React.useState('')
  const [registryToken, setRegistryToken] = React.useState('')
  const [registryScope, setRegistryScope] = React.useState('')

  const createApiMutation = useMutation({
    mutationFn: apisApi.create,
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      success('API created', 'API has been created successfully.')
      setCreatedApiForSchema(response)
      onSelectApi(response)
      setCreateStep('schema')
    },
    onError: (err: any) => {
      error('Failed to create API', err.response?.data?.message || 'Please try again.')
    },
  })

  const updateApiMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Api> }) =>
      apisApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      success('API updated', 'API has been updated successfully.')
      onOpenChange(false)
    },
    onError: (err: any) => {
      error('Failed to update API', err.response?.data?.message || 'Please try again.')
    },
  })

  const createHttpApiMutation = useMutation({
    mutationFn: (data: any) => apisApi.createHttpApi(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      success('API created', 'Custom HTTP API has been created successfully.')
      onOpenChange(false)
      setCreateStep('details')
    },
    onError: (err: any) => {
      error('Failed to create API', err.response?.data?.message || 'Please try again.')
    },
  })

  const createSdkApiMutation = useMutation({
    mutationFn: (data: any) => apisApi.createSdkApi(data),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      success('API created', 'SDK API has been created successfully. Packages are being analyzed.')
      onOpenChange(false)
      setCreateStep('details')
      setSdkPackages([])
      setNewPkgName('')
      setNewPkgVersion('*')
      setUsePrivateRegistry(false)
      setRegistryUrl('')
      setRegistryToken('')
      setRegistryScope('')
      // Navigate to API detail page
      if (response?.id) {
        navigate(`/apis/${response.id}`)
      }
    },
    onError: (err: any) => {
      error('Failed to create SDK API', err.response?.data?.message || 'Please try again.')
    },
  })

  const createForm = useForm<CreateApiFormInput, any, CreateApiFormData>({
    resolver: zodResolver(createApiSchema),
    defaultValues: {
      type: ApiType.OPENAPI,
      authentication: {
        type: ApiAuthType.NONE,
        config: {},
      },
    },
  })

  // Populate form when editing
  React.useEffect(() => {
    if (editingApi) {
      createForm.reset({
        name: editingApi.name,
        baseUrl: editingApi.baseUrl,
        type: editingApi.type,
        description: editingApi.description || '',
        version: editingApi.version || '',
        authentication: editingApi.authentication || {
          type: ApiAuthType.NONE,
          config: {},
        },
      })
      setSelectedAuthType(editingApi.authentication?.type || ApiAuthType.NONE)
      setSelectedApiType(editingApi.type)
    } else {
      createForm.reset({
        type: ApiType.OPENAPI,
        authentication: {
          type: ApiAuthType.NONE,
          config: {},
        },
      })
      setSelectedAuthType(ApiAuthType.NONE)
      setSelectedApiType(ApiType.OPENAPI)
    }
  }, [editingApi])

  const handleCreateApi = (data: CreateApiFormData) => {
    if (editingApi) {
      // Update existing API - exclude type field as it can't be changed
      const { type, ...updateData } = data
      updateApiMutation.mutate({ id: editingApi.id, data: updateData })
    } else if (data.type === ApiType.SDK) {
      // SDK: create with packages, skip schema import
      const dependencies: Record<string, string> = {}
      sdkPackages.forEach(pkg => { dependencies[pkg.name] = pkg.version })
      const sdkData: any = {
        name: data.name,
        description: data.description,
        dependencies,
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
      // Custom HTTP: create directly, skip schema import
      createHttpApiMutation.mutate(data)
    } else {
      // Create new API (goes to schema import step)
      createApiMutation.mutate(data)
    }
  }

  const handleDialogOpenChange = (next: boolean) => {
    onOpenChange(next)
    if (!next) {
      setCreateStep('details')
      setCreatedApiForSchema(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {createStep === 'schema'
              ? 'Import Schema'
              : editingApi ? 'Edit API' : 'Connect New API'}
          </DialogTitle>
          <DialogDescription>
            {createStep === 'schema'
              ? 'Import a schema to auto-generate operations and tools, or skip this step.'
              : editingApi
                ? 'Update your API configuration and settings.'
                : 'Connect an existing API to automatically generate tools for LLM usage.'}
          </DialogDescription>
        </DialogHeader>
        {createStep === 'schema' && createdApiForSchema ? (
          <div className="space-y-6">
            <div className="flex items-center gap-3 p-3 bg-green-50 border border-green-200 rounded-lg">
              <CheckCircle className="h-5 w-5 text-green-500 shrink-0" />
              <div>
                <p className="font-medium text-sm">API "{createdApiForSchema.name}" created</p>
                <p className="text-xs text-muted-foreground">Import a schema to auto-generate operations and tools.</p>
              </div>
            </div>

            <Tabs defaultValue="file" className="w-full">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="file">
                  <Upload className="h-4 w-4 mr-1" />
                  File
                </TabsTrigger>
                <TabsTrigger value="url">
                  <Globe className="h-4 w-4 mr-1" />
                  URL
                </TabsTrigger>
                <TabsTrigger value="paste">
                  <FileText className="h-4 w-4 mr-1" />
                  Paste
                </TabsTrigger>
              </TabsList>
              <TabsContent value="file" className="space-y-3 mt-3">
                <div>
                  <Label>Schema File</Label>
                  <Input
                    type="file"
                    accept=".json,.yaml,.yml,.graphql,.gql,.wsdl,.xml,.proto"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) setUploadFile(file)
                    }}
                    className="mt-1"
                  />
                  {uploadFile && (
                    <p className="text-xs text-muted-foreground mt-1">
                      Selected: {uploadFile.name} ({(uploadFile.size / 1024).toFixed(1)} KB)
                    </p>
                  )}
                </div>
              </TabsContent>
              <TabsContent value="url" className="space-y-3 mt-3">
                <div>
                  <Label>Schema URL</Label>
                  <Input
                    id="inlineSchemaUrl"
                    type="url"
                    placeholder="https://api.example.com/swagger.json"
                    className="mt-1"
                  />
                </div>
              </TabsContent>
              <TabsContent value="paste" className="space-y-3 mt-3">
                <div>
                  <Label>Schema Content</Label>
                  <Textarea
                    id="inlineSchemaContent"
                    placeholder="Paste your schema here..."
                    rows={8}
                    className="mt-1"
                  />
                </div>
              </TabsContent>
            </Tabs>

            <div className="flex justify-end gap-2 pt-2 border-t">
              <Button
                variant="ghost"
                onClick={() => {
                  onOpenChange(false)
                  setCreateStep('details')
                  setCreatedApiForSchema(null)
                }}
              >
                Skip for now
              </Button>
              <Button
                disabled={importSchemaMutation.isPending}
                onClick={() => {
                  const urlInput = document.getElementById('inlineSchemaUrl') as HTMLInputElement
                  const pasteInput = document.getElementById('inlineSchemaContent') as HTMLTextAreaElement
                  const data: any = { generateTools: true }
                  if (urlInput?.value) data.schemaUrl = urlInput.value
                  if (pasteInput?.value) data.schemaContent = pasteInput.value

                  importSchemaMutation.mutate({
                    id: createdApiForSchema.id,
                    data,
                    file: uploadFile || undefined,
                  })
                  setCreateStep('details')
                  setCreatedApiForSchema(null)
                }}
              >
                {importSchemaMutation.isPending ? (
                  <>Importing...</>
                ) : (
                  <>
                    <Upload className="mr-2 h-4 w-4" />
                    Import Schema
                  </>
                )}
              </Button>
            </div>
          </div>
        ) : (
        <form onSubmit={createForm.handleSubmit(handleCreateApi)} className="space-y-6">
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <Label htmlFor="name">API Name</Label>
              <Input
                id="name"
                placeholder="Enter API name"
                {...createForm.register('name')}
              />
              {createForm.formState.errors.name && (
                <p className="text-sm text-red-500 mt-1">
                  {createForm.formState.errors.name.message}
                </p>
              )}
            </div>
            <div>
              <Label htmlFor="type">API Type</Label>
              <Select
                disabled={!!editingApi}
                value={selectedApiType}
                onValueChange={(value) => {
                const apiType = value as ApiType
                setSelectedApiType(apiType)
                createForm.setValue('type', apiType)
                // Reset auth type when API type changes
                setSelectedAuthType(ApiAuthType.NONE)
              }}>
                <SelectTrigger>
                  <SelectValue placeholder="Select API type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ApiType.OPENAPI}>
                    <div className="flex items-center space-x-2">
                      <Globe className="h-4 w-4" />
                      <span>OpenAPI/REST</span>
                    </div>
                  </SelectItem>
                  <SelectItem value={ApiType.GRAPHQL}>
                    <div className="flex items-center space-x-2">
                      <Database className="h-4 w-4" />
                      <span>GraphQL</span>
                    </div>
                  </SelectItem>
                  <SelectItem value={ApiType.SOAP}>
                    <div className="flex items-center space-x-2">
                      <Cloud className="h-4 w-4" />
                      <span>SOAP</span>
                    </div>
                  </SelectItem>
                  <SelectItem value={ApiType.GRPC}>
                    <div className="flex items-center space-x-2">
                      <Server className="h-4 w-4" />
                      <span>gRPC</span>
                    </div>
                  </SelectItem>
                  <SelectItem value={ApiType.HTTP}>
                    <div className="flex items-center space-x-2">
                      <Webhook className="h-4 w-4" />
                      <span>Custom HTTP</span>
                    </div>
                  </SelectItem>
                  <SelectItem value={ApiType.SDK}>
                    <div className="flex items-center space-x-2">
                      <Package className="h-4 w-4" />
                      <span>SDK / npm Library</span>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* SDK type: show packages instead of base URL */}
          {selectedApiType === ApiType.SDK ? (
            <div className="space-y-4">
              <div>
                <Label>Packages</Label>
                <div className="border rounded-lg mt-1">
                  {sdkPackages.length > 0 && (
                    <div className="divide-y">
                      {sdkPackages.map((pkg, idx) => (
                        <div key={idx} className="flex items-center gap-2 p-2">
                          <div className="flex-1 font-mono text-sm">{pkg.name}</div>
                          <div className="w-32 text-sm text-muted-foreground">{pkg.version}</div>
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
                  <div className="flex items-center gap-2 p-2 border-t">
                    <Input
                      placeholder="Package name (e.g. @aws-sdk/client-s3)"
                      value={newPkgName}
                      onChange={(e) => setNewPkgName(e.target.value)}
                      className="flex-1 h-8"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          if (newPkgName.trim()) {
                            setSdkPackages([...sdkPackages, { name: newPkgName.trim(), version: newPkgVersion }])
                            setNewPkgName('')
                            setNewPkgVersion('*')
                          }
                        }
                      }}
                    />
                    <Input
                      placeholder="Version"
                      value={newPkgVersion}
                      onChange={(e) => setNewPkgVersion(e.target.value)}
                      className="w-32 h-8"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-8 w-8"
                      aria-label="Add package"
                      onClick={() => {
                        if (newPkgName.trim()) {
                          setSdkPackages([...sdkPackages, { name: newPkgName.trim(), version: newPkgVersion }])
                          setNewPkgName('')
                          setNewPkgVersion('*')
                        }
                      }}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                {sdkPackages.length === 0 && (
                  <p className="text-xs text-muted-foreground mt-1">Add at least one npm package to create an SDK API.</p>
                )}
              </div>

              {/* Private registry */}
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="private-registry"
                  checked={usePrivateRegistry}
                  onCheckedChange={(checked) => setUsePrivateRegistry(checked === true)}
                />
                <Label htmlFor="private-registry" className="text-sm font-normal cursor-pointer">Use private npm registry</Label>
              </div>
              {usePrivateRegistry && (
                <div className="space-y-3 border rounded-lg p-3 bg-muted/30">
                  <div>
                    <Label htmlFor="registry-url">Registry URL</Label>
                    <Input
                      id="registry-url"
                      placeholder="https://registry.example.com"
                      value={registryUrl}
                      onChange={(e) => setRegistryUrl(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="registry-token">Auth Token</Label>
                    <Input
                      id="registry-token"
                      type="password"
                      placeholder="npm auth token"
                      value={registryToken}
                      onChange={(e) => setRegistryToken(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="registry-scope">Scope (optional)</Label>
                    <Input
                      id="registry-scope"
                      placeholder="@myorg"
                      value={registryScope}
                      onChange={(e) => setRegistryScope(e.target.value)}
                    />
                  </div>
                </div>
              )}
            </div>
          ) : (
            <>
              <div>
                <Label htmlFor="baseUrl">
                  {selectedApiType === ApiType.GRPC ? 'gRPC Server Address' : 'Base URL'}
                </Label>
                <Input
                  id="baseUrl"
                  placeholder={getUrlInfo(selectedApiType).placeholder}
                  {...createForm.register('baseUrl')}
                />
                {createForm.formState.errors.baseUrl && (
                  <p className="text-sm text-red-500 mt-1">
                    {createForm.formState.errors.baseUrl.message}
                  </p>
                )}
                <p className="text-xs text-muted-foreground mt-1">
                  {selectedApiType === ApiType.GRPC && 'gRPC uses grpc:// protocol with port number'}
                  {selectedApiType === ApiType.GRAPHQL && 'GraphQL typically has a single /graphql endpoint'}
                  {selectedApiType === ApiType.SOAP && 'SOAP services usually expose WSDL at /soap or /?wsdl'}
                  {selectedApiType === ApiType.OPENAPI && 'REST APIs can have versioned paths like /v1 or /api/v2'}
                  {selectedApiType === ApiType.HTTP && 'Base URL for your HTTP API. Tools will use paths relative to this.'}
                </p>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <Label htmlFor="version">Version (Optional)</Label>
                  <Input
                    id="version"
                    placeholder="v1.0"
                    {...createForm.register('version')}
                  />
                </div>
                <div>
                  <Label htmlFor="authType">Authentication</Label>
                  <Select onValueChange={(value) => {
                    const authType = value as ApiAuthType
                    setSelectedAuthType(authType)
                    createForm.setValue('authentication', {
                      type: authType,
                      config: {}
                    })
                  }}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select auth type" />
                    </SelectTrigger>
                    <SelectContent>
                      {getSupportedAuthMethods(selectedApiType).map((authType) => (
                        <SelectItem key={authType} value={authType}>
                          {authType === ApiAuthType.NONE && 'No Authentication'}
                          {authType === ApiAuthType.API_KEY && 'API Key'}
                          {authType === ApiAuthType.BEARER_TOKEN && 'Bearer Token'}
                          {authType === ApiAuthType.BASIC_AUTH && 'Basic Auth'}
                          {authType === ApiAuthType.OAUTH2 && 'OAuth 2.0'}
                          {authType === ApiAuthType.CUSTOM && 'Custom'}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </>
          )}

          {/* Authentication Configuration Fields */}
          {selectedAuthType === ApiAuthType.API_KEY && (
            <div className="space-y-4">
              <CredentialPicker
                label="API Key"
                value={apiKeyCredentialId}
                onSelect={(id) => {
                  setApiKeyCredentialId(id)
                  createForm.setValue('authentication.config.credentialId', id)
                }}
                onNewKey={(key) => createForm.setValue('authentication.config.apiKey', key)}
                newKeyValue=""
                filterType="api_key"
              />
              <div>
                <Label htmlFor="headerName">Header Name</Label>
                <Input
                  id="headerName"
                  placeholder="X-API-Key"
                  defaultValue="X-API-Key"
                  onChange={(e) => createForm.setValue('authentication.config.headerName', e.target.value)}
                />
              </div>
            </div>
          )}

          {selectedAuthType === ApiAuthType.BEARER_TOKEN && (
            <CredentialPicker
              label="Bearer Token"
              value={bearerCredentialId}
              onSelect={(id) => {
                setBearerCredentialId(id)
                createForm.setValue('authentication.config.credentialId', id)
              }}
              onNewKey={(key) => createForm.setValue('authentication.config.token', key)}
              newKeyValue=""
              placeholder="Enter bearer token"
              filterType="bearer_token"
            />
          )}

          {selectedAuthType === ApiAuthType.BASIC_AUTH && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="username">Username</Label>
                <Input
                  id="username"
                  placeholder="Enter username"
                  onChange={(e) => createForm.setValue('authentication.config.username', e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="Enter password"
                  onChange={(e) => createForm.setValue('authentication.config.password', e.target.value)}
                />
              </div>
            </div>
          )}

          {selectedAuthType === ApiAuthType.OAUTH2 && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="clientId">Client ID</Label>
                  <Input
                    id="clientId"
                    placeholder="Your OAuth client ID"
                    onChange={(e) => createForm.setValue('authentication.config.clientId', e.target.value)}
                  />
                </div>
                <CredentialPicker
                  label="Client Secret"
                  value={oauthCredentialId}
                  onSelect={(id) => {
                    setOauthCredentialId(id)
                    createForm.setValue('authentication.config.credentialId', id)
                  }}
                  onNewKey={(key) => createForm.setValue('authentication.config.clientSecret', key)}
                  newKeyValue=""
                  placeholder="Your OAuth client secret"
                  filterType="oauth2"
                />
              </div>
              <div>
                <Label htmlFor="authUrl">Authorization URL</Label>
                <Input
                  id="authUrl"
                  type="url"
                  placeholder="https://api.example.com/oauth/authorize"
                  onChange={(e) => createForm.setValue('authentication.config.authUrl', e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="tokenUrl">Token URL</Label>
                <Input
                  id="tokenUrl"
                  type="url"
                  placeholder="https://api.example.com/oauth/token"
                  onChange={(e) => createForm.setValue('authentication.config.tokenUrl', e.target.value)}
                />
              </div>
            </div>
          )}

          <div>
            <Label htmlFor="description">Description (Optional)</Label>
            <Textarea
              id="description"
              placeholder="Enter API description"
              {...createForm.register('description')}
            />
          </div>

          <div className="flex justify-end space-x-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={createApiMutation.isPending || updateApiMutation.isPending || createHttpApiMutation.isPending || createSdkApiMutation.isPending || (selectedApiType === ApiType.SDK && sdkPackages.length === 0)}
            >
              {editingApi
                ? (updateApiMutation.isPending ? 'Saving...' : 'Save Changes')
                : (createApiMutation.isPending || createHttpApiMutation.isPending || createSdkApiMutation.isPending ? 'Connecting...' : 'Connect API')}
            </Button>
          </div>
        </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
