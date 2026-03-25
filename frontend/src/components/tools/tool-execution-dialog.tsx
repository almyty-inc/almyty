import React from 'react'
import { Play } from 'lucide-react'
import { UseMutationResult } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface ToolExecutionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  toolForExecution: any | null
  executionParameters: Record<string, any>
  onExecutionParametersChange: (value: Record<string, any>) => void
  executionResult: any | null
  executeToolMutation: UseMutationResult<any, any, any, any>
}

export function ToolExecutionDialog({
  open,
  onOpenChange,
  toolForExecution,
  executionParameters,
  onExecutionParametersChange,
  executionResult,
  executeToolMutation,
}: ToolExecutionDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <Play className="h-5 w-5" />
            Test Tool: {toolForExecution?.name}
          </DialogTitle>
          <DialogDescription>
            Execute the tool with parameters and view results
          </DialogDescription>
        </DialogHeader>

        {toolForExecution && (
          <div className="space-y-6">
            {/* Parameters Section */}
            <div id="tool-parameters-section" className="space-y-4">
              <h4 className="text-sm font-medium">Parameters</h4>

              {(toolForExecution as any).type === 'api' ? (
                /* API tools: show path/query/body split */
                <div className="space-y-3">
                  <div>
                    <label className="text-sm font-medium">Path Parameters</label>
                    <Input
                      placeholder='{"petId": "1"}'
                      value={JSON.stringify(executionParameters.path || {})}
                      onChange={(e) => {
                        try {
                          const parsed = JSON.parse(e.target.value || '{}')
                          onExecutionParametersChange({ ...executionParameters, path: parsed })
                        } catch {}
                      }}
                      className="mt-1 font-mono text-xs"
                    />
                  </div>

                  <div>
                    <label className="text-sm font-medium">Query Parameters</label>
                    <Input
                      placeholder='{"status": "available"}'
                      value={JSON.stringify(executionParameters.query || {})}
                      onChange={(e) => {
                        try {
                          const parsed = JSON.parse(e.target.value || '{}')
                          onExecutionParametersChange({ ...executionParameters, query: parsed })
                        } catch {}
                      }}
                      className="mt-1 font-mono text-xs"
                    />
                  </div>

                  <div>
                    <label className="text-sm font-medium">Body</label>
                    <textarea
                      placeholder='{"name": "Rex", "status": "available"}'
                      value={JSON.stringify(executionParameters.body || {}, null, 2)}
                      onChange={(e) => {
                        try {
                          const parsed = JSON.parse(e.target.value || '{}')
                          onExecutionParametersChange({ ...executionParameters, body: parsed })
                        } catch {}
                      }}
                      className="w-full min-h-[100px] p-2 border rounded font-mono text-xs"
                    />
                  </div>
                </div>
              ) : (
                /* Custom/LLM/other tools: single parameters input */
                <div>
                  <label className="text-sm font-medium">Parameters (JSON)</label>
                  <textarea
                    placeholder={(() => {
                      const props = (toolForExecution as any).parameters?.properties
                      if (props && Object.keys(props).length > 0) {
                        const example: Record<string, string> = {}
                        for (const [k, v] of Object.entries(props)) {
                          example[k] = (v as any).type === 'number' ? '0' : (v as any).type === 'boolean' ? 'true' : `example_${k}`
                        }
                        return JSON.stringify(example, null, 2)
                      }
                      return '{"key": "value"}'
                    })()}
                    value={JSON.stringify(executionParameters.body || {}, null, 2)}
                    onChange={(e) => {
                      try {
                        const parsed = JSON.parse(e.target.value || '{}')
                        onExecutionParametersChange({ ...executionParameters, body: parsed })
                      } catch {}
                    }}
                    className="w-full min-h-[120px] p-2 border rounded font-mono text-xs"
                  />
                  {(toolForExecution as any).parameters?.properties && (
                    <p className="text-xs text-muted-foreground mt-1">
                      Expected: {Object.entries((toolForExecution as any).parameters.properties).map(([k, v]: [string, any]) => `${k} (${v.type})`).join(', ')}
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Execute Button */}
            <div className="flex justify-between items-center pt-4 border-t">
              <Button
                onClick={() => {
                  if (toolForExecution) {
                    // For API tools, merge path/query/body; for others, use body directly
                    const flatParams = (toolForExecution as any).type === 'api'
                      ? {
                          ...(executionParameters.path || {}),
                          ...(executionParameters.query || {}),
                          ...(executionParameters.body || {}),
                        }
                      : (executionParameters.body || {})
                    executeToolMutation.mutate({
                      id: toolForExecution.id,
                      parameters: flatParams,
                    })
                  }
                }}
                disabled={executeToolMutation.isPending}
              >
                {executeToolMutation.isPending ? (
                  <>
                    <LoadingSpinner size="sm" className="mr-2" />
                    Executing...
                  </>
                ) : (
                  <>
                    <Play className="h-4 w-4 mr-2" />
                    Execute
                  </>
                )}
              </Button>

              {executionResult && (
                <div className="text-xs text-muted-foreground">
                  {executionResult.metadata?.executionTime && (
                    <span className="mr-3">
                      {executionResult.metadata.executionTime}ms
                    </span>
                  )}
                  {executionResult.cached && (
                    <Badge variant="secondary" className="text-xs">Cached</Badge>
                  )}
                </div>
              )}
            </div>

            {/* Results Section */}
            {executionResult && (
              <div className="space-y-3 border-t pt-4">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-medium">Result</h4>
                  <Badge variant={executionResult.success ? 'success' : 'destructive'}>
                    {executionResult.success ? 'Success' : 'Error'}
                  </Badge>
                </div>

                {executionResult.success ? (
                  <div className="space-y-2">
                    <div className="bg-green-50 border border-green-200 rounded p-3">
                      <pre className="text-xs overflow-x-auto">
                        {JSON.stringify(executionResult.data, null, 2)}
                      </pre>
                    </div>
                    {executionResult.metadata?.executionTime && (
                      <p className="text-xs text-muted-foreground">
                        Execution time: {executionResult.metadata.executionTime}ms
                        {executionResult.metadata.httpStatus && ` | HTTP ${executionResult.metadata.httpStatus}`}
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="bg-red-50 border border-red-200 rounded p-3">
                    <p className="text-sm text-red-900 font-medium">Error:</p>
                    <p className="text-xs text-red-700 mt-1">{executionResult.error}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
