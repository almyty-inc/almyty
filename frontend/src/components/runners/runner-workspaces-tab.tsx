/**
 * A runner's Workspaces tab: the directories agents reserved on this
 * machine, active first. Each row opens the workspace's own page under the
 * runner. Workspaces are made by agents when a job needs a directory, never
 * by hand, so there is no create button.
 */
import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { Layers } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { DataTable } from '@/components/ui/data-table'
import { EmptyState } from '@/components/ui/empty-state'
import { QueryError } from '@/components/ui/query-error'
import { workspacesApi } from '@/lib/api'
import { formatDateTime, formatRelativeTime } from '@/lib/utils'
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

const columns: ColumnDef<RunnerWorkspace, any>[] = [
  {
    accessorKey: 'cwd',
    header: 'Folder',
    cell: ({ row }) => <span className="font-mono text-xs">{row.original.cwd}</span>,
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
]

export function RunnerWorkspacesTab({ runnerId, poll = true }: { runnerId: string; poll?: boolean }) {
  const navigate = useNavigate()
  const query = useRunnerWorkspaces(runnerId, { poll })
  const rows = useMemo(() => query.data ?? [], [query.data])

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
              description="An agent reserves a folder on this runner when a job needs one, for a limited time. You don't create them by hand."
            />
          }
        />
      </CardContent>
    </Card>
  )
}
