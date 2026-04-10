/**
 * OperationsTab — searchable list of API operations parsed from a schema.
 *
 * Owns the operation search/method filter state, the selected-operation
 * detail dialog, and copy-to-clipboard for full endpoints. Used by the API
 * detail page (`pages/api-detail.tsx`).
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Code, Copy, Search, Upload } from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

import { useNotifications } from '@/store/app'
import { Api, ApiOperation, Tool } from '@/types'

interface OperationsTabProps {
  api: Api
  operations: ApiOperation[]
  apiTools: Tool[]
  onOpenSchemaImport: () => void
}

export function OperationsTab({ api, operations, apiTools, onOpenSchemaImport }: OperationsTabProps) {
  const navigate = useNavigate()
  const { success } = useNotifications()
  const [selectedOperation, setSelectedOperation] = useState<ApiOperation | null>(null)
  const [operationSearch, setOperationSearch] = useState('')
  const [methodFilter, setMethodFilter] = useState<string>('ALL')

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
              <CardTitle>API Operations</CardTitle>
              <p className="text-sm text-muted-foreground mt-1">
                {operations.length} operations parsed from schema
              </p>
            </div>
            {api.schema && (
              <Button variant="outline" size="sm" onClick={onOpenSchemaImport}>
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
              <Button onClick={onOpenSchemaImport}>
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
              {filteredOperations.map((operation: ApiOperation) => (
                <div
                  key={operation.id}
                  className="flex items-center justify-between p-4 border rounded hover:bg-muted cursor-pointer group"
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
    </>
  )
}
