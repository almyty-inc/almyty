/**
 * OperationsTab — searchable list of API operations parsed from a schema.
 *
 * Owns the operation search/method filter state and the expanded
 * operation: clicking a row opens its details (full endpoint with copy,
 * parameters, related tools, or "Make a tool" when it has none) in place
 * under the row. "Choose operations" opens the import's operation picker
 * in place, to add or take out operations. Used by the API detail page
 * (`pages/api-detail.tsx`).
 */
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Code, ListChecks, Plus, Search, Upload } from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { CopyField } from '@/components/ui/copy-field'
import { Input } from '@/components/ui/input'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'
import { OperationPicker } from '@/components/apis/operation-picker'

import { Api, ApiOperation, ApiType, Tool } from '@/types'
import { apisApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { pluralized } from '@/lib/utils'

/** An API connected as a bare address (Manual HTTP), with no description to import. */
export function isManualHttp(api: Api): boolean {
  return api.type === ApiType.HTTP && !(api.schemas && api.schemas.length > 0)
}

/** The create-tool page, opened as an HTTP tool already linked to this API. */
export function addToolPath(api: Api): string {
  return `/tools/new?type=http&api=${encodeURIComponent(api.id)}`
}

interface OperationsTabProps {
  api: Api
  operations: ApiOperation[]
  apiTools: Tool[]
  onOpenSchemaImport: () => void
}

/** No operation is new on the API page: the picker opens on the current pick. */
const NO_NEW_OPERATIONS: string[] = []

/**
 * The operation picker of the import, opened in place on the API page to
 * add or take out operations. Tools already made keep their ids; a tool of
 * an operation taken out is not deleted, so the page says so.
 */
function ChooseOperations({ apiId, total, onDone }: { apiId: string; total: number; onDone: () => void }) {
  const queryClient = useQueryClient()
  // The picker reads the same query; the limit is needed before it renders.
  const outline = useQuery({
    queryKey: ['api-operation-outline', apiId],
    queryFn: () => apisApi.getOperationOutline(apiId),
  })
  const generate = useMutation({
    mutationFn: (jobId: string) => apisApi.pollImportStatus(apiId, jobId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['tools'] }),
        queryClient.invalidateQueries({ queryKey: ['api-operations', apiId] }),
        queryClient.invalidateQueries({ queryKey: ['api-operation-outline', apiId] }),
      ])
      onDone()
    },
  })
  return (
    <div className="mb-6 space-y-3 rounded-md border p-4" data-testid="choose-operations">
      {outline.data ? (
        generate.isPending ? (
          <p role="status" className="text-sm">Making the tools...</p>
        ) : (
          <OperationPicker apiId={apiId} total={total} limit={outline.data.limit} newOperationIds={NO_NEW_OPERATIONS} onStarted={(jobId) => generate.mutate(jobId)} />
        )
      ) : outline.isError ? (
        <QueryError error={outline.error} onRetry={() => outline.refetch()} title="Couldn't load the operations" />
      ) : (
        <LoadingSpinner />
      )}
      <p className="text-sm text-muted-foreground">
        Tools already made stay as they are. Taking an operation out does not delete its tool; delete that on the tool's page.
      </p>
      {generate.isError && (
        <p role="alert" className="text-sm text-destructive">
          {getApiErrorMessage(generate.error, 'The tools were not made.')}
        </p>
      )}
      <Button variant="ghost" size="sm" onClick={onDone}>
        Close
      </Button>
    </div>
  )
}

