/**
 * OverviewTab — top-level summary section for an API.
 *
 * Renders the API content/configuration cards, primary action buttons
 * (import schema, generate tools, test connection, expose via gateway),
 * and the test-connection result panel. Used by the API detail page
 * (`pages/api-detail.tsx`).
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Edit, ExternalLink, TestTube, Upload, Zap } from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

import { apisApi } from '@/lib/api'
import { useNotifications } from '@/store/app'
import { Api, ApiOperation, Tool } from '@/types'

interface OverviewTabProps {
  api: Api
  operations: ApiOperation[]
  apiTools: Tool[]
  onOpenSchemaViewer: () => void
  onOpenAuthConfig: () => void
  onOpenSchemaImport: () => void
}

export function OverviewTab({
  api,
  operations,
  apiTools,
  onOpenSchemaViewer,
  onOpenAuthConfig,
  onOpenSchemaImport,
}: OverviewTabProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { success, error } = useNotifications()
  const [testResults, setTestResults] = useState<Record<string, unknown> | null>(null)
  const [testing, setTesting] = useState(false)

  return (
    <>
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
                  <Button variant="ghost" size="sm" className="h-auto p-1 text-xs" onClick={onOpenSchemaViewer}>
                    View
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto p-1 text-xs"
                    onClick={() => {
                      if (!api.schemas || api.schemas.length === 0) return
                      // Always download the original raw schema (the
                      // exact bytes the user uploaded). The parsed
                      // form is no longer persisted; users who want
                      // it can hit the on-demand parse endpoint via
                      // the schema viewer.
                      const rawText = api.schemas[0].rawSchema || (api.schemas[0] as any).content || ''
                      const blob = new Blob([rawText], { type: 'application/octet-stream' })
                      const url = URL.createObjectURL(blob)
                      const a = document.createElement('a')
                      a.href = url
                      a.download = api.schemas[0].fileName || `${api.name}-schema.txt`
                      a.click()
                      URL.revokeObjectURL(url)
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
                onClick={onOpenAuthConfig}
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
        <Button variant="outline" onClick={onOpenSchemaImport}>
          <Upload className="mr-2 h-4 w-4" />
          {api.schemas && api.schemas.length > 0 ? 'Update Schema' : 'Import Schema'}
        </Button>
        {operations.length > 0 && (
          <Button
            onClick={async () => {
              try {
                const result = await apisApi.generateTools(api.id)
                queryClient.invalidateQueries({ queryKey: ['api', api.id] })
                queryClient.invalidateQueries({ queryKey: ['apis'] })
                queryClient.invalidateQueries({ queryKey: ['tools'] })
                const toolCount = Array.isArray(result) ? result.length : 0
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
              const testResult = await apisApi.testConnection(api.id)
              setTestResults(testResult)
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
          onClick={() => navigate(`/gateways?apiId=${api.id}&apiName=${encodeURIComponent(api.name)}`)}
        >
          <ExternalLink className="mr-2 h-4 w-4" />
          Expose via Gateway
        </Button>
      </div>

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
              <pre className="p-4 text-sm font-mono bg-muted rounded-md overflow-auto max-h-96">
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
    </>
  )
}
