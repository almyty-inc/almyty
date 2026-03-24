import React, { useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft, Upload, Zap, Copy, Code, Globe, Database, Cloud, Server, TestTube, Edit, Plus, Trash2, Key, Shield, Check,
  Search, ExternalLink, ChevronRight
} from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { SchemaImportDialog } from '@/components/SchemaImportDialog'

import { apisApi, toolsApi } from '@/lib/api'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import { Api, ApiType, ApiAuthType, ApiOperation, ApiCredential, Tool } from '@/types'

const CREDENTIAL_TYPE_LABELS: Record<string, string> = {
  API_KEY: 'API Key',
  BEARER_TOKEN: 'Bearer Token',
  BASIC_AUTH: 'Basic Auth',
  OAUTH2: 'OAuth 2.0',
  JWT: 'JWT',
  CUSTOM: 'Custom',
}

function ApiCredentialsSection({ apiId, apiName }: { apiId: string; apiName: string }) {
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

  const credsRaw = credsData?.data?.credentials || credsData?.data || []
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
              <div key={cred.id} className="flex items-center justify-between px-3 py-2 bg-muted/50 rounded-lg">
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

export function ApiDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { success, error } = useNotifications()
  const { currentOrganization } = useOrganizationStore()
  const queryClient = useQueryClient()

  const [uploadDialogOpen, setUploadDialogOpen] = React.useState(false)
  const [uploadFile, setUploadFile] = React.useState<File | null>(null)
  const [testResults, setTestResults] = React.useState<Record<string, unknown> | null>(null)
  const [testing, setTesting] = React.useState(false)
  const [schemaDialogOpen, setSchemaDialogOpen] = React.useState(false)
  const [authDialogOpen, setAuthDialogOpen] = React.useState(false)
  const [authType, setAuthType] = React.useState<ApiAuthType>(ApiAuthType.NONE)
  const [authConfig, setAuthConfig] = React.useState<Record<string, string>>({})
  const [selectedOperation, setSelectedOperation] = React.useState<ApiOperation | null>(null)
  const [operationSearch, setOperationSearch] = React.useState('')
  const [methodFilter, setMethodFilter] = React.useState<string>('ALL')

  const { data: apiData, isLoading } = useQuery({
    queryKey: ['api', id],
    queryFn: () => apisApi.getById(id!),
    enabled: !!id,
  })

  const { data: apiOperations } = useQuery({
    queryKey: ['api-operations', id],
    queryFn: () => id ? apisApi.getOperations(id) : null,
    enabled: !!id,
  })

  // Get all tools to count those from this API
  const { data: allToolsData } = useQuery({
    queryKey: ['tools', currentOrganization?.id],
    queryFn: () => toolsApi.getAll(currentOrganization?.id),
    enabled: !!currentOrganization,
  })

  const allToolsExtracted = allToolsData?.data?.tools || allToolsData?.data || []
  const allTools = Array.isArray(allToolsExtracted) ? allToolsExtracted : []
  const apiTools = allTools.filter((tool: Tool) => tool.metadata?.sourceApi?.id === id || (tool as unknown as Record<string, string>).apiId === id)

  // Initialize auth state when API loads
  React.useEffect(() => {
    if (apiData?.data) {
      setAuthType(apiData.data.authentication?.type || ApiAuthType.NONE)
      setAuthConfig(apiData.data.authentication?.config || {})
    }
  }, [apiData])

  const importSchemaMutation = useMutation({
    mutationFn: async ({ data, file }: { data: { schemaContent?: string; schemaUrl?: string; description?: string; generateTools?: boolean }; file?: File }) => {
      if (!id) throw new Error('No API ID')
      const response = await apisApi.importSchema(id, data, file)

      if (response.data?.jobId) {
        const result = await apisApi.pollImportStatus(id, response.data.jobId)
        return { data: result }
      }
      return response
    },
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ['api', id] })
      queryClient.invalidateQueries({ queryKey: ['api-operations', id] })
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      queryClient.invalidateQueries({ queryKey: ['tools'] })
      const result = response.data
      const jobResult = result.result || result
      const opCount = jobResult.operations?.length || jobResult.operationCount || 0
      const toolCount = jobResult.tools?.length || jobResult.toolCount || 0
      success('Schema imported', `${opCount} operations found, ${toolCount} tools generated.`)
      setUploadDialogOpen(false)
      setUploadFile(null)
    },
    onError: (err: Error & { response?: { data?: { message?: string } } }) => {
      error('Failed to import schema', err.response?.data?.message || err.message || 'Please try again.')
    },
  })

  const getApiTypeIcon = (type: ApiType) => {
    switch (type) {
      case ApiType.OPENAPI: return Globe
      case ApiType.GRAPHQL: return Database
      case ApiType.SOAP: return Cloud
      case ApiType.GRPC: return Server
      default: return Code
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  if (!apiData?.data) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-center">
          <p className="text-muted-foreground">API not found</p>
          <Button className="mt-4" onClick={() => navigate('/apis')}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to APIs
          </Button>
        </div>
      </div>
    )
  }

  const api = apiData.data
  const operationsExtracted = apiOperations?.data?.operations || apiOperations?.data || []
  const operations = Array.isArray(operationsExtracted) ? operationsExtracted : []
  const TypeIcon = getApiTypeIcon(api.type)

  return (
    <div className="space-y-8">
      {/* Breadcrumbs */}
      <div className="flex items-center gap-1 text-sm text-muted-foreground">
        <Link to="/apis" className="hover:text-foreground">APIs</Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-foreground">{api.name}</span>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <Button variant="outline" size="sm" onClick={() => navigate('/apis')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center space-x-3">
            <div className="w-12 h-12 bg-primary/10 rounded-lg flex items-center justify-center">
              <TypeIcon className="h-6 w-6 text-primary" />
            </div>
            <div>
              <h1 className="text-3xl font-bold tracking-tight">{api.name}</h1>
              <p className="text-muted-foreground">{api.baseUrl}</p>
            </div>
          </div>
        </div>
        <div className="flex items-center space-x-2">
          <Badge variant="outline">{api.type.toUpperCase()}</Badge>
          {api.version && <Badge variant="secondary">v{api.version}</Badge>}
        </div>
      </div>

      {/* Info Cards - Redesigned */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">API Content</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Operations</span>
              <span className="font-bold">{operations.length}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Tools Generated</span>
              <button
                onClick={() => navigate('/tools')}
                className="font-bold text-blue-600 hover:underline"
              >
                {apiTools.length}
              </button>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Schema</span>
              {api.schemas && api.schemas.length > 0 ? (
                <div className="flex gap-1">
                  <Button variant="ghost" size="sm" className="h-auto p-1 text-xs" onClick={() => setSchemaDialogOpen(true)}>
                    View
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto p-1 text-xs"
                    onClick={() => {
                      const schemaContent = api.schemas[0].processedSchema || api.schemas[0].rawSchema || api.schemas[0].content
                      const blob = new Blob([JSON.stringify(schemaContent, null, 2)], { type: 'application/json' })
                      const url = URL.createObjectURL(blob)
                      const a = document.createElement('a')
                      a.href = url
                      a.download = `${api.name}-schema.json`
                      a.click()
                    }}
                  >
                    Download
                  </Button>
                </div>
              ) : (
                <span className="text-sm">Not uploaded</span>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Configuration</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Type</span>
              <Badge variant="outline">{api.type.toUpperCase()}</Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Version</span>
              <span className="text-sm">{api.version || '1.0.0'}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Authentication</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-auto p-0 text-xs"
                onClick={() => setAuthDialogOpen(true)}
              >
                {api.authentication?.type?.replace('_', ' ').toUpperCase() || 'NONE'}
                <Edit className="h-3 w-3 ml-1" />
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Quick Actions */}
      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={() => setUploadDialogOpen(true)}>
          <Upload className="mr-2 h-4 w-4" />
          {api.schemas && api.schemas.length > 0 ? 'Update Schema' : 'Import Schema'}
        </Button>
        {operations.length > 0 && (
          <Button
            onClick={async () => {
              try {
                const response = await apisApi.generateTools(id!)
                queryClient.invalidateQueries({ queryKey: ['api', id] })
                queryClient.invalidateQueries({ queryKey: ['apis'] })
                queryClient.invalidateQueries({ queryKey: ['tools'] })
                const toolCount = response.data?.length || 0
                success('Tools generated', `${toolCount} tools created successfully`)
              } catch (err: any) {
                error('Failed to generate tools', err.response?.data?.message || 'Please try again.')
              }
            }}
          >
            <Zap className="mr-2 h-4 w-4" />
            {apiTools.length > 0 ? 'Re-generate Tools' : `Generate ${operations.length} Tools`}
          </Button>
        )}
        <Button
          variant="outline"
          onClick={async () => {
            setTesting(true)
            setTestResults(null)
            try {
              const response = await apisApi.testConnection(id!)
              setTestResults(response.data)
              success('Test completed', 'API connection test successful')
            } catch (err: any) {
              setTestResults({ success: false, error: err.response?.data?.message || 'Connection failed' })
              error('Test failed', err.response?.data?.message || 'Please try again.')
            } finally {
              setTesting(false)
            }
          }}
          disabled={testing}
        >
          <TestTube className="mr-2 h-4 w-4" />
          {testing ? 'Testing...' : 'Test Connection'}
        </Button>
        <Button
          variant="outline"
          onClick={() => navigate(`/gateways?apiId=${id}&apiName=${encodeURIComponent(api.name)}`)}
        >
          <ExternalLink className="mr-2 h-4 w-4" />
          Expose via Gateway
        </Button>
      </div>

      {/* Upstream Credentials */}
      <ApiCredentialsSection apiId={api.id} apiName={api.name} />

      {/* Test Results */}
      {testResults && (
        <Card className={testResults.success ? 'border-green-200 bg-green-50/50' : 'border-red-200 bg-red-50/50'}>
          <CardContent className="pt-6">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="font-medium">Test Results</h3>
                <Badge variant={testResults.success ? 'default' : 'destructive'}>
                  {testResults.success ? 'Success' : 'Failed'}
                </Badge>
              </div>
              <pre className="p-4 text-sm font-mono bg-muted/50 rounded-md overflow-auto max-h-96">
                {(() => {
                  try {
                    const data = typeof testResults === 'string' ? JSON.parse(testResults) : testResults
                    return JSON.stringify(data, null, 2)
                  } catch {
                    return String(testResults)
                  }
                })()}
              </pre>
            </div>
          </CardContent>
        </Card>
      )}


      {/* Operations List */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>API Operations</CardTitle>
              <p className="text-sm text-muted-foreground mt-1">
                {operations.length} operations parsed from schema
              </p>
            </div>
            {api.schema && (
              <Button variant="outline" size="sm" onClick={() => setUploadDialogOpen(true)}>
                <Upload className="mr-2 h-4 w-4" />
                Update Schema
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {operations.length === 0 ? (
            <div className="text-center py-12">
              <Code className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <p className="text-muted-foreground mb-4">
                No operations found. Import a schema to get started.
              </p>
              <Button onClick={() => setUploadDialogOpen(true)}>
                <Upload className="mr-2 h-4 w-4" />
                Import Schema
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Search and method filter */}
              <div className="flex items-center gap-3">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search operations by path or description..."
                    className="pl-10"
                    value={operationSearch}
                    onChange={(e) => setOperationSearch(e.target.value)}
                  />
                </div>
                <div className="flex gap-1">
                  {['ALL', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => (
                    <Button
                      key={method}
                      variant={methodFilter === method ? 'default' : 'outline'}
                      size="sm"
                      className="text-xs px-2"
                      onClick={() => setMethodFilter(method)}
                    >
                      {method === 'ALL' ? 'All' : method}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="space-y-2">
              {operations
                .filter((operation: ApiOperation) => {
                  const matchesSearch = !operationSearch ||
                    (operation.endpoint || operation.path || '').toLowerCase().includes(operationSearch.toLowerCase()) ||
                    (operation.name || '').toLowerCase().includes(operationSearch.toLowerCase()) ||
                    (operation.description || '').toLowerCase().includes(operationSearch.toLowerCase())
                  const matchesMethod = methodFilter === 'ALL' || operation.method === methodFilter
                  return matchesSearch && matchesMethod
                })
                .map((operation: ApiOperation) => (
                <div
                  key={operation.id}
                  className="flex items-center justify-between p-4 border rounded hover:bg-muted/50 cursor-pointer group"
                  onClick={() => setSelectedOperation(operation)}
                >
                  <div className="flex items-center space-x-3 flex-1">
                    {operation.method && (
                      <Badge
                        variant={
                          operation.method === 'GET' ? 'default' :
                          operation.method === 'POST' ? 'secondary' :
                          operation.method === 'PUT' ? 'outline' :
                          operation.method === 'DELETE' ? 'destructive' :
                          'outline'
                        }
                        className="font-mono w-20 justify-center"
                      >
                        {operation.method}
                      </Badge>
                    )}
                    <div className="flex-1">
                      {(operation.endpoint || operation.path) && (
                        <code className="text-sm font-mono font-medium block mb-1">
                          {operation.endpoint || operation.path}
                        </code>
                      )}
                      <div className="text-sm text-muted-foreground">{operation.name}</div>
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    {operation.parameters && operation.parameters.length > 0 && (
                      <Badge variant="outline" className="text-xs">
                        {operation.parameters.length} params
                      </Badge>
                    )}
                  </div>
                </div>
              ))}
              {operations.filter((operation: ApiOperation) => {
                const matchesSearch = !operationSearch ||
                  (operation.endpoint || operation.path || '').toLowerCase().includes(operationSearch.toLowerCase()) ||
                  (operation.name || '').toLowerCase().includes(operationSearch.toLowerCase()) ||
                  (operation.description || '').toLowerCase().includes(operationSearch.toLowerCase())
                const matchesMethod = methodFilter === 'ALL' || operation.method === methodFilter
                return matchesSearch && matchesMethod
              }).length === 0 && (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  No operations match your search.
                </div>
              )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Operation Detail Dialog */}
      <Dialog open={!!selectedOperation} onOpenChange={(open) => !open && setSelectedOperation(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {selectedOperation?.method && (
                <Badge variant="outline" className="font-mono">
                  {selectedOperation.method}
                </Badge>
              )}
              {selectedOperation?.endpoint || selectedOperation?.path}
            </DialogTitle>
          </DialogHeader>
          {selectedOperation && (
            <div className="space-y-4">
              <div>
                <Label>Description</Label>
                <p className="text-sm text-muted-foreground">{selectedOperation.name || 'No description'}</p>
              </div>

              <div>
                <Label>Full Endpoint</Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-muted p-2 rounded text-xs">
                    {api.baseUrl}{selectedOperation.endpoint || selectedOperation.path}
                  </code>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const fullEndpoint = `${api.baseUrl}${selectedOperation.endpoint || selectedOperation.path || ''}`
                      navigator.clipboard.writeText(fullEndpoint)
                      success('Copied', 'Full endpoint copied')
                    }}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {selectedOperation.parameters && (() => {
                const params = selectedOperation.parameters
                // Check if parameters is an array with items, or an object with non-empty values
                const hasContent = Array.isArray(params)
                  ? params.length > 0
                  : typeof params === 'object' && Object.values(params).some((v: unknown) =>
                      v && typeof v === 'object' ? (Array.isArray(v) ? v.length > 0 : Object.keys(v as Record<string, unknown>).length > 0) : !!v
                    )
                return (
                  <div>
                    <Label>Parameters</Label>
                    {hasContent ? (
                      <div className="bg-muted p-3 rounded text-xs max-h-48 overflow-y-auto">
                        <pre>{JSON.stringify(params, null, 2)}</pre>
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground mt-1">No parameters required</p>
                    )}
                  </div>
                )
              })()}

              <div>
                <Label>Related Tools</Label>
                <div className="space-y-1">
                  {apiTools.filter((tool: Tool) =>
                    (tool as unknown as Record<string, string>).operationId === selectedOperation.id ||
                    tool.metadata?.sourceOperation?.name === selectedOperation.name
                  ).length > 0 ? (
                    apiTools
                      .filter((tool: Tool) =>
                        (tool as unknown as Record<string, string>).operationId === selectedOperation.id ||
                        tool.metadata?.sourceOperation?.name === selectedOperation.name
                      )
                      .map((tool: Tool) => (
                        <div key={tool.id} className="flex items-center justify-between p-2 border rounded">
                          <span className="text-sm">{tool.name}</span>
                          <Button size="sm" variant="ghost" onClick={() => navigate(`/tools/${tool.id}`)}>
                            View Tool
                          </Button>
                        </div>
                      ))
                  ) : (
                    <p className="text-sm text-muted-foreground">No tools generated for this operation yet</p>
                  )}
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Schema Viewer Dialog */}
      <Dialog open={schemaDialogOpen} onOpenChange={setSchemaDialogOpen}>
        <DialogContent className="max-w-4xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle>Schema Content</DialogTitle>
          </DialogHeader>
          <div className="bg-muted p-4 rounded max-h-[60vh] overflow-y-auto">
            <pre className="text-xs">
              {api.schemas && api.schemas.length > 0 && JSON.stringify(api.schemas[0].processedSchema || api.schemas[0].rawSchema || api.schemas[0].content, null, 2)}
            </pre>
          </div>
        </DialogContent>
      </Dialog>

      {/* Authentication Dialog */}
      <Dialog open={authDialogOpen} onOpenChange={setAuthDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Configure Authentication</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Authentication Type</Label>
              <Select value={authType} onValueChange={(value) => setAuthType(value as ApiAuthType)}>
                <SelectTrigger>
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
                  <Label>Header Name</Label>
                  <Input
                    placeholder="X-API-Key"
                    value={authConfig.headerName || ''}
                    onChange={(e) => setAuthConfig({...authConfig, headerName: e.target.value})}
                  />
                </div>
                <div>
                  <Label>API Key</Label>
                  <Input
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
                <Label>Bearer Token</Label>
                <Input
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
                  <Label>Username</Label>
                  <Input
                    placeholder="Enter username"
                    value={authConfig.username || ''}
                    onChange={(e) => setAuthConfig({...authConfig, username: e.target.value})}
                  />
                </div>
                <div>
                  <Label>Password</Label>
                  <Input
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
                  <Label>Client ID</Label>
                  <Input
                    placeholder="Enter OAuth client ID"
                    value={authConfig.clientId || ''}
                    onChange={(e) => setAuthConfig({...authConfig, clientId: e.target.value})}
                  />
                </div>
                <div>
                  <Label>Client Secret</Label>
                  <Input
                    type="password"
                    placeholder="Enter client secret"
                    value={authConfig.clientSecret || ''}
                    onChange={(e) => setAuthConfig({...authConfig, clientSecret: e.target.value})}
                  />
                </div>
                <div>
                  <Label>Token URL</Label>
                  <Input
                    placeholder="https://oauth.example.com/token"
                    value={authConfig.tokenUrl || ''}
                    onChange={(e) => setAuthConfig({...authConfig, tokenUrl: e.target.value})}
                  />
                </div>
                <div>
                  <Label>Authorization URL (Optional)</Label>
                  <Input
                    placeholder="https://oauth.example.com/authorize"
                    value={authConfig.authUrl || ''}
                    onChange={(e) => setAuthConfig({...authConfig, authUrl: e.target.value})}
                  />
                </div>
              </>
            )}

            <div className="flex justify-end gap-2 pt-4">
              <Button variant="outline" onClick={() => {
                setAuthDialogOpen(false)
                setAuthType(api.authentication?.type || ApiAuthType.NONE)
                setAuthConfig(api.authentication?.config || {})
              }}>
                Cancel
              </Button>
              <Button onClick={async () => {
                try {
                  await apisApi.update(id!, {
                    authentication: { type: authType, config: authConfig }
                  })
                  queryClient.invalidateQueries({ queryKey: ['api', id] })
                  queryClient.invalidateQueries({ queryKey: ['apis'] })
                  success('Authentication updated', 'API authentication settings saved')
                  setAuthDialogOpen(false)
                } catch (err: any) {
                  error('Failed to update', err.response?.data?.message || 'Please try again.')
                }
              }}>
                Save
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <SchemaImportDialog
        open={uploadDialogOpen}
        onOpenChange={setUploadDialogOpen}
        apiType={api.type}
        onImport={(data) => importSchemaMutation.mutate({ data, file: uploadFile ?? undefined })}
        isLoading={importSchemaMutation.isPending}
      />
    </div>
  )
}
