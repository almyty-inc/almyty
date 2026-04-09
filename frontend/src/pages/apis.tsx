import React from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { ColumnDef } from '@tanstack/react-table'
import {
  Plus, Upload, FileCode, TestTube, Settings, Play, Pause,
  CheckCircle, XCircle, AlertCircle, Globe, Database, Cloud,
  Code, FileText, Zap, Activity, BarChart3, Shield, Key,
  Search, ExternalLink, Download, Eye, Edit, Trash2,
  Server, Webhook, Lock, Unlock, Copy, ChevronRight, Package
} from 'lucide-react'
import { useForm, useController } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ApiTypeBadge } from '@/components/ui/api-type-badge'
import { DataTable, createSelectColumn, createActionsColumn, createSortableColumn } from '@/components/ui/data-table'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Progress } from '@/components/ui/progress'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { EmptyState } from '@/components/ui/empty-state'
import { QueryError } from '@/components/ui/query-error'
import { useCreateDeepLink } from '@/hooks/use-create-deep-link'
import { Checkbox } from '@/components/ui/checkbox'
import { SchemaImportDialog } from '@/components/SchemaImportDialog'

import { apisApi } from '@/lib/api'
import { CredentialPicker } from '@/components/credential-picker'
import { useOrganizationStore } from '@/store/organization'
import { useNotifications } from '@/store/app'
import { formatDate, formatDateTime, cn } from '@/lib/utils'
import { Api, ApiType, ApiHealthStatus, ApiAuthType, SchemaFormat, ApiOperation } from '@/types'
import { ApiDetailDialog } from '@/components/apis/api-detail-dialog'

const createApiSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  description: z.string().optional(),
  type: z.nativeEnum(ApiType),
  // NOT .optional() — `.default('')` already makes the input
  // optional but produces a `string` output, which is what the
  // form field and submit handler expect. Chaining `.optional()`
  // on top confuses the `@hookform/resolvers/zod` v5 type inference
  // into thinking the output is `string | undefined`, which then
  // doesn't match `useForm<CreateApiFormData>` (where baseUrl is
  // a plain `string`).
  baseUrl: z.string().default(''),
  version: z.string().optional(),
  configuration: z.record(z.any()).optional(),
  authentication: z.object({
    type: z.nativeEnum(ApiAuthType),
    config: z.record(z.any()),
  }).optional(),
}).refine((data) => {
  // SDK type doesn't require a baseUrl
  if (data.type === ApiType.SDK) return true
  // All other types require a valid URL
  try {
    if (!data.baseUrl) return false
    new URL(data.baseUrl)
    return true
  } catch {
    return false
  }
}, {
  message: 'Please enter a valid URL',
  path: ['baseUrl'],
})

const importSchemaSchema = z.object({
  schemaContent: z.string().optional(),
  schemaUrl: z.string().url().optional(),
  description: z.string().optional(),
  generateTools: z.boolean().optional(),
}).refine((data) => data.schemaContent || data.schemaUrl, {
  message: "Either schema content or URL must be provided",
  path: ["schemaContent"],
})

// Two separate types: `Input` is the shape the form BINDS to
// (with optional defaults still unfilled); `Output` is the shape
// the submit handler RECEIVES after zod has applied defaults +
// refinements. `@hookform/resolvers/zod` v5 requires both to be
// passed to `useForm<Input, Context, Output>` so the resolver's
// generics line up — otherwise it complains that the inferred
// input shape (with `baseUrl?: string`) doesn't match a form
// whose submit handler wants `baseUrl: string`.
type CreateApiFormInput = z.input<typeof createApiSchema>
type CreateApiFormData = z.output<typeof createApiSchema>
type ImportSchemaFormData = z.output<typeof importSchemaSchema>

