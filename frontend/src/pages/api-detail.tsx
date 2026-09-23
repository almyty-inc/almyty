import React, { useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeft,
  ChevronRight,
  Cloud,
  Code,
  Database,
  Globe,
  Pencil,
  Server,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { DETAIL_TITLE_CLASSES } from '@/components/layout/page-header'
import { Badge } from '@/components/ui/badge'
import { ApiTypeBadge } from '@/components/ui/api-type-badge'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'

import { CredentialsTab } from '@/components/apis/detail/credentials-tab'
import { OperationsTab } from '@/components/apis/detail/operations-tab'
import { OverviewTab } from '@/components/apis/detail/overview-tab'
import { SchemaTab } from '@/components/apis/detail/schema-tab'
import { SecurityTab } from '@/components/apis/detail/security-tab'

import { apisApi, toolsApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'
import { ApiType, ApiOperation, Tool } from '@/types'

export function ApiDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { currentOrganization } = useOrganizationStore()

  // Both open in place on this page: the schema viewer, and the
  // authentication section's edit form.
  const [schemaOpen, setSchemaOpen] = React.useState(false)
  const [authEditing, setAuthEditing] = React.useState(false)

  const { data: apiData, isLoading, isError, error: apiError, refetch: refetchApi } = useQuery({
    queryKey: ['api', id],
    queryFn: () => apisApi.getById(id!),
    enabled: !!id,
  })

  // The API detail endpoint deliberately stopped eager-loading the schemas
  // relation (multi-MB rawSchema rows OOMed list views), so api.schemas is
  // always undefined there. Fetch schemas separately and merge below —
  // otherwise the overview panel permanently shows "Schema: Not uploaded"
  // even when a schema exists.
  const { data: schemasData } = useQuery({
    queryKey: ['api-schemas', id],
    queryFn: () => apisApi.getSchemas(id!),
    enabled: !!id,
  })


  useEffect(() => {
    const name = (apiData as any)?.name
    document.title = name ? `${name} | almyty` : 'API | almyty'
    return () => { document.title = 'almyty' }
  }, [apiData])
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

  if (isError) {
    return (
      <div className="flex items-center justify-center h-96">
        <QueryError
          error={apiError}
          onRetry={() => refetchApi()}
          title="Couldn't load API"
        />
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

  const schemas = Array.isArray(schemasData) ? schemasData : (schemasData as any)?.data || []
  const api = { ...(apiData as any), schemas } as typeof apiData & { schemas: any[] }
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
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center space-x-4">
          <Button variant="outline" size="sm" onClick={() => navigate('/apis')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center space-x-3">
            <div className="w-12 h-12 bg-primary/10 rounded-lg flex items-center justify-center">
              <TypeIcon className="h-6 w-6 text-primary" />
            </div>
            <div>
              <h1 className={DETAIL_TITLE_CLASSES}>{api.name}</h1>
              <p className="text-muted-foreground">{api.baseUrl}</p>
            </div>
          </div>
        </div>
        <div className="flex items-center space-x-2">
          <ApiTypeBadge type={api.type} />
          {api.version && <Badge variant="secondary">v{api.version}</Badge>}
          <Button variant="outline" size="sm" asChild>
            <Link to={`/apis/${api.id}/edit`}>
              <Pencil className="mr-2 h-4 w-4" />
              Edit
            </Link>
          </Button>
        </div>
      </div>

      <OverviewTab
        api={api}
        operations={operations}
        apiTools={apiTools}
        onOpenSchemaViewer={() => setSchemaOpen(true)}
        onOpenAuthConfig={() => setAuthEditing(true)}
        onOpenSchemaImport={() => navigate(`/apis/${api.id}/import`)}
      />

      <SchemaTab api={api} open={schemaOpen} onOpenChange={setSchemaOpen} />

      <SecurityTab api={api} editing={authEditing} onEditingChange={setAuthEditing} />

      <CredentialsTab apiId={api.id} apiName={api.name} />

      <OperationsTab
        api={api}
        operations={operations}
        apiTools={apiTools}
        onOpenSchemaImport={() => navigate(`/apis/${api.id}/import`)}
      />
    </div>
  )
}
