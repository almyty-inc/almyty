/**
 * A runner's Workspaces tab: the folders agent runs were given on this
 * machine, active first, with the agent and run each was made for and a
 * Release action. Each row opens the workspace's own page under the
 * runner. An agent run gets a workspace automatically when a runner tool
 * it calls needs one, so there is no create button.
 */
import { useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { Layers } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { DataTable } from '@/components/ui/data-table'
import { EmptyState } from '@/components/ui/empty-state'
import { QueryError } from '@/components/ui/query-error'
import { workspacesApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { formatDateTime, formatRelativeTime } from '@/lib/utils'
import { useNotifications } from '@/store/app'
import { RUNNER_HEARTBEAT_POLL_MS, workspaceStatusVariant } from '@/pages/runners-shared'

export interface RunnerWorkspace {
  id: string
  runnerId: string
  cwd: string
  isolation: 'container' | 'host'
  status: 'active' | 'released' | 'expired' | 'stranded'
  ttlAt: string | null
  closeReason: { kind: string; detail: string } | null
  createdAt: string
  /** The folder name the runner made, for a workspace an agent run was given. */
  name?: string | null
  /** The agent and run it was made for; null for one made through the API. */
  agentId?: string | null
  runId?: string | null
  agent?: { id: string; name: string } | null
}

/** Where one workspace's page is: under the runner it is pinned to. */
export function workspacePath(workspace: Pick<RunnerWorkspace, 'id' | 'runnerId'>): string {
  return `/runners/${encodeURIComponent(workspace.runnerId)}/workspaces/${encodeURIComponent(workspace.id)}`
}

/**
 * How long until a time limit runs out, in words ("in 3h"). The shared
 * relative-time helper reads only the past, so a future limit said "just now".
 */
export function timeLeft(iso: string, now = Date.now()): string {
  const ms = Date.parse(iso) - now
  if (!Number.isFinite(ms) || ms <= 60_000) return 'now'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `in ${hours}h`
  return `in ${Math.round(hours / 24)}d`
}

/** This runner's workspaces, active ones first, then newest first. */
export function runnerWorkspaces(all: RunnerWorkspace[], runnerId: string): RunnerWorkspace[] {
  return all
    .filter((w) => w.runnerId === runnerId)
    .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || b.createdAt.localeCompare(a.createdAt))
}

export function useRunnerWorkspaces(runnerId: string, { poll = true }: { poll?: boolean } = {}) {
  return useQuery<RunnerWorkspace[]>({
    queryKey: ['workspaces', { runnerId }],
    queryFn: () => workspacesApi.getAll(),
    enabled: !!runnerId,
    // An offline runner cannot take new work, and every workspace pinned
    // to it has already been stranded, so there is nothing left to find.
    refetchInterval: poll ? RUNNER_HEARTBEAT_POLL_MS : false,
    select: (all) => runnerWorkspaces(all ?? [], runnerId),
  })
}

/** Who made a workspace: the agent and run it was given to, or nobody named. */
export function WorkspaceOrigin({ workspace }: { workspace: Pick<RunnerWorkspace, 'agentId' | 'agent' | 'runId'> }) {
  if (!workspace.agentId && !workspace.runId) return <span className="text-sm text-muted-foreground">API</span>
  const agentLabel = workspace.agent?.name ?? 'deleted agent'
  return (
    <span className="text-sm">
      {workspace.agentId && workspace.agent ? (
        <Link
          to={`/agents/${encodeURIComponent(workspace.agentId)}?tab=runs`}
          className="hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {agentLabel}
        </Link>
      ) : (
        <span className="text-muted-foreground">{agentLabel}</span>
      )}
      {workspace.runId && (
        <span className="ml-1 font-mono text-xs text-muted-foreground" title={workspace.runId}>
          run {workspace.runId.slice(0, 8)}
        </span>
      )}
    </span>
  )
}

export function RunnerWorkspacesTab({ runnerId, poll = true }: { runnerId: string; poll?: boolean }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { success, error: errNotif } = useNotifications()
  const { confirm, dialog: confirmDialog } = useConfirm()
  const query = useRunnerWorkspaces(runnerId, { poll })
  const rows = useMemo(() => query.data ?? [], [query.data])

  const releaseMutation = useMutation({
    mutationFn: (id: string) => workspacesApi.release(id),
    onSuccess: () => {
      success('Workspace released')
      queryClient.invalidateQueries({ queryKey: ['workspaces'] })
    },
    onError: (err: any) => errNotif('Release failed', getApiErrorMessage(err)),
  })

  const columns = useMemo<ColumnDef<RunnerWorkspace, any>[]>(
    () => [
      {
        accessorKey: 'cwd',
        header: 'Folder',
        cell: ({ row }) => <span className="font-mono text-xs">{row.original.cwd}</span>,
      },
      {
        id: 'origin',
        header: 'Made for',
        cell: ({ row }) => <WorkspaceOrigin workspace={row.original} />,
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ row }) => <Badge variant={workspaceStatusVariant[row.original.status]}>{row.original.status}</Badge>,
      },
      {
        accessorKey: 'isolation',
        header: 'Isolation',
        cell: ({ row }) => (
          <Badge variant="outline" className="font-normal">
            {row.original.isolation}
          </Badge>
        ),
      },
      {
        id: 'ttl',
        header: 'Time limit',
        cell: ({ row }) => {
          const w = row.original
          const text = w.status === 'active' ? (w.ttlAt ? `ends ${timeLeft(w.ttlAt)}` : 'none') : `closed: ${w.closeReason?.kind ?? w.status}`
          return <span className="text-sm text-muted-foreground">{text}</span>
        },
      },
      {
        accessorKey: 'createdAt',
        header: 'Created',
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground" title={formatDateTime(row.original.createdAt)}>
            {formatRelativeTime(row.original.createdAt)}
          </span>
        ),
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) =>
          row.original.status === 'active' ? (
            <Button
              variant="outline"
              size="sm"
              disabled={releaseMutation.isPending}
              onClick={async (e) => {
                e.stopPropagation()
                const ok = await confirm({
                  title: 'Release this workspace?',
                  description:
                    "Every process it runs on the runner is stopped; the folder and its files stay on the machine. If an agent run was given it, the run's next runner call gets a new workspace in the same folder.",
                  confirmLabel: 'Release workspace',
                  destructive: true,
                })
                if (ok) releaseMutation.mutate(row.original.id)
              }}
            >
              Release
            </Button>
          ) : null,
      },
    ],
    [confirm, releaseMutation],
  )

  if (query.isError) return <QueryError error={query.error as Error} onRetry={() => query.refetch()} title="Couldn't load workspaces" />
  return (
    <Card>
      <CardContent className="pt-6" data-testid="runner-workspaces">
        <DataTable
          columns={columns}
          data={rows}
          loading={query.isLoading}
          onRowClick={(w) => navigate(workspacePath(w))}
          searchKey="cwd"
          searchPlaceholder="Search folders"
          hideSelectionCount
          hideColumnsButton
          emptyState={
            <EmptyState
              icon={Layers}
              title="No workspaces yet"
              description="When an agent run needs a folder on this runner, it gets one here automatically, for a limited time. You don't create them by hand."
            />
          }
        />
        {confirmDialog}
      </CardContent>
    </Card>
  )
}