export function ApisPage() {
  React.useEffect(() => {
    document.title = 'APIs | almyty'
    return () => { document.title = 'almyty' }
  }, [])

  const { currentOrganization } = useOrganizationStore()
  const { success, error } = useNotifications()
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  // Get all tools to show accurate counts per API
  const { data: allToolsData } = useQuery({
    queryKey: ['tools', currentOrganization?.id],
    queryFn: () => import('@/lib/api').then(m => m.toolsApi.getAll(currentOrganization?.id)),
    enabled: !!currentOrganization,
  })

  const allToolsExtracted = allToolsData?.tools || allToolsData || []
  const allTools = Array.isArray(allToolsExtracted) ? allToolsExtracted : []
  const allToolsTotal = allToolsData?.total ?? allTools.length
  
  const [selectedApi, setSelectedApi] = React.useState<Api | null>(null)
  const [editingApi, setEditingApi] = React.useState<Api | null>(null)
  const [deletingApi, setDeletingApi] = React.useState<Api | null>(null)
  const [createDialogOpen, setCreateDialogOpen] = React.useState(false)
  // Honour ?new=1 from the command palette Create API action.
  useCreateDeepLink(setCreateDialogOpen)
  const [createStep, setCreateStep] = React.useState<'details' | 'schema'>('details')
  const [createdApiForSchema, setCreatedApiForSchema] = React.useState<Api | null>(null)
  const [uploadDialogOpen, setUploadDialogOpen] = React.useState(false)
  const [apiDetailsOpen, setApiDetailsOpen] = React.useState(false)
  const [testResults, setTestResults] = React.useState<any>(null)
  const [uploadFile, setUploadFile] = React.useState<File | null>(null)
  const [selectedAuthType, setSelectedAuthType] = React.useState<ApiAuthType>(ApiAuthType.NONE)
  const [apiKeyCredentialId, setApiKeyCredentialId] = React.useState('')
  const [bearerCredentialId, setBearerCredentialId] = React.useState('')
  const [oauthCredentialId, setOauthCredentialId] = React.useState('')
  const [selectedApiType, setSelectedApiType] = React.useState<ApiType>(ApiType.OPENAPI)
  // SDK API creation state
  const [sdkPackages, setSdkPackages] = React.useState<Array<{name: string, version: string}>>([])
  const [newPkgName, setNewPkgName] = React.useState('')
  const [newPkgVersion, setNewPkgVersion] = React.useState('*')
  const [usePrivateRegistry, setUsePrivateRegistry] = React.useState(false)
  const [registryUrl, setRegistryUrl] = React.useState('')
  const [registryToken, setRegistryToken] = React.useState('')
  const [registryScope, setRegistryScope] = React.useState('')
  const [searchQuery, setSearchQuery] = React.useState('')
  const [typeFilter, setTypeFilter] = React.useState('all')
  const [healthFilter, setHealthFilter] = React.useState('all')

  const { data: apisData, isLoading, isError, error: apisError, refetch: refetchApis } = useQuery({
    queryKey: ['apis', currentOrganization?.id],
    queryFn: () => apisApi.getAll(),
    enabled: !!currentOrganization,
    refetchInterval: 60000,
  })

  const { data: apiOperations } = useQuery({
    queryKey: ['api-operations', selectedApi?.id],
    queryFn: () => selectedApi ? apisApi.getOperations(selectedApi.id) : null,
    enabled: !!selectedApi,
  })

  const createApiMutation = useMutation({
    mutationFn: apisApi.create,
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      success('API created', 'API has been created successfully.')
      setCreatedApiForSchema(response)
      setSelectedApi(response)
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
      setCreateDialogOpen(false)
      setEditingApi(null)
    },
    onError: (err: any) => {
      error('Failed to update API', err.response?.data?.message || 'Please try again.')
    },
  })

  const deleteApiMutation = useMutation({
    mutationFn: apisApi.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      success('API deleted', 'API has been deleted successfully.')
      setApiDetailsOpen(false)
      setDeletingApi(null)
    },
    onError: (err: any) => {
      error('Failed to delete API', err.response?.data?.message || 'Please try again.')
    },
  })

  const importSchemaMutation = useMutation({
    mutationFn: async ({ id, data, file }: { id: string; data: any; file?: File }) => {
      const importResult = await apisApi.importSchema(id, data, file)

      // If response contains jobId, poll for completion
      if (importResult?.jobId) {
        console.log('[UI] Got jobId, starting polling:', importResult.jobId)
        try {
          const result = await apisApi.pollImportStatus(id, importResult.jobId)
          console.log('[UI] Polling completed, result:', result)
          return result
        } catch (pollError) {
          console.error('[UI] Polling failed:', pollError)
          throw pollError
        }
      }

      return importResult
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      queryClient.invalidateQueries({ queryKey: ['api-operations'] })
      queryClient.invalidateQueries({ queryKey: ['tools'] })
      queryClient.invalidateQueries({ queryKey: ['tools', currentOrganization?.id] })
      // Force refetch for currently displayed API operations
      if (selectedApi) {
        queryClient.refetchQueries({ queryKey: ['api-operations', selectedApi.id] })
      }
      // Handle both direct result and async job result formats
      // For async jobs: result.result contains the job's returnvalue
      const jobResult = result?.result || result
      const opCount = jobResult?.operations?.length || jobResult?.operationCount || 0
      const toolCount = jobResult?.tools?.length || jobResult?.toolCount || 0
      success('Schema imported', `Schema imported successfully. ${opCount} operations found, ${toolCount} tools generated.`)
      setUploadDialogOpen(false)
      setUploadFile(null)
    },
    onError: (err: any) => {
      error('Failed to import schema', err.response?.data?.message || err.message || 'Please try again.')
    },
  })

  const generateToolsMutation = useMutation({
    mutationFn: ({ id }: { id: string }) => apisApi.generateTools(id),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      queryClient.invalidateQueries({ queryKey: ['tools'] })
      queryClient.invalidateQueries({ queryKey: ['tools', currentOrganization?.id] })
      const toolCount = Array.isArray(result) ? result.length : 0
      success('Tools generated', `${toolCount} tools have been generated successfully.`)
    },
    onError: (err: any) => {
      error('Failed to generate tools', err.response?.data?.message || 'Please try again.')
    },
  })

  const testApiMutation = useMutation({
    mutationFn: ({ id }: { id: string }) => apisApi.testConnection(id),
    onSuccess: (result) => {
      setTestResults(result)
      success('API test completed', 'Connection test results are available.')
    },
    onError: (err: any) => {
      setTestResults({ error: err.response?.data?.message || 'Test failed' })
      error('API test failed', err.response?.data?.message || 'Please try again.')
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

  const createHttpApiMutation = useMutation({
    mutationFn: (data: any) => apisApi.createHttpApi(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      success('API created', 'Custom HTTP API has been created successfully.')
      setCreateDialogOpen(false)
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
      setCreateDialogOpen(false)
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

  const handleImportSchema = (data: ImportSchemaFormData) => {
    if (!selectedApi) return
    
    importSchemaMutation.mutate({ 
      id: selectedApi.id, 
      data,
      file: uploadFile || undefined
    })
  }

  // Get supported auth methods per API type
  const getSupportedAuthMethods = (apiType: ApiType): ApiAuthType[] => {
    switch (apiType) {
      case ApiType.OPENAPI:
        return [ApiAuthType.NONE, ApiAuthType.API_KEY, ApiAuthType.BEARER_TOKEN, ApiAuthType.BASIC_AUTH, ApiAuthType.OAUTH2];
      case ApiType.GRAPHQL:
        return [ApiAuthType.NONE, ApiAuthType.API_KEY, ApiAuthType.BEARER_TOKEN];
      case ApiType.SOAP:
        return [ApiAuthType.NONE, ApiAuthType.BASIC_AUTH, ApiAuthType.CUSTOM];
      case ApiType.GRPC:
        return [ApiAuthType.NONE, ApiAuthType.BEARER_TOKEN, ApiAuthType.CUSTOM];
      case ApiType.HTTP:
        return [ApiAuthType.NONE, ApiAuthType.API_KEY, ApiAuthType.BEARER_TOKEN, ApiAuthType.BASIC_AUTH];
      case ApiType.SDK:
        return [ApiAuthType.NONE];
      default:
        return [ApiAuthType.NONE, ApiAuthType.CUSTOM];
    }
  }

  // Get URL placeholder and validation per API type
  const getUrlInfo = (apiType: ApiType) => {
    switch (apiType) {
      case ApiType.OPENAPI:
        return { placeholder: 'https://api.example.com/v1', pattern: /^https?:\/\/.+/ };
      case ApiType.GRAPHQL:
        return { placeholder: 'https://api.example.com/graphql', pattern: /^https?:\/\/.+/ };
      case ApiType.SOAP:
        return { placeholder: 'https://api.example.com/soap', pattern: /^https?:\/\/.+/ };
      case ApiType.GRPC:
        return { placeholder: 'grpc://api.example.com:443', pattern: /^grpc:\/\/.+:\d+$/ };
      case ApiType.HTTP:
        return { placeholder: 'https://api.example.com', pattern: /^https?:\/\/.+/ };
      case ApiType.SDK:
        return { placeholder: 'npm://package-name', pattern: /.*/ };
      default:
        return { placeholder: 'https://api.example.com', pattern: /^https?:\/\/.+/ };
    }
  }

  const getApiTypeIcon = (type: ApiType) => {
    switch (type) {
      case ApiType.OPENAPI: return Globe
      case ApiType.GRAPHQL: return Database
      case ApiType.SOAP: return Cloud
      case ApiType.GRPC: return Server
      case ApiType.HTTP: return Webhook
      case ApiType.SDK: return Package
      case ApiType.OTHER: return Code
      default: return Code
    }
  }

  const getHealthStatusIcon = (status: ApiHealthStatus) => {
    switch (status) {
      case ApiHealthStatus.HEALTHY: return CheckCircle
      case ApiHealthStatus.DEGRADED: return AlertCircle
      case ApiHealthStatus.UNHEALTHY: return XCircle
      default: return AlertCircle
    }
  }

  const getHealthStatusColor = (status: ApiHealthStatus) => {
    switch (status) {
      case ApiHealthStatus.HEALTHY: return 'text-green-500'
      case ApiHealthStatus.DEGRADED: return 'text-yellow-500'
      case ApiHealthStatus.UNHEALTHY: return 'text-red-500'
      default: return 'text-muted-foreground'
    }
  }

  const getAuthTypeIcon = (type?: ApiAuthType) => {
    switch (type) {
      case ApiAuthType.API_KEY: return Key
      case ApiAuthType.BEARER_TOKEN: return Shield
      case ApiAuthType.BASIC_AUTH: return Lock
      case ApiAuthType.OAUTH2: return Unlock
      default: return Unlock
    }
  }

  const apiColumns: ColumnDef<Api>[] = [
    {
      ...createSortableColumn('name', 'API'),
      cell: ({ row }) => {
        const api = row.original
        const TypeIcon = getApiTypeIcon(api.type)
        const HealthIcon = getHealthStatusIcon(api.healthStatus)
        
        return (
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
              <TypeIcon className="h-5 w-5 text-primary" />
            </div>
            <div>
              <div className="font-medium">{api.name}</div>
              <div className="text-sm text-muted-foreground">{api.baseUrl === 'internal://custom' ? 'Custom Tool' : api.baseUrl}</div>
            </div>
          </div>
        )
      },
    },
    {
      accessorKey: 'type',
      header: 'Type',
      cell: ({ row }) => {
        return <ApiTypeBadge type={row.original.type} />
      },
    },
    {
      accessorKey: 'authentication.type',
      header: 'Auth',
      cell: ({ row }) => {
        const auth = row.original.authentication?.type
        const AuthIcon = getAuthTypeIcon(auth)
        return (
          <div className="flex items-center space-x-1">
            <AuthIcon className="h-4 w-4" />
            <span className="text-sm">
              {!auth || auth === 'none' ? 'None' : auth.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
            </span>
          </div>
        )
      },
    },
    {
      accessorKey: 'tools',
      header: 'Tools',
      cell: ({ row }) => {
        const api = row.original
        const apiToolCount = allTools.filter((tool: any) =>
          tool.metadata?.sourceApi?.id === api.id || tool.apiId === api.id
        ).length
        return (
          <div className="text-center">
            <span className="font-medium">{apiToolCount}</span>
          </div>
        )
      },
    },
    {
      accessorKey: 'operations',
      header: 'Operations',
      cell: ({ row }) => {
        const opCount = row.original.operations?.length || 0
        return (
          <div className="text-center">
            <span className="font-medium">{opCount}</span>
          </div>
        )
      },
    },
    createActionsColumn<Api>(
      (api) => {
        setEditingApi(api)
        setCreateDialogOpen(true)
      },
      (api) => setDeletingApi(api),
      [
        {
          label: 'View Details',
          onClick: (api) => navigate(`/apis/${api.id}`),
        },
        {
          label: 'Test Connection',
          onClick: (api) => {
            setSelectedApi(api)
            testApiMutation.mutate({ id: api.id })
          },
        },
        {
          label: 'Import Schema',
          onClick: (api) => {
            setSelectedApi(api)
            setUploadDialogOpen(true)
          },
        },
        {
          label: 'Generate Tools',
          onClick: (api) => generateToolsMutation.mutate({ id: api.id }),
        },
        {
          label: 'Copy Base URL',
          onClick: (api) => {
            navigator.clipboard.writeText(api.baseUrl)
            success('Copied', 'Base URL copied to clipboard')
          },
        },
      ]
    ),
  ]

  if (isError) {
    return <QueryError error={apisError} onRetry={() => refetchApis()} title="Couldn't load APIs" />
  }

  const apisExtracted = apisData?.apis || apisData || []
  const apis = Array.isArray(apisExtracted) ? apisExtracted : []
  const operationsExtracted = apiOperations?.operations || apiOperations || []
  const operations = Array.isArray(operationsExtracted) ? operationsExtracted : []

  const filteredApis = apis.filter((api: Api) => {
    const matchesSearch =
      api.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (api.description || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
      api.baseUrl.toLowerCase().includes(searchQuery.toLowerCase())

    const matchesType = typeFilter === 'all' || api.type === typeFilter
    const matchesHealth = healthFilter === 'all' || api.healthStatus === healthFilter

    return matchesSearch && matchesType && matchesHealth
  })

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-heading font-extrabold tracking-tight bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">APIs</h1>
          <p className="text-muted-foreground">
            {apis.length} connected &middot; {apis.reduce((sum: number, a: any) => sum + (a.operations?.length || 0), 0)} operations &middot; {allToolsTotal} tools generated
          </p>
        </div>
        <div className="flex items-center space-x-2">
          <Dialog open={createDialogOpen} onOpenChange={(open) => {
            setCreateDialogOpen(open)
            if (!open) {
              setEditingApi(null)
              setCreateStep('details')
              setCreatedApiForSchema(null)
            }
          }}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Connect API
              </Button>
            </DialogTrigger>
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
                        setCreateDialogOpen(false)
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
                    onClick={() => setCreateDialogOpen(false)}
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
        </div>
      </div>

      {apis.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mb-4">
              <Globe className="h-8 w-8 text-primary" />
            </div>
            <h3 className="text-xl font-semibold mb-2">No APIs</h3>
            <p className="text-muted-foreground mb-6 text-center max-w-md">
              Create your first API to get started. We support OpenAPI, GraphQL, SOAP, and gRPC protocols.
            </p>
            <Button size="lg" onClick={() => setCreateDialogOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Connect Your First API
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardContent className="pt-6 space-y-4">
              {/* Filters */}
              <div className="flex items-center gap-4">
                <div className="flex-1">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Search APIs..."
                      className="pl-10"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                  </div>
                </div>
                <Select value={typeFilter} onValueChange={setTypeFilter}>
                  <SelectTrigger className="w-40">
                    <SelectValue placeholder="Type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Types</SelectItem>
                    <SelectItem value={ApiType.OPENAPI}>OpenAPI</SelectItem>
                    <SelectItem value={ApiType.GRAPHQL}>GraphQL</SelectItem>
                    <SelectItem value={ApiType.SOAP}>SOAP</SelectItem>
                    <SelectItem value={ApiType.GRPC}>gRPC</SelectItem>
                    <SelectItem value={ApiType.HTTP}>Custom HTTP</SelectItem>
                    <SelectItem value={ApiType.SDK}>SDK / npm</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={healthFilter} onValueChange={setHealthFilter}>
                  <SelectTrigger className="w-40">
                    <SelectValue placeholder="Health" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Status</SelectItem>
                    <SelectItem value={ApiHealthStatus.HEALTHY}>Healthy</SelectItem>
                    <SelectItem value={ApiHealthStatus.DEGRADED}>Degraded</SelectItem>
                    <SelectItem value={ApiHealthStatus.UNHEALTHY}>Unhealthy</SelectItem>
                    <SelectItem value={ApiHealthStatus.UNKNOWN}>Unknown</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <DataTable
                columns={apiColumns}
                data={filteredApis}
                loading={isLoading}
                onRowClick={(api) => navigate(`/apis/${api.id}`)}
                hideSelectionCount
                hideColumnsButton
                emptyState={
                  apis.length === 0 ? (
                    <EmptyState
                      icon={Globe}
                      title="Connect your first API"
                      description="Point almyty at an OpenAPI, GraphQL, SOAP, Protobuf, or SDK package and every operation becomes a tool your agents can call."
                      action={
                        <Button onClick={() => setCreateDialogOpen(true)}>
                          <Plus className="h-4 w-4 mr-2" />
                          Import API
                        </Button>
                      }
                      className="py-16"
                    />
                  ) : undefined
                }
              />
            </CardContent>
          </Card>
        </>
      )}

      <SchemaImportDialog
        open={uploadDialogOpen}
        onOpenChange={setUploadDialogOpen}
        apiType={selectedApi?.type || ApiType.OPENAPI}
        onImport={handleImportSchema}
        isLoading={importSchemaMutation.isPending}
      />

      <AlertDialog open={!!deletingApi} onOpenChange={(open) => !open && setDeletingApi(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the API "{deletingApi?.name}" and all associated tools and operations.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deletingApi) {
                  deleteApiMutation.mutate(deletingApi.id)
                }
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ApiDetailDialog
        open={apiDetailsOpen}
        onOpenChange={setApiDetailsOpen}
        selectedApi={selectedApi}
        operations={operations}
        allTools={allTools}
        testResults={testResults}
        onOpenUploadDialog={() => setUploadDialogOpen(true)}
        generateToolsMutation={generateToolsMutation}
        testApiMutation={testApiMutation}
        onCopySuccess={success}
      />

    </div>
  )
}
