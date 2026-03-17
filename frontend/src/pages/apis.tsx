import React from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { ColumnDef } from '@tanstack/react-table'
import {
  Plus, Upload, FileCode, TestTube, Settings, Play, Pause,
  CheckCircle, XCircle, AlertCircle, Globe, Database, Cloud,
  Code, FileText, Zap, Activity, BarChart3, Shield, Key,
  Search, ExternalLink, Download, Eye, Edit, Trash2,
  Server, Webhook, Lock, Unlock, Copy, ChevronRight
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
import { Checkbox } from '@/components/ui/checkbox'
import { SchemaImportDialog } from '@/components/SchemaImportDialog'

import { apisApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'
import { useNotifications } from '@/store/app'
import { formatDate, formatDateTime, cn } from '@/lib/utils'
import { Api, ApiType, ApiHealthStatus, ApiAuthType, SchemaFormat, ApiOperation } from '@/types'

const createApiSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  description: z.string().optional(),
  type: z.nativeEnum(ApiType),
  baseUrl: z.string().url('Please enter a valid URL'),
  version: z.string().optional(),
  configuration: z.record(z.any()).optional(),
  authentication: z.object({
    type: z.nativeEnum(ApiAuthType),
    config: z.record(z.any()),
  }).optional(),
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

type CreateApiFormData = z.infer<typeof createApiSchema>
type ImportSchemaFormData = z.infer<typeof importSchemaSchema>

export function ApisPage() {
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

  const allToolsExtracted = allToolsData?.data?.data?.tools || allToolsData?.data?.tools || []
  const allTools = Array.isArray(allToolsExtracted) ? allToolsExtracted : []
  
  const [selectedApi, setSelectedApi] = React.useState<Api | null>(null)
  const [editingApi, setEditingApi] = React.useState<Api | null>(null)
  const [deletingApi, setDeletingApi] = React.useState<Api | null>(null)
  const [createDialogOpen, setCreateDialogOpen] = React.useState(false)
  const [createStep, setCreateStep] = React.useState<'details' | 'schema'>('details')
  const [createdApiForSchema, setCreatedApiForSchema] = React.useState<Api | null>(null)
  const [uploadDialogOpen, setUploadDialogOpen] = React.useState(false)
  const [apiDetailsOpen, setApiDetailsOpen] = React.useState(false)
  const [testResults, setTestResults] = React.useState<any>(null)
  const [uploadFile, setUploadFile] = React.useState<File | null>(null)
  const [selectedAuthType, setSelectedAuthType] = React.useState<ApiAuthType>(ApiAuthType.NONE)
  const [selectedApiType, setSelectedApiType] = React.useState<ApiType>(ApiType.OPENAPI)
  const [searchQuery, setSearchQuery] = React.useState('')
  const [typeFilter, setTypeFilter] = React.useState('all')
  const [healthFilter, setHealthFilter] = React.useState('all')

  const { data: apisData, isLoading } = useQuery({
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
      setCreatedApiForSchema(response.data)
      setSelectedApi(response.data)
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
      const response = await apisApi.importSchema(id, data, file)

      // If response contains jobId, poll for completion
      if (response.data?.jobId) {
        console.log('[UI] Got jobId, starting polling:', response.data.jobId)
        try {
          const result = await apisApi.pollImportStatus(id, response.data.jobId)
          console.log('[UI] Polling completed, result:', result)
          return { data: result }
        } catch (pollError) {
          console.error('[UI] Polling failed:', pollError)
          throw pollError
        }
      }

      return response
    },
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      queryClient.invalidateQueries({ queryKey: ['api-operations'] })
      queryClient.invalidateQueries({ queryKey: ['tools'] })
      queryClient.invalidateQueries({ queryKey: ['tools', currentOrganization?.id] })
      // Force refetch for currently displayed API operations
      if (selectedApi) {
        queryClient.refetchQueries({ queryKey: ['api-operations', selectedApi.id] })
      }
      const result = response.data
      // Handle both direct result and async job result formats
      // For async jobs: response.data.result contains the job's returnvalue
      const jobResult = result.result || result
      const opCount = jobResult.operations?.length || jobResult.operationCount || 0
      const toolCount = jobResult.tools?.length || jobResult.toolCount || 0
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
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      queryClient.invalidateQueries({ queryKey: ['tools'] })
      queryClient.invalidateQueries({ queryKey: ['tools', currentOrganization?.id] })
      const toolCount = response.data?.length || 0
      success('Tools generated', `${toolCount} tools have been generated successfully.`)
    },
    onError: (err: any) => {
      error('Failed to generate tools', err.response?.data?.message || 'Please try again.')
    },
  })

  const testApiMutation = useMutation({
    mutationFn: ({ id }: { id: string }) => apisApi.testConnection(id),
    onSuccess: (response) => {
      setTestResults(response.data)
      success('API test completed', 'Connection test results are available.')
    },
    onError: (err: any) => {
      setTestResults({ error: err.response?.data?.message || 'Test failed' })
      error('API test failed', err.response?.data?.message || 'Please try again.')
    },
  })

  const createForm = useForm<CreateApiFormData>({
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
    } else {
      // Create new API
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
      default: return 'text-gray-500'
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
            <div className="relative">
              <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
                <TypeIcon className="h-5 w-5 text-primary" />
              </div>
              <HealthIcon className={cn('absolute -top-1 -right-1 h-4 w-4', getHealthStatusColor(api.healthStatus))} />
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

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  const apisExtracted = apisData?.data?.data?.apis || apisData?.data?.apis || []
  const apis = Array.isArray(apisExtracted) ? apisExtracted : []
  const operationsExtracted = apiOperations?.data?.data?.operations || apiOperations?.data?.operations || apiOperations?.data || []
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
          <h1 className="text-3xl font-bold tracking-tight">APIs</h1>
          <p className="text-muted-foreground">
            Connect and manage your REST, GraphQL, SOAP, and gRPC APIs
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
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                
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

                {/* Authentication Configuration Fields */}
                {selectedAuthType === ApiAuthType.API_KEY && (
                  <div className="space-y-4">
                    <div>
                      <Label htmlFor="apiKey">API Key</Label>
                      <Input
                        id="apiKey"
                        type="password"
                        placeholder="Enter your API key"
                        onChange={(e) => createForm.setValue('authentication.config.apiKey', e.target.value)}
                      />
                    </div>
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
                  <div>
                    <Label htmlFor="bearerToken">Bearer Token</Label>
                    <Input
                      id="bearerToken"
                      type="password"
                      placeholder="Enter bearer token"
                      onChange={(e) => createForm.setValue('authentication.config.token', e.target.value)}
                    />
                  </div>
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
                      <div>
                        <Label htmlFor="clientSecret">Client Secret</Label>
                        <Input
                          id="clientSecret"
                          type="password"
                          placeholder="Your OAuth client secret"
                          onChange={(e) => createForm.setValue('authentication.config.clientSecret', e.target.value)}
                        />
                      </div>
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
                    disabled={createApiMutation.isPending || updateApiMutation.isPending}
                  >
                    {editingApi
                      ? (updateApiMutation.isPending ? 'Saving...' : 'Save Changes')
                      : (createApiMutation.isPending ? 'Connecting...' : 'Connect API')}
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
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Total APIs</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{apis.length}</div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Total Operations</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {apis.reduce((sum: number, a: any) => sum + (a.operations?.length || 0), 0)}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Tools Generated</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {apis.reduce((sum: number, api: any) => sum + (api.operations?.reduce((t: number, op: any) => t + (op.tools?.length || 0), 0) || 0), 0)}
                </div>
              </CardContent>
            </Card>
          </div>

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
                onRowClick={(api) => navigate(`/apis/${api.id}`)}
                hideSelectionCount
                hideColumnsButton
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

      <Dialog open={apiDetailsOpen} onOpenChange={setApiDetailsOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center space-x-2">
              {selectedApi && (
                <>
                  <div className="w-8 h-8 bg-primary/10 rounded-lg flex items-center justify-center">
                    {React.createElement(getApiTypeIcon(selectedApi.type), { className: "h-4 w-4" })}
                  </div>
                  <span>{selectedApi.name}</span>
                  <Badge variant={selectedApi.healthStatus === ApiHealthStatus.HEALTHY ? 'success' : 'destructive'}>
                    {selectedApi.healthStatus}
                  </Badge>
                </>
              )}
            </DialogTitle>
            <DialogDescription>
              Manage API configuration, operations, and generated tools
            </DialogDescription>
          </DialogHeader>

          {selectedApi && (
            <Tabs defaultValue="overview" className="w-full mt-6">
              <TabsList className="grid w-full grid-cols-5">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="operations">Operations</TabsTrigger>
                <TabsTrigger value="auth">Authentication</TabsTrigger>
                <TabsTrigger value="schema">Schema</TabsTrigger>
                <TabsTrigger value="test">Test</TabsTrigger>
              </TabsList>

              <TabsContent value="overview" className="space-y-4">
                <div className="grid gap-4 md:grid-cols-3">
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium">Health Status</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="flex items-center space-x-2">
                        {React.createElement(getHealthStatusIcon(selectedApi.healthStatus), {
                          className: cn('h-6 w-6', getHealthStatusColor(selectedApi.healthStatus))
                        })}
                        <span className="font-medium capitalize">{selectedApi.healthStatus}</span>
                      </div>
                    </CardContent>
                  </Card>
                  
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium">API Type</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <Badge variant="outline" className="text-base">
                        {selectedApi.type.toUpperCase()}
                      </Badge>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium">Base URL</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="flex items-center space-x-2">
                        <code className="bg-muted px-2 py-1 rounded text-sm truncate">
                          {selectedApi.baseUrl}
                        </code>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            navigator.clipboard.writeText(selectedApi.baseUrl)
                            success('Copied', 'Base URL copied to clipboard')
                          }}
                        >
                          <Copy className="h-3 w-3" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">API Information</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      <div className="flex justify-between">
                        <span>Version</span>
                        <span className="font-medium">{selectedApi.version || 'Not specified'}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Authentication</span>
                        <div className="flex items-center space-x-1">
                          {React.createElement(getAuthTypeIcon(selectedApi.authentication?.type), {
                            className: 'h-4 w-4'
                          })}
                          <span className="text-sm">
                            {selectedApi.authentication?.type?.replace('_', ' ').toUpperCase() || 'None'}
                          </span>
                        </div>
                      </div>
                      <div className="flex justify-between">
                        <span>Last Tested</span>
                        <span className="text-sm">
                          {selectedApi.lastTestedAt ? formatDateTime(selectedApi.lastTestedAt) : 'Never'}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span>Status</span>
                        <Badge variant={selectedApi.isActive ? 'success' : 'secondary'}>
                          {selectedApi.isActive ? 'Active' : 'Inactive'}
                        </Badge>
                      </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Generated Assets</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      <div className="flex justify-between">
                        <span>Tools Generated</span>
                        <span className="font-medium">{allTools.filter((t: any) => t.metadata?.apiId === selectedApi.id || (t.operationId && selectedApi.operations?.some((op: any) => op.id === t.operationId))).length}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Operations Parsed</span>
                        <span className="font-medium">{operations.length}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Schema Format</span>
                        <span className="text-sm">
                          {selectedApi.schema?.format?.toUpperCase() || 'Not uploaded'}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span>Schema Version</span>
                        <span className="text-sm">
                          {selectedApi.schema?.version || 'Unknown'}
                        </span>
                      </div>
                    </CardContent>
                  </Card>
                </div>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Quick Actions</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-4">
                      <Button
                        variant="outline"
                        onClick={() => {
                          setUploadDialogOpen(true)
                        }}
                      >
                        <Upload className="mr-2 h-4 w-4" />
                        Import Schema
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => generateToolsMutation.mutate({ id: selectedApi.id })}
                        disabled={generateToolsMutation.isPending}
                      >
                        <Zap className="mr-2 h-4 w-4" />
                        Generate Tools
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => testApiMutation.mutate({ id: selectedApi.id })}
                        disabled={testApiMutation.isPending}
                      >
                        <TestTube className="mr-2 h-4 w-4" />
                        Test Connection
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => window.open(selectedApi.baseUrl, '_blank')}
                      >
                        <ExternalLink className="mr-2 h-4 w-4" />
                        Open API
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="operations" className="space-y-4">
                <div className="flex justify-between items-center">
                  <h3 className="text-lg font-medium">API Operations</h3>
                  <Badge variant="outline">
                    {operations.length} operations
                  </Badge>
                </div>
                
                <div className="grid gap-4">
                  {operations.map((operation: ApiOperation) => (
                    <Card key={operation.id}>
                      <CardContent className="flex items-center justify-between p-4">
                        <div className="flex items-center space-x-3">
                          <div className="w-8 h-8 bg-secondary rounded-lg flex items-center justify-center">
                            <Code className="h-4 w-4" />
                          </div>
                          <div>
                            <div className="font-medium">{operation.name}</div>
                            <div className="text-sm text-muted-foreground">
                              {operation.description || 'No description'}
                            </div>
                            <div className="flex items-center space-x-2 mt-1">
                              {operation.method && (
                                <Badge variant="outline" className="text-xs">
                                  {operation.method}
                                </Badge>
                              )}
                              {operation.path && (
                                <code className="text-xs bg-muted px-1 rounded">
                                  {operation.path}
                                </code>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center space-x-2">
                          <Badge variant="secondary">
                            {operation.parameters?.length || 0} params
                          </Badge>
                          <Button size="sm" variant="ghost">
                            <ChevronRight className="h-4 w-4" />
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                  
                  {operations.length === 0 && (
                    <div className="text-center py-8 text-muted-foreground">
                      No operations found. Upload a schema to parse API operations.
                    </div>
                  )}
                </div>
              </TabsContent>

              <TabsContent value="auth" className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle>Authentication Configuration</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div>
                      <Label>Authentication Type</Label>
                      <Select defaultValue={selectedApi.authentication?.type || ApiAuthType.NONE}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={ApiAuthType.NONE}>No Authentication</SelectItem>
                          <SelectItem value={ApiAuthType.API_KEY}>API Key</SelectItem>
                          <SelectItem value={ApiAuthType.BEARER_TOKEN}>Bearer Token</SelectItem>
                          <SelectItem value={ApiAuthType.BASIC_AUTH}>Basic Auth</SelectItem>
                          <SelectItem value={ApiAuthType.OAUTH2}>OAuth 2.0</SelectItem>
                          <SelectItem value={ApiAuthType.CUSTOM}>Custom</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    
                    {selectedApi.authentication?.type === ApiAuthType.API_KEY && (
                      <>
                        <div>
                          <Label>API Key</Label>
                          <Input 
                            type="password"
                            placeholder="Enter API key"
                            defaultValue={selectedApi.authentication.config.apiKey}
                          />
                        </div>
                        <div>
                          <Label>Header Name</Label>
                          <Input 
                            placeholder="X-API-Key"
                            defaultValue={selectedApi.authentication.config.headerName || 'X-API-Key'}
                          />
                        </div>
                      </>
                    )}
                    
                    {selectedApi.authentication?.type === ApiAuthType.BEARER_TOKEN && (
                      <div>
                        <Label>Bearer Token</Label>
                        <Input 
                          type="password"
                          placeholder="Enter bearer token"
                          defaultValue={selectedApi.authentication.config.token}
                        />
                      </div>
                    )}
                    
                    {selectedApi.authentication?.type === ApiAuthType.BASIC_AUTH && (
                      <>
                        <div>
                          <Label>Username</Label>
                          <Input 
                            placeholder="Enter username"
                            defaultValue={selectedApi.authentication.config.username}
                          />
                        </div>
                        <div>
                          <Label>Password</Label>
                          <Input 
                            type="password"
                            placeholder="Enter password"
                            defaultValue={selectedApi.authentication.config.password}
                          />
                        </div>
                      </>
                    )}
                    
                    <div className="pt-4">
                      <Button>Save Authentication</Button>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="schema" className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle>API Schema</CardTitle>
                    <CardDescription>
                      View and manage the API schema definition
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {selectedApi.schema ? (
                      <>
                        <div className="grid gap-4 md:grid-cols-2">
                          <div>
                            <Label>Schema Format</Label>
                            <p className="text-sm">{selectedApi.schema.format.toUpperCase()}</p>
                          </div>
                          <div>
                            <Label>Schema Version</Label>
                            <p className="text-sm">{selectedApi.schema.version || 'Unknown'}</p>
                          </div>
                        </div>
                        
                        <div>
                          <Label>Schema Content</Label>
                          <div className="bg-muted p-4 rounded-md mt-2 max-h-96 overflow-y-auto">
                            <pre className="text-sm">
                              {JSON.stringify(selectedApi.schema.content, null, 2)}
                            </pre>
                          </div>
                        </div>
                        
                        <div className="flex space-x-2">
                          <Button variant="outline">
                            <Download className="mr-2 h-4 w-4" />
                            Download Schema
                          </Button>
                          <Button variant="outline" onClick={() => setUploadDialogOpen(true)}>
                            <Upload className="mr-2 h-4 w-4" />
                            Update Schema
                          </Button>
                        </div>
                      </>
                    ) : (
                      <div className="text-center py-8">
                        <FileCode className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
                        <h3 className="text-lg font-medium mb-2">No Schema Uploaded</h3>
                        <p className="text-muted-foreground mb-4">
                          Upload an API schema to automatically generate tools and operations.
                        </p>
                        <Button onClick={() => setUploadDialogOpen(true)}>
                          <Upload className="mr-2 h-4 w-4" />
                          Import Schema
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="test" className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle>API Connection Test</CardTitle>
                    <CardDescription>
                      Test the API connection and verify authentication
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex space-x-2">
                      <Button
                        onClick={() => testApiMutation.mutate({ id: selectedApi.id })}
                        disabled={testApiMutation.isPending}
                      >
                        {testApiMutation.isPending ? (
                          <LoadingSpinner className="mr-2" />
                        ) : (
                          <TestTube className="mr-2 h-4 w-4" />
                        )}
                        {testApiMutation.isPending ? 'Testing...' : 'Test Connection'}
                      </Button>
                      <Button variant="outline" onClick={() => window.open(selectedApi.baseUrl, '_blank')}>
                        <ExternalLink className="mr-2 h-4 w-4" />
                        Open in Browser
                      </Button>
                    </div>
                    
                    {testResults && (
                      <div className="mt-4">
                        <Label>Test Results</Label>
                        <div className="bg-muted p-4 rounded-md mt-2">
                          <pre className="text-sm overflow-x-auto">
                            {JSON.stringify(testResults, null, 2)}
                          </pre>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}