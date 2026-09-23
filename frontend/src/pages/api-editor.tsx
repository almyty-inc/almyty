import { DETAIL_TITLE_CLASSES } from '@/components/layout/page-header'
/**
 * pages/api-editor — Connect an API (/apis/new) or edit one (/apis/:id/edit).
 *
 * Owns the form, all 4 create/update mutations (REST/OpenAPI, HTTP, SDK,
 * plus update), the auth-method picker, the SDK package manager, and the
 * schema-import second step a new REST/GraphQL/SOAP/gRPC API goes through.
 * This used to be a dialog on the APIs list; create and configure flows
 * live on their own pages.
 */
import React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  ArrowLeft, CheckCircle, Cloud, Database, FileText, Globe, Package, Plus,
  Server, Upload, Webhook, XCircle,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { CredentialPicker } from '@/components/credential-picker'

import { apisApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useNotifications } from '@/store/app'
import { Api, ApiAuthType, ApiType } from '@/types'
import { useOrganizationStore } from '@/store/organization'
import { VisibilityField, type VisibilityValue } from '@/components/ui/visibility-field'

import {
  createApiSchema,
  type CreateApiFormData,
  type CreateApiFormInput,
} from '@/components/apis/schema'
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

export function ApiEditorPage() {
  const { success, error } = useNotifications()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { id } = useParams<{ id?: string }>()
  const isEditing = !!id

  React.useEffect(() => {
    document.title = `${isEditing ? 'Edit API' : 'Connect API'} | almyty`
    return () => { document.title = 'almyty' }
  }, [isEditing])

  // Editing loads the API itself (the list row no longer hands it over).
  const editingApiQuery = useQuery<Api>({
    queryKey: ['api', id],
    queryFn: () => apisApi.getById(id!),
    enabled: isEditing,
  })
  const editingApi: Api | null = isEditing ? (editingApiQuery.data ?? null) : null

  /** Leave the page: to the API when there is one, else back to the list. */
  const done = (apiId?: string) => navigate(apiId ? `/apis/${apiId}` : '/apis')

  const [createStep, setCreateStep] = React.useState<'details' | 'schema'>('details')
  const [createdApiForSchema, setCreatedApiForSchema] = React.useState<Api | null>(null)
  const [uploadFile, setUploadFile] = React.useState<File | null>(null)
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
  const { currentOrganization } = useOrganizationStore()
  const [visibility, setVisibility] = React.useState<VisibilityValue>({ visibility: 'org', teamId: null })

  const createApiMutation = useMutation({
    mutationFn: apisApi.create,
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      success('API created', 'API has been created successfully.')
      setCreatedApiForSchema(response)
      setCreateStep('schema')
    },
    onError: (err: any) => {
      error('Failed to create API', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  // The schema step of a new API. Same flow the APIs list ran: start the
  // import, poll the job, then refresh everything an import changes.
  const importSchemaMutation = useMutation({
    mutationFn: async ({ id: apiId, data, file }: { id: string; data: any; file?: File }) => {
      const importResult = await apisApi.importSchema(apiId, data, file)
      if (importResult?.jobId) {
        return apisApi.pollImportStatus(apiId, importResult.jobId)
      }
      return importResult
    },
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      queryClient.invalidateQueries({ queryKey: ['api-schemas'] })
      queryClient.invalidateQueries({ queryKey: ['api-operations'] })
      queryClient.invalidateQueries({ queryKey: ['tools'] })
      const jobResult = result?.result || result
      const opCount = jobResult?.operations?.length || jobResult?.operationCount || 0
      const toolCount = jobResult?.tools?.length || jobResult?.toolCount || 0
      success('Schema imported', `Schema imported successfully. ${opCount} operations found, ${toolCount} tools generated.`)
      done(variables.id)
    },
    onError: (err: any) => {
      error('Failed to import schema', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  const updateApiMutation = useMutation({
    mutationFn: ({ id: apiId, data }: { id: string; data: Partial<Api> }) =>
      apisApi.update(apiId, data),
    onSuccess: (_res, variables) => {
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      queryClient.invalidateQueries({ queryKey: ['api', variables.id] })
      success('API updated', 'API has been updated successfully.')
      done(variables.id)
    },
    onError: (err: any) => {
      error('Failed to update API', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  const createHttpApiMutation = useMutation({
    mutationFn: (data: any) => apisApi.createHttpApi(data),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      success('API created', 'Custom HTTP API has been created successfully.')
      done(response?.id)
    },
    onError: (err: any) => {
      error('Failed to create API', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  const createSdkApiMutation = useMutation({
    mutationFn: (data: any) => apisApi.createSdkApi(data),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      success('API created', 'SDK API has been created successfully. Packages are being analyzed.')
      done(response?.id)
    },
    onError: (err: any) => {
      error('Failed to create SDK API', getApiErrorMessage(err, 'Please try again.'))
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

  // Populate the form once the API being edited has loaded.
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
      // Load the API's own scope: defaulting to org-wide here would widen
      // a private or team API on any unrelated edit.
      setVisibility({ visibility: editingApi.visibility ?? 'org', teamId: editingApi.teamId ?? null })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingApi])

  const handleCreateApi = (data: CreateApiFormData) => {
    const visibilityFields = { visibility: visibility.visibility, teamId: visibility.teamId }
    if (editingApi) {
      // Update existing API - exclude type field as it can't be changed
      const { type, ...updateData } = data
      updateApiMutation.mutate({ id: editingApi.id, data: { ...updateData, ...visibilityFields } })
    } else if (data.type === ApiType.SDK) {
      // SDK: create with packages, skip schema import
      const dependencies: Record<string, string> = {}
      sdkPackages.forEach(pkg => { dependencies[pkg.name] = pkg.version })
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
      // Custom HTTP: create directly, skip schema import
      createHttpApiMutation.mutate({ ...data, ...visibilityFields })
    } else {
      // Create new API (goes to schema import step)
      createApiMutation.mutate({ ...data, ...visibilityFields })
    }
  }

  if (isEditing && editingApiQuery.isError) {
    return (
      <QueryError
        error={editingApiQuery.error}
        onRetry={() => editingApiQuery.refetch()}
        title="Couldn't open that API"
      />
    )
  }

  if (isEditing && !editingApi) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          to={editingApi ? `/apis/${editingApi.id}` : '/apis'}
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="mr-1 h-4 w-4" />
          {editingApi ? editingApi.name : 'APIs'}
        </Link>
      </div>

      <div>
        <h1 className={DETAIL_TITLE_CLASSES}>
          {createStep === 'schema'
            ? 'Import schema'
            : editingApi ? 'Edit API' : 'Connect new API'}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {createStep === 'schema'
            ? 'Import a schema to auto-generate operations and tools, or skip this step.'
            : editingApi
              ? 'Update your API configuration and settings.'
              : 'Connect an existing API to automatically generate tools your agents can call.'}
        </p>
      </div>

        {createStep === 'schema' && createdApiForSchema ? (
          <Card>
            <CardContent className="pt-6 space-y-6">
            <div className="flex items-center gap-3 p-3 bg-green-50 border border-green-200 dark:bg-green-500/10 dark:border-green-500/30 rounded-lg">
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
                  <Label htmlFor="create-api-schema-file">Schema File</Label>
                  <Input id="create-api-schema-file"
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
                  <Label htmlFor="inlineSchemaUrl">Schema URL</Label>
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
                  <Label htmlFor="inlineSchemaContent">Schema Content</Label>
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
              <Button variant="ghost" onClick={() => done(createdApiForSchema.id)}>
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
            </CardContent>
          </Card>
        ) : (
        <Card>
          <CardContent className="pt-6">
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
                <p className="text-sm text-destructive mt-1">
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
                  <p className="text-sm text-destructive mt-1">
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

          <div className="border-t pt-4">
            <VisibilityField
              organizationId={currentOrganization?.id ?? ''}
              value={visibility}
              onChange={setVisibility}
              noun="this API"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => done(editingApi?.id)}>
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
          </CardContent>
        </Card>
        )}
    </div>
  )
}