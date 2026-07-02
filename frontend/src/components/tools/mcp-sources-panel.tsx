import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plug, RefreshCw, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { mcpSourcesApi } from '@/lib/api'
import { useNotifications } from '@/store/app'

export interface McpSourceView {
  id: string
  name: string
  url: string
  status: 'active' | 'error' | 'syncing'
  toolCount: number
  lastSyncAt?: string | null
  lastError?: string | null
  serverInfo?: { name?: string; version?: string } | null
}

interface McpSourcesPanelProps {
  organizationId?: string
}

/**
 * Connected external MCP servers: status, tool count, re-sync and
 * delete. Rendered on the Tools page above the tools table. Hidden
 * entirely while no source is registered.
 */
export function McpSourcesPanel({ organizationId }: McpSourcesPanelProps) {
  const queryClient = useQueryClient()
  const notifications = useNotifications()
  const [deletingSource, setDeletingSource] = useState<McpSourceView | null>(null)

  const { data: sourcesData } = useQuery({
    queryKey: ['mcp-sources', organizationId],
    queryFn: () => mcpSourcesApi.getAll(organizationId!),
    enabled: !!organizationId,
  })
  const sources: McpSourceView[] = Array.isArray(sourcesData) ? sourcesData : []

  const syncMutation = useMutation({
    mutationFn: (id: string) => mcpSourcesApi.sync(organizationId!, id),
    onSuccess: (summary: any) => {
      queryClient.invalidateQueries({ queryKey: ['mcp-sources'] })
      queryClient.invalidateQueries({ queryKey: ['tools'] })
      notifications.success(
        'Synced',
        `${summary?.added ?? 0} added, ${summary?.updated ?? 0} updated, ${summary?.removed ?? 0} removed`,
      )
    },
    onError: (error: any) => {
      queryClient.invalidateQueries({ queryKey: ['mcp-sources'] })
      notifications.error('Sync failed', error.response?.data?.message ?? error.message ?? 'Sync failed')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => mcpSourcesApi.delete(organizationId!, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mcp-sources'] })
      queryClient.invalidateQueries({ queryKey: ['tools'] })
      notifications.success('Deleted', 'MCP server and its tools removed')
      setDeletingSource(null)
    },
    onError: (error: any) => {
      notifications.error('Error', error.response?.data?.message ?? error.message ?? 'Delete failed')
    },
  })

  if (sources.length === 0) return null

  return (
    <Card className="mb-4">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Plug className="h-5 w-5 text-violet-500" />
          MCP Servers
        </CardTitle>
        <CardDescription>
          External MCP servers connected as tool sources
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {sources.map((source) => (
          <div
            key={source.id}
            className="flex items-center justify-between gap-4 rounded-lg border p-3"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium truncate">{source.name}</span>
                <Badge
                  variant="outline"
                  className="text-violet-600 border-violet-300 dark:border-violet-800 dark:text-violet-400 shrink-0"
                >
                  MCP
                </Badge>
                <Badge variant={source.status === 'active' ? 'success' : source.status === 'error' ? 'destructive' : 'secondary'}>
                  {source.status}
                </Badge>
              </div>
              <div className="text-sm text-muted-foreground truncate">
                {source.url}
                {' · '}
                {source.toolCount} tool{source.toolCount !== 1 ? 's' : ''}
                {source.lastSyncAt ? ` · synced ${new Date(source.lastSyncAt).toLocaleString()}` : ''}
              </div>
              {source.status === 'error' && source.lastError && (
                <div className="text-sm text-destructive truncate" title={source.lastError}>
                  {source.lastError}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button
                size="sm"
                variant="outline"
                onClick={() => syncMutation.mutate(source.id)}
                disabled={syncMutation.isPending}
                aria-label={`Sync ${source.name}`}
              >
                <RefreshCw className={`h-4 w-4 mr-1 ${syncMutation.isPending ? 'animate-spin' : ''}`} />
                Sync
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setDeletingSource(source)}
                aria-label={`Delete ${source.name}`}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ))}
      </CardContent>

      <AlertDialog open={!!deletingSource} onOpenChange={(open) => !open && setDeletingSource(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete MCP server?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes "{deletingSource?.name}" and all {deletingSource?.toolCount ?? 0} tools
              discovered from it. Agents using those tools will lose access. This action cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deletingSource && deleteMutation.mutate(deletingSource.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
