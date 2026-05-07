import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Layers, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'
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
import { workspacesApi } from '@/lib/api'
import { formatRelativeTime } from '@/lib/utils'
import { useNotifications } from '@/store/app'
import { workspaceStatusVariant, RUNNER_HEARTBEAT_POLL_MS } from './runners-shared'

interface Workspace {
  id: string
  runnerId: string
  ownerUserId: string
  cwd: string
  isolation: 'container' | 'host'
  status: 'active' | 'released' | 'expired' | 'stranded'
  ttlAt: string | null
  closeReason: { kind: string; detail: string } | null
  createdAt: string
  updatedAt: string
  closedAt: string | null
}

export function WorkspaceDetailPage() {
  const { id = '' } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { success, error: errNotif } = useNotifications()
  const [confirmRelease, setConfirmRelease] = useState(false)

  const wsQuery = useQuery<Workspace>({
    queryKey: ['workspace', id],
    queryFn: () => workspacesApi.getById(id),
    enabled: !!id,
    refetchInterval: RUNNER_HEARTBEAT_POLL_MS,
  })

  const releaseMutation = useMutation({
    mutationFn: () => workspacesApi.release(id),
    onSuccess: () => {
      success('Workspace released')
      queryClient.invalidateQueries({ queryKey: ['workspace', id] })
      queryClient.invalidateQueries({ queryKey: ['workspaces'] })
    },
    onError: (err: any) => errNotif('Release failed', err?.response?.data?.message ?? err.message),
  })

  if (wsQuery.isLoading) {
    return (
      <div className="space-y-6">
        <BackHeader />
        <div className="py-12 flex justify-center"><LoadingSpinner size="lg" /></div>
      </div>
    )
  }
  if (wsQuery.isError || !wsQuery.data) {
    return (
      <div className="space-y-6">
        <BackHeader />
        <QueryError
          error={wsQuery.error as Error}
          onRetry={wsQuery.refetch}
          title="Couldn't load workspace"
        />
      </div>
    )
  }

  const ws = wsQuery.data

  return (
    <div className="space-y-6">
      <BackHeader />

      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <Layers className="h-7 w-7 text-muted-foreground" />
          <div>
            <h1 className="text-xl font-bold font-mono">{ws.id}</h1>
            <div className="flex items-center gap-2 mt-1">
              <Badge variant={workspaceStatusVariant[ws.status]}>{ws.status}</Badge>
              <span className="text-sm text-muted-foreground">
                pinned to{' '}
                <Link to={`/runners/${ws.runnerId}`} className="hover:underline">
                  runner {ws.runnerId.slice(0, 8)}…
                </Link>
              </span>
            </div>
          </div>
        </div>
        {ws.status === 'active' && (
          <Button variant="destructive" onClick={() => setConfirmRelease(true)}>
            <Trash2 className="mr-2 h-4 w-4" />
            Release workspace
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Metadata</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <Row label="cwd" value={<code className="font-mono text-xs">{ws.cwd}</code>} />
          <Row label="Isolation" value={<Badge variant="outline" className="font-normal">{ws.isolation}</Badge>} />
          <Row
            label="TTL"
            value={ws.ttlAt
              ? <span title={ws.ttlAt}>{ws.status === 'active' ? `expires ${formatRelativeTime(ws.ttlAt)}` : ws.ttlAt}</span>
              : <span className="text-muted-foreground">none</span>}
          />
          <Row label="Created" value={<span title={ws.createdAt}>{formatRelativeTime(ws.createdAt)}</span>} />
          {ws.closedAt && <Row label="Closed" value={<span title={ws.closedAt}>{formatRelativeTime(ws.closedAt)}</span>} />}
        </CardContent>
      </Card>

      {ws.closeReason && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Close reason</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row
              label="Kind"
              value={<Badge variant={workspaceStatusVariant[ws.status] ?? 'outline'}>{ws.closeReason.kind}</Badge>}
            />
            <Row label="Detail" value={<code className="font-mono text-xs">{ws.closeReason.detail || '—'}</code>} />
            {ws.status === 'stranded' && (
              <p className="text-xs text-muted-foreground pt-2">
                Stranded means the runner pinned to this workspace went offline before release.
                There is no migration to a different runner; create a fresh workspace on a live runner.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <AlertDialog open={confirmRelease} onOpenChange={setConfirmRelease}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Release this workspace?</AlertDialogTitle>
            <AlertDialogDescription>
              All processes the workspace owns on the runner will be terminated.
              The workspace row stays for audit; agents that hold the workspace
              id will get a structured error on the next call.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => releaseMutation.mutate()}>
              Release
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function BackHeader() {
  return (
    <div>
      <Link to="/workspaces" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="mr-1 h-4 w-4" />
        Workspaces
      </Link>
    </div>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  )
}