export function OperationsTab({ api, operations, apiTools, onOpenSchemaImport }: OperationsTabProps) {
  const navigate = useNavigate()
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [operationSearch, setOperationSearch] = useState('')
  const [methodFilter, setMethodFilter] = useState<string>('ALL')
  const [picking, setPicking] = useState(false)

  const filteredOperations = operations.filter((operation: ApiOperation) => {
    const matchesSearch = !operationSearch ||
      (operation.endpoint || operation.path || '').toLowerCase().includes(operationSearch.toLowerCase()) ||
      (operation.name || '').toLowerCase().includes(operationSearch.toLowerCase()) ||
      (operation.description || '').toLowerCase().includes(operationSearch.toLowerCase())
    const matchesMethod = methodFilter === 'ALL' || operation.method === methodFilter
    return matchesSearch && matchesMethod
  })

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>API operations</CardTitle>
              <p className="text-sm text-muted-foreground mt-1">
                {pluralized(operations.length, 'operation')} parsed from schema
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {operations.length > 0 && (
                <Button variant="outline" size="sm" aria-expanded={picking} onClick={() => setPicking((open) => !open)}>
                  <ListChecks className="mr-2 h-4 w-4" />
                  Choose operations
                </Button>
              )}
              {api.schema && (
                <Button variant="outline" size="sm" onClick={onOpenSchemaImport}>
                  <Upload className="mr-2 h-4 w-4" />
                  Update the description
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {picking && <ChooseOperations apiId={api.id} total={operations.length} onDone={() => setPicking(false)} />}
          {operations.length === 0 ? (
            <div className="text-center py-12">
              <Code className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              {/* A manual HTTP API has no description to import: its tools are
                  made by hand, so that is offered first. */}
              <p className="text-muted-foreground mb-4">
                {isManualHttp(api)
                  ? 'No operations: this API has no description. Add its tools by hand, each calling a path under its address.'
                  : "No operations yet. Import the API's description to get them, or add a tool by hand."}
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                <Button asChild variant={isManualHttp(api) ? 'default' : 'outline'}>
                  <Link to={addToolPath(api)}>
                    <Plus className="mr-2 h-4 w-4" />
                    Add a tool
                  </Link>
                </Button>
                <Button variant={isManualHttp(api) ? 'outline' : 'default'} onClick={onOpenSchemaImport}>
                  <Upload className="mr-2 h-4 w-4" />
                  Import a description
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Search and method filter */}
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search operations by path or description..."
                    className="pl-10"
                    value={operationSearch}
                    onChange={(e) => setOperationSearch(e.target.value)}
                  />
                </div>
                <div className="flex flex-wrap gap-1">
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
              {filteredOperations.map((operation: ApiOperation) => {
                const expanded = expandedId === operation.id
                return (
                <div key={operation.id} className="rounded border">
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 p-4 text-left hover:bg-muted"
                  aria-expanded={expanded}
                  aria-controls={`operation-${operation.id}`}
                  onClick={() => setExpandedId(expanded ? null : operation.id)}
                >
                  <div className="flex min-w-0 flex-1 items-center space-x-3">
                    {expanded ? (
                      <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    ) : (
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    )}
                    {operation.method && (
                      <Badge
                        variant={
                          operation.method === 'GET' ? 'default' :
                          operation.method === 'POST' ? 'secondary' :
                          operation.method === 'PUT' ? 'outline' :
                          operation.method === 'DELETE' ? 'destructive' :
                          'outline'
                        }
                        className="font-mono w-20 justify-center shrink-0"
                      >
                        {operation.method}
                      </Badge>
                    )}
                    <div className="min-w-0 flex-1">
                      {(operation.endpoint || operation.path) && (
                        <code className="text-sm font-mono font-medium block mb-1 break-all">
                          {operation.endpoint || operation.path}
                        </code>
                      )}
                      <div className="text-sm text-muted-foreground">{operation.name}</div>
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    {operation.parameters && operation.parameters.length > 0 && (
                      <Badge variant="outline" className="text-xs">
                        {pluralized(operation.parameters.length, 'param')}
                      </Badge>
                    )}
                  </div>
                </button>
                {expanded && (
                  <OperationDetails
                    id={`operation-${operation.id}`}
                    api={api}
                    operation={operation}
                    apiTools={apiTools}
                    onViewTool={(toolId) => navigate(`/tools/${toolId}`)}
                  />
                )}
                </div>
                )
              })}
              {filteredOperations.length === 0 && (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  No operations match your search.
                </div>
              )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

    </>
  )
}

function OperationDetails({
  id,
  api,
  operation,
  apiTools,
  onViewTool,
}: {
  id: string
  api: Api
  operation: ApiOperation
  apiTools: Tool[]
  onViewTool: (toolId: string) => void
}) {
  const params = operation.parameters
  // Parameters is an array, or an object whose values may all be empty.
  const hasParams = Array.isArray(params)
    ? params.length > 0
    : !!params && typeof params === 'object' && Object.values(params).some((v: unknown) =>
        v && typeof v === 'object' ? (Array.isArray(v) ? v.length > 0 : Object.keys(v as Record<string, unknown>).length > 0) : !!v
      )
  const relatedTools = apiTools.filter((tool: Tool) =>
    (tool as unknown as Record<string, string>).operationId === operation.id ||
    tool.metadata?.sourceOperation?.name === operation.name
  )

  return (
    <div id={id} className="space-y-4 border-t bg-muted/30 p-4" data-testid="operation-details">
      <div>
        <h4 className="text-sm font-medium">Description</h4>
        <p className="text-sm text-muted-foreground">{operation.description || operation.name || 'No description'}</p>
      </div>

      <div className="space-y-1">
        <h4 className="text-sm font-medium">Full endpoint</h4>
        <CopyField value={`${api.baseUrl}${operation.endpoint || operation.path || ''}`} label="Full endpoint" />
      </div>

      {params && (
        <div>
          <h4 className="text-sm font-medium">Parameters</h4>
          {hasParams ? (
            <div className="bg-muted p-3 rounded text-xs max-h-48 overflow-y-auto">
              <pre>{JSON.stringify(params, null, 2)}</pre>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground mt-1">No parameters required</p>
          )}
        </div>
      )}

      <div>
        <h4 className="text-sm font-medium">Related tools</h4>
        <div className="space-y-1">
          {relatedTools.length > 0 ? (
            relatedTools.map((tool: Tool) => (
              <div key={tool.id} className="flex items-center justify-between rounded border bg-background dark:bg-muted/40 p-2">
                <span className="text-sm">{tool.name}</span>
                <Button size="sm" variant="ghost" onClick={() => onViewTool(tool.id)}>
                  View tool
                </Button>
              </div>
            ))
          ) : (
            <MakeTool apiId={api.id} operationId={operation.id} />
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * "Make a tool" for an operation without one: an operation of a large API
 * that was not picked at import, or one whose tool was deleted. Makes that
 * one tool; the API's other tools are left as they are.
 */
function MakeTool({ apiId, operationId }: { apiId: string; operationId: string }) {
  const queryClient = useQueryClient()
  const make = useMutation({
    mutationFn: () => apisApi.makeOperationTool(apiId, operationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tools'] })
      queryClient.invalidateQueries({ queryKey: ['api-operations', apiId] })
      queryClient.invalidateQueries({ queryKey: ['api-operation-outline', apiId] })
    },
  })
  if (make.isSuccess) {
    return (
      <p role="status" className="text-sm">
        Made the tool{' '}
        <Link to={`/tools/${make.data.toolId}`} className="font-medium underline underline-offset-2">
          {make.data.toolName}
        </Link>
        .
      </p>
    )
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-muted-foreground">No tool made from this operation yet.</p>
        <Button size="sm" variant="outline" onClick={() => make.mutate()} disabled={make.isPending}>
          <Plus className="mr-2 h-4 w-4" />
          {make.isPending ? 'Making the tool...' : 'Make a tool'}
        </Button>
      </div>
      {make.isError && (
        <p role="alert" className="text-sm text-destructive">
          {getApiErrorMessage(make.error, 'The tool was not made.')}
        </p>
      )}
    </div>
  )
}