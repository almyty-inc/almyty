/**
 * SdkPackagesCard — what an SDK / npm API offers, on the API detail page.
 *
 * An SDK API has no description to import: its packages are installed and
 * their type declarations read (a background job, `api.metadata.sdkAnalysis`),
 * and tools are built from that on the Create tool form. This card shows
 * where that stands, why it failed if it did, and the way on.
 */
import { Link } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Package, Plus, RefreshCw } from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { LoadingSpinner } from '@/components/ui/loading-spinner'

import { apisApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { pluralized } from '@/lib/utils'
import { useNotifications } from '@/store/app'
import { Api, Tool } from '@/types'

export interface SdkAnalysisState {
  state: 'analysing' | 'ready' | 'failed'
  startedAt?: string
  finishedAt?: string
  packages?: Array<{ name: string; version: string; exports: number; callables: number }>
}

/** The analysis state an SDK API carries, or null when it was never analysed. */
export function sdkAnalysisOf(api: Pick<Api, 'metadata'>): SdkAnalysisState | null {
  const state = (api.metadata as Record<string, unknown> | undefined)?.sdkAnalysis
  return state && typeof state === 'object' ? (state as SdkAnalysisState) : null
}

interface SdkPackagesCardProps {
  api: Api
  apiTools: Tool[]
}

export function SdkPackagesCard({ api, apiTools }: SdkPackagesCardProps) {
  const queryClient = useQueryClient()
  const { error } = useNotifications()
  const analysis = sdkAnalysisOf(api)
  const lastError = (api as Api & { lastImportError?: string | null }).lastImportError
  const declared = Object.entries((api as Api & { dependencies?: Record<string, string> }).dependencies ?? {})

  const analyse = useMutation({
    mutationFn: () => apisApi.analyseSdk(api.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['api', api.id] })
      queryClient.invalidateQueries({ queryKey: ['sdk-maps', api.id] })
    },
    onError: (err: unknown) => error('Could not start the analysis', getApiErrorMessage(err, 'Please try again.')),
  })

  const analysing = analysis?.state === 'analysing' || analyse.isPending
  const ready = analysis?.state === 'ready'
  const callables = (analysis?.packages ?? []).reduce((n, p) => n + p.callables, 0)
  // Analysed: what was found. Otherwise: what the API declares.
  const rows: Array<{ name: string; version: string; exports?: number; callables?: number }> =
    ready && analysis?.packages?.length ? analysis.packages : declared.map(([name, version]) => ({ name, version }))

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Packages</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {analysing && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <LoadingSpinner size="sm" />
            Installing the packages and reading what they offer. This can take a minute.
          </div>
        )}

        {!analysing && !analysis && (
          <p className="text-sm text-muted-foreground">
            These packages have not been analysed yet. Analyse them to build tools from their methods.
          </p>
        )}

        {!analysing && lastError && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm" role="alert">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <span>{analysis?.state === 'failed' ? `The analysis failed: ${lastError}` : lastError}</span>
          </div>
        )}

        <ul className="divide-y rounded-md border">
          {rows.map((pkg) => (
            <li key={pkg.name} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <span className="flex items-center gap-2 font-mono">
                <Package className="h-4 w-4 text-muted-foreground" />
                {pkg.name}
                <Badge variant="secondary">{pkg.version}</Badge>
              </span>
              {pkg.callables !== undefined && (
                <span className="text-muted-foreground">
                  {pluralized(pkg.exports, 'export')}, {pluralized(pkg.callables, 'method')}
                </span>
              )}
            </li>
          ))}
        </ul>

        {ready && (
          <p className="text-sm text-muted-foreground">
            {pluralized(callables, 'method')} to build tools from. {pluralized(apiTools.length, 'tool')} use this API.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {ready && callables > 0 && (
            <Button asChild>
              <Link to={`/tools/new?type=sdk&api=${api.id}`}>
                <Plus className="mr-2 h-4 w-4" />
                Create a tool
              </Link>
            </Button>
          )}
          <Button variant="outline" onClick={() => analyse.mutate()} disabled={analysing}>
            <RefreshCw className="mr-2 h-4 w-4" />
            {analysis ? 'Analyse again' : 'Analyse the packages'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
