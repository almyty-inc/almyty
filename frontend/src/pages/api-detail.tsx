import React from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  ChevronRight,
  Cloud,
  Code,
  Database,
  Globe,
  Server,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { SchemaImportDialog } from '@/components/SchemaImportDialog'

import { CredentialsTab } from '@/components/apis/detail/credentials-tab'
import { OperationsTab } from '@/components/apis/detail/operations-tab'
import { OverviewTab } from '@/components/apis/detail/overview-tab'
import { SchemaTab } from '@/components/apis/detail/schema-tab'
import { SecurityTab } from '@/components/apis/detail/security-tab'

import { apisApi, toolsApi } from '@/lib/api'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import { ApiType, ApiOperation, Tool } from '@/types'

export function ApiDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { success, error } = useNotifications()
  const { currentOrganization } = useOrganizationStore()
  const queryClient = useQueryClient()

  const [uploadDialogOpen, setUploadDialogOpen] = React.useState(false)
  const [uploadFile, setUploadFile] = React.useState<File | null>(null)
  const [schemaDialogOpen, setSchemaDialogOpen] = React.useState(false)
  const [authDialogOpen, setAuthDialogOpen] = React.useState(false)

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

  const allToolsExtracted = allToolsData?.tools || allToolsData || []
  const allTools = Array.isArray(allToolsExtracted) ? allToolsExtracted : []
  const apiTools = allTools.filter((tool: Tool) => tool.metadata?.sourceApi?.id === id || (tool as unknown as Record<string, string>).apiId === id)

  const importSchemaMutation = useMutation({
    mutationFn: async ({ data, file }: { data: { schemaContent?: string; schemaUrl?: string; description?: string; generateTools?: boolean }; file?: File }) => {
      if (!id) throw new Error('No API ID')
      const importResult = await apisApi.importSchema(id, data, file)

      if (importResult?.jobId) {
        const result = await apisApi.pollImportStatus(id, importResult.jobId)
        return result
      }
      return importResult
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['api', id] })
      queryClient.invalidateQueries({ queryKey: ['api-operations', id] })
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      queryClient.invalidateQueries({ queryKey: ['tools'] })
      // Handle both direct result and async job result formats
      const jobResult = result?.result || result
      const opCount = jobResult?.operations?.length || jobResult?.operationCount || 0
      const toolCount = jobResult?.tools?.length || jobResult?.toolCount || 0
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

  if (!apiData) {
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

  const api = apiData
  const operationsExtracted = apiOperations?.operations || apiOperations || []
  const operations: ApiOperation[] = Array.isArray(operationsExtracted) ? operationsExtracted : []
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
              <h1 className="text-4xl font-heading font-extrabold tracking-tight">{api.name}</h1>
              <p className="text-muted-foreground">{api.baseUrl}</p>
            </div>
          </div>
        </div>
        <div className="flex items-center space-x-2">
          <Badge variant="outline">{api.type.toUpperCase()}</Badge>
          {api.version && <Badge variant="secondary">v{api.version}</Badge>}
        </div>
      </div>

      <OverviewTab
        api={api}
        operations={operations}
        apiTools={apiTools}
        onOpenSchemaViewer={() => setSchemaDialogOpen(true)}
        onOpenAuthConfig={() => setAuthDialogOpen(true)}
        onOpenSchemaImport={() => setUploadDialogOpen(true)}
      />

      <CredentialsTab apiId={api.id} apiName={api.name} />

      <OperationsTab
        api={api}
        operations={operations}
        apiTools={apiTools}
        onOpenSchemaImport={() => setUploadDialogOpen(true)}
      />

      <SchemaTab api={api} open={schemaDialogOpen} onOpenChange={setSchemaDialogOpen} />

      <SecurityTab api={api} open={authDialogOpen} onOpenChange={setAuthDialogOpen} />

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
