import React, { useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Pencil, Share2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { ResourceHeader } from '@/components/layout/resource-header'
import { Badge } from '@/components/ui/badge'
import { ApiTypeBadge } from '@/components/ui/api-type-badge'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { NotFoundState, QueryError } from '@/components/ui/query-error'

import { ApiKeyCard } from '@/components/apis/detail/key-card'
import { OperationsTab } from '@/components/apis/detail/operations-tab'
import { OverviewTab } from '@/components/apis/detail/overview-tab'
import { SchemaTab } from '@/components/apis/detail/schema-tab'
import { SdkPackagesCard } from '@/components/apis/detail/sdk-packages-card'

import { apisApi } from '@/lib/api'
import { isNotFoundError } from '@/lib/api-error'
import { toolsQuery } from '@/lib/list-queries'
import { useOrganizationStore } from '@/store/organization'
import { ApiType, ApiOperation, Tool } from '@/types'

export function ApiDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { currentOrganization } = useOrganizationStore()

  // Both open in place on this page: the schema viewer, and the Key
  // card's form (the overview's Authentication row opens it too).
  const [schemaOpen, setSchemaOpen] = React.useState(false)
  const [keyEditing, setKeyEditing] = React.useState(false)
  const keyCardRef = React.useRef<HTMLDivElement>(null)

  const { data: apiData, isLoading, isError, error: apiError, refetch: refetchApi } = useQuery({
    queryKey: ['api', id],
    queryFn: () => apisApi.getById(id!),
    enabled: !!id,
    // Asking again for an API that is not there gets the same answer.
    retry: (count, err) => !isNotFoundError(err) && count < 1,
    // An SDK API's packages are analysed in the background: follow it.
    refetchInterval: (query) =>
      (query.state.data as { metadata?: { sdkAnalysis?: { state?: string } } } | undefined)?.metadata?.sdkAnalysis?.state === 'analysing'
        ? 2000
        : false,
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
  const { data: allToolsPage } = useQuery({
    ...toolsQuery(currentOrganization?.id),
    enabled: !!currentOrganization,
  })

  const allTools = allToolsPage?.items ?? []
  const apiTools = allTools.filter((tool: Tool) => tool.metadata?.sourceApi?.id === id || (tool as unknown as Record<string, string>).apiId === id)

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  // An unknown id is not a failure "Try again" can fix: say it is not
  // there and offer the way back.
  if ((isError && isNotFoundError(apiError)) || (!isError && !apiData)) {
    return <NotFoundState thing="API" backTo="/apis" backLabel="Back to APIs" />
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

  const schemas = Array.isArray(schemasData) ? schemasData : (schemasData as any)?.data || []
  const api = { ...(apiData as any), schemas } as typeof apiData & { schemas: any[] }
  const operationsExtracted = apiOperations?.operations || apiOperations || []
  const operations: ApiOperation[] = Array.isArray(operationsExtracted) ? operationsExtracted : []
  const isSdk = api.type === ApiType.SDK

  return (
    <div className="space-y-6">
      <ResourceHeader
        back={{ to: '/apis', label: 'APIs' }}
        title={api.name}
        badges={
          <>
            <ApiTypeBadge type={api.type} />
            {api.version && <Badge variant="secondary">v{api.version}</Badge>}
          </>
        }
        subtitle={api.baseUrl ? <span className="font-mono text-sm">{api.baseUrl}</span> : undefined}
        actionsLabel="API actions"
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link to={`/apis/${api.id}/edit`}>
                <Pencil className="mr-2 h-4 w-4" />
                Edit
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link to={`/gateways/new?api=${api.id}`}>
                <Share2 className="mr-2 h-4 w-4" />
                Create gateway
              </Link>
            </Button>
          </>
        }
      />
      {/* An SDK API has packages, not a description: no import, no operations. */}
      {isSdk ? (
        <SdkPackagesCard api={api} apiTools={apiTools} />
      ) : (
        <OverviewTab
          api={api}
          operations={operations}
          apiTools={apiTools}
          onOpenSchemaViewer={() => setSchemaOpen(true)}
          onOpenAuthConfig={() => {
            setKeyEditing(true)
            keyCardRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
          }}
          onOpenSchemaImport={() => navigate(`/apis/${api.id}/import`)}
        />
      )}

      {!isSdk && <SchemaTab api={api} open={schemaOpen} onOpenChange={setSchemaOpen} />}

      <ApiKeyCard ref={keyCardRef} apiId={api.id} apiName={api.name} editing={keyEditing} onEditingChange={setKeyEditing} />

      {!isSdk && (
        <OperationsTab
          api={api}
          operations={operations}
          apiTools={apiTools}
          onOpenSchemaImport={() => navigate(`/apis/${api.id}/import`)}
        />
      )}
    </div>
  )
}
