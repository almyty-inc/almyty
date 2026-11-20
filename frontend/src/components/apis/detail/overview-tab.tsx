/**
 * OverviewTab — top-level summary section for an API.
 *
 * Renders the API content/configuration cards, primary action buttons
 * (import schema, generate tools, test connection, expose via gateway),
 * and the test-connection result panel. Used by the API detail page
 * (`pages/api-detail.tsx`).
 */
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Edit, ExternalLink, FileCode, KeyRound, ListTree, Plus, TestTube, Upload, Wrench, Zap } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { StatTile } from '@/components/ui/stat-tile'

import { apisApi } from '@/lib/api'
import { useNotifications } from '@/store/app'
import { Api, ApiOperation, Tool } from '@/types'
import { getApiErrorMessage } from '@/lib/api-error'
import { cn, pluralized } from '@/lib/utils'
import { connectionTestMessage } from '@/lib/connection-test'
import { addToolPath } from './operations-tab'
import { authTypeLabel, isManualHttp, MANUAL_OPERATIONS_HINT, MANUAL_OPERATIONS_LABEL } from '@/lib/api-operations'

/** The tool list filtered to one API's tools. */
export function apiToolsPath(api: Pick<Api, 'id' | 'name'>): string {
  return `/tools?${new URLSearchParams({ apiId: api.id, apiName: api.name }).toString()}`
}
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
  const { success, error, warning } = useNotifications()
  const [testResults, setTestResults] = useState<Record<string, unknown> | null>(null)
  const [testing, setTesting] = useState(false)

  const hasSchema = !!api.schemas && api.schemas.length > 0
  const downloadSchema = () => {
    if (!api.schemas || api.schemas.length === 0) return
    // Always download the original raw schema (the exact bytes the user
    // uploaded). The parsed form is no longer persisted; users who want it
    // can hit the on-demand parse endpoint via the schema viewer.
    const rawText = api.schemas[0].rawSchema || (api.schemas[0] as any).content || ''
    const blob = new Blob([rawText], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = api.schemas[0].fileName || `${api.name}-schema.txt`
    a.click()
    URL.revokeObjectURL(url)
  }
  const inlineAction = 'h-auto p-0 text-xs font-semibold text-primary hover:bg-transparent hover:text-primary-hover'

  return (
    <>
      {/* What the API holds, at a glance: the same stat row as an agent's. */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4" data-testid="api-stats">
        {/* A Custom HTTP API has no description, so no operations: say how
            its tools came to be instead of a bare 0, as the APIs list does. */}
        {isManualHttp(api) && operations.length === 0 ? (
          <StatTile
            icon={ListTree}
            label="Operations"
            value={<span className="text-base font-semibold">{MANUAL_OPERATIONS_LABEL}</span>}
            footer={<span title={MANUAL_OPERATIONS_HINT}>No description to read them from</span>}
          />
        ) : (
          <StatTile icon={ListTree} label="Operations" value={operations.length} />
        )}
        <StatTile
          icon={Wrench}
          label="Tools"
          value={
            // This API's tools only: /tools filters on apiId.
            <Link
              to={apiToolsPath(api)}
              aria-label={`Show the ${pluralized(apiTools.length, 'tool')} of ${api.name}`}
              className="text-primary hover:text-primary-hover hover:underline"
            >
              {apiTools.length}
            </Link>
          }
        />
        <StatTile
          icon={FileCode}
          label="Description"
          value={<span className="text-base font-semibold">{hasSchema ? 'Imported' : 'Not uploaded'}</span>}
          footer={
            hasSchema ? (
              <span className="flex gap-3">
                <Button variant="ghost" size="sm" className={inlineAction} onClick={onOpenSchemaViewer}>
                  View
                </Button>
                <Button variant="ghost" size="sm" className={inlineAction} onClick={downloadSchema}>
                  Download
                </Button>
              </span>
            ) : undefined
          }
        />
        <StatTile
          icon={KeyRound}
          label="Key"
          value={<span className="text-base font-semibold">{authTypeLabel(api.authentication?.type)}</span>}
          footer={
            <Button variant="ghost" size="sm" className={inlineAction} onClick={onOpenAuthConfig} aria-label="Change the key">
              <Edit className="mr-1 h-3 w-3" aria-hidden />
              Change
            </Button>
          }
        />
      </div>

      {/* Quick Actions */}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={onOpenSchemaImport}>
          <Upload className="mr-2 h-4 w-4" />
          {api.schemas && api.schemas.length > 0 ? 'Update the description' : 'Import a description'}
        </Button>
        {/* A tool made by hand, calling a path under this API's address. With
            no operations, the Operations card's empty state offers it instead. */}
        {operations.length > 0 && (
          <Button variant="outline" asChild>
            <Link to={addToolPath(api)}>
              <Plus className="mr-2 h-4 w-4" />
              Add a tool
            </Link>
          </Button>
        )}
        {operations.length > 0 && (
          <Button
            onClick={async () => {
              try {
                const result = await apisApi.generateTools(api.id)
                queryClient.invalidateQueries({ queryKey: ['api', api.id] })
                queryClient.invalidateQueries({ queryKey: ['apis'] })
                queryClient.invalidateQueries({ queryKey: ['tools'] })
                // The endpoint now reports what it could not generate as
                // well as what it could. This used to count the returned
                // array and call it success, so an import where 60 of 600
                // operations failed showed a green "540 tools created
                // successfully" and the failures lived only in the server
                // log.
                const generated = result?.generated ?? (Array.isArray(result) ? result.length : 0)
                const failed = result?.failed ?? 0
                if (failed > 0) {
                  warning(
                    'Some tools could not be generated',
                    `${generated} created, ${failed} failed out of ${pluralized(result?.total ?? generated + failed, 'operation')}.`,
                  )
                } else {
                  success('Tools generated', `${pluralized(generated, 'tool')} created`)
                }
              } catch (err: any) {
                error('Failed to generate tools', getApiErrorMessage(err, 'Please try again.'))
              }
            }}
          >
            <Zap className="mr-2 h-4 w-4" />
            {apiTools.length > 0 ? 'Regenerate tools' : `Generate ${pluralized(operations.length, 'tool')}`}
          </Button>
        )}
        <Button
          variant="outline"
          onClick={async () => {
            setTesting(true)
            setTestResults(null)
            try {
              // The endpoint answers 200 with `success: false` for a
              // failed test, so the axios call never rejects and this
              // used to raise a green "successful" over a red Failed
              // card sitting directly underneath it.
              const testResult = await apisApi.testConnection(api.id)
              setTestResults(testResult)
              if (testResult?.success === false) {
                error('Test failed', connectionTestMessage(testResult))
              } else {
                success('API is reachable', connectionTestMessage(testResult))
              }
            } catch (err: any) {
              setTestResults({ success: false, error: getApiErrorMessage(err, 'Connection failed') })
              error('Test failed', getApiErrorMessage(err, 'Please try again.'))
            } finally {
              setTesting(false)
            }
          }}
          disabled={testing}
        >
          <TestTube className="mr-2 h-4 w-4" />
          {testing ? 'Testing...' : 'Test connection'}
        </Button>
        <Button
          variant="outline"
          onClick={() => navigate(`/gateways?apiId=${api.id}&apiName=${encodeURIComponent(api.name)}`)}
        >
          <ExternalLink className="mr-2 h-4 w-4" />
          Expose via gateway
        </Button>
      </div>

      {/* Test Results: the sentence the server wrote, never the raw answer. */}
      {testResults && (
        <div
          data-testid="connection-test-result"
          className={cn(
            'rounded-xl border p-4',
            testResults.success ? 'border-success-border bg-success-subtle' : 'border-danger-border bg-danger-subtle',
          )}
        >
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">Test results</h3>
            <Badge variant={testResults.success ? 'success' : 'destructive'}>
              {testResults.success ? 'Reachable' : 'Failed'}
            </Badge>
          </div>
          <p className="mt-2 text-sm" data-testid="connection-test-message">{connectionTestMessage(testResults)}</p>
        </div>
      )}
    </>
  )
}
