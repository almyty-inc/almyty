import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Cpu, Trash2 } from 'lucide-react'

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
import { runnersApi, workspacesApi } from '@/lib/api'
import { formatRelativeTime } from '@/lib/utils'
import { useNotifications } from '@/store/app'
import { runnerStateVariant, workspaceStatusVariant, RUNNER_HEARTBEAT_POLL_MS } from './runners-shared'

interface Runner {
  id: string
  name: string
  state: 'registered' | 'online' | 'busy' | 'stale' | 'draining' | 'offline'
  labels: Record<string, string>
  runtimeInfo: {
    os: string
    arch: string
    hostname: string
    cpuCount: number
    memoryMb: number
    runnerVersion: string
    binaries: Record<string, string | null>
  } | null
  config: { maxConcurrent: number } | null
  lastHeartbeatAt: string | null
  registeredAt: string
}

interface Workspace {
  id: string
  runnerId: string
  cwd: string
  isolation: 'container' | 'host'
  status: 'active' | 'released' | 'expired' | 'stranded'
  ttlAt: string | null
  closeReason: { kind: string; detail: string } | null
  createdAt: string
}

export function RunnerDetailPage() {
  const { id = '' } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { success, error: errNotif } = useNotifications()
  const [confirmDelete, setConfirmDelete] = useState(false)

  const runnerQuery = useQuery<Runner>({
    queryKey: ['runner', id],
    queryFn: () => runnersApi.getById(id),
    enabled: !!id,
    refetchInterval: RUNNER_HEARTBEAT_POLL_MS,
  })

  const workspacesQuery = useQuery<Workspace[]>({
    queryKey: ['workspaces', { runnerId: id }],
    queryFn: () => workspacesApi.getAll(),
    enabled: !!id,
    refetchInterval: RUNNER_HEARTBEAT_POLL_MS,
    select: (all) => all.filter(w => w.runnerId === id),
  })

  const unregisterMutation = useMutation({
    mutationFn: () => runnersApi.unregister(id),
    onSuccess: () => {
      success('Runner deregistered')
      queryClient.invalidateQueries({ queryKey: ['runners'] })
      navigate('/runners')
    },
    onError: (err: any) => errNotif('Deregister failed', err?.response?.data?.message ?? err.message),
  })

  if (runnerQuery.isLoading) {
    return (
      <div className="space-y-6">
        <BackHeader />
        <div className="py-12 flex justify-center"><LoadingSpinner size="lg" /></div>
      </div>
    )
  }

  if (runnerQuery.isError || !runnerQuery.data) {
    return (
      <div className="space-y-6">
        <BackHeader />
        <QueryError
          error={runnerQuery.error as Error}
          onRetry={runnerQuery.refetch}
          title="Couldn't load runner"
        />
      </div>
    )
  }

  const runner = runnerQuery.data
  const workspaces = workspacesQuery.data ?? []
  const active = workspaces.filter(w => w.status === 'active')
  const recent = workspaces.filter(w => w.status !== 'active').slice(0, 10)

  return (
    <div className="space-y-6">
      <BackHeader />

      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <Cpu className="h-7 w-7 text-muted-foreground" />
          <div>
            <h1 className="text-2xl font-bold">{runner.name}</h1>
            <div className="flex items-center gap-2 mt-1">
              <Badge variant={runnerStateVariant[runner.state]}>{runner.state}</Badge>
              <span className="text-sm text-muted-foreground" title={runner.lastHeartbeatAt ?? ''}>
                {runner.lastHeartbeatAt
                  ? `Last heartbeat ${formatRelativeTime(runner.lastHeartbeatAt)}`
                  : 'No heartbeat yet'}
              </span>
            </div>
          </div>
        </div>
        {runner.state === 'offline' && (
          <Button
            variant="destructive"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Deregister
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Runtime</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="OS / arch" value={runner.runtimeInfo ? `${runner.runtimeInfo.os} / ${runner.runtimeInfo.arch}` : '—'} />
            <Row label="Hostname" value={runner.runtimeInfo?.hostname ?? '—'} />
            <Row label="CPU" value={runner.runtimeInfo?.cpuCount ? String(runner.runtimeInfo.cpuCount) : '—'} />
            <Row label="Memory" value={runner.runtimeInfo?.memoryMb ? `${Math.round(runner.runtimeInfo.memoryMb / 1024)} GB` : '—'} />
            <Row label="Runner version" value={runner.runtimeInfo?.runnerVersion ?? '—'} />
            <Row label="Capacity" value={runner.config ? `up to ${runner.config.maxConcurrent} concurrent` : '—'} />
            <Row label="Registered" value={formatRelativeTime(runner.registeredAt)} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Labels</CardTitle>
          </CardHeader>
          <CardContent>
            {Object.keys(runner.labels ?? {}).length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No labels set. Labels are routing tags configured on the runner side via{' '}
                <code>--label k=v</code> or in <code>~/.almyty/config.json</code>.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1">
                {Object.entries(runner.labels).map(([k, v]) => (
                  <Badge key={k} variant="outline" className="font-normal">
                    {k}={v}
                  </Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Capabilities</CardTitle>
        </CardHeader>
        <CardContent>
          <BinariesGrid binaries={runner.runtimeInfo?.binaries ?? {}} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Active workspaces ({active.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {active.length === 0
            ? <p className="text-sm text-muted-foreground">No active workspaces pinned to this runner.</p>
            : <WorkspaceTable rows={active} />}
        </CardContent>
      </Card>

      {recent.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent workspaces</CardTitle>
          </CardHeader>
          <CardContent>
            <WorkspaceTable rows={recent} />
          </CardContent>
        </Card>
      )}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deregister this runner?</AlertDialogTitle>
            <AlertDialogDescription>
              The runner row will be removed from your account. Any historical
              workspace records remain. The runner daemon (if it's still running
              somewhere) will fail its next heartbeat and exit.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => unregisterMutation.mutate()}>
              Deregister
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
      <Link to="/runners" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="mr-1 h-4 w-4" />
        Runners
      </Link>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span>{value}</span>
    </div>
  )
}

function BinariesGrid({ binaries }: { binaries: Record<string, string | null> }) {
  const entries = useMemo(
    () => Object.entries(binaries).sort(([, a], [, b]) => Number(b !== null) - Number(a !== null)),
    [binaries],
  )
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">No binary detection results yet.</p>
  }
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 text-sm">
      {entries.map(([name, version]) => (
        <div key={name} className="flex justify-between border rounded px-3 py-2">
          <span className="font-medium">{name}</span>
          <span className={version ? 'text-muted-foreground' : 'text-muted-foreground/60 italic'}>
            {version ?? 'not detected'}
          </span>
        </div>
      ))}
    </div>
  )
}

function WorkspaceTable({ rows }: { rows: Workspace[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="pb-2 pr-4 font-medium">Id</th>
            <th className="pb-2 pr-4 font-medium">cwd</th>
            <th className="pb-2 pr-4 font-medium">Isolation</th>
            <th className="pb-2 pr-4 font-medium">Status</th>
            <th className="pb-2 font-medium">TTL / closed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(w => (
            <tr key={w.id} className="border-b last:border-b-0">
              <td className="py-2 pr-4">
                <Link to={`/workspaces/${w.id}`} className="font-mono text-xs hover:underline">
                  {w.id.slice(0, 8)}…
                </Link>
              </td>
              <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">{w.cwd}</td>
              <td className="py-2 pr-4">
                <Badge variant="outline" className="font-normal">{w.isolation}</Badge>
              </td>
              <td className="py-2 pr-4">
                <Badge variant={workspaceStatusVariant[w.status]}>{w.status}</Badge>
              </td>
              <td className="py-2 text-muted-foreground">
                {w.status === 'active'
                  ? (w.ttlAt ? `expires ${formatRelativeTime(w.ttlAt)}` : 'no TTL')
                  : (w.closeReason?.kind ?? '—')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
