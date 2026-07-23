import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { Cpu, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  DataTable,
  createActionsColumn,
  createSortableColumn,
} from '@/components/ui/data-table'
import { EmptyState } from '@/components/ui/empty-state'
import { QueryError } from '@/components/ui/query-error'
import { runnersApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'
import { runnerStateVariant, RUNNER_HEARTBEAT_POLL_MS } from './runners-shared'
import { formatRelativeTime } from '@/lib/utils'
import {
  TeamFilter,
  useTeamLookup,
  VisibilityBadge,
  filterByTeamVisibility,
  type TeamFilterValue,
  type Team,
} from '@/components/ui/team-filter'

interface Runner {
  id: string
  name: string
  state: 'registered' | 'online' | 'busy' | 'stale' | 'draining' | 'offline'
  labels: Record<string, string>
  visibility?: 'org' | 'team' | null
  teamId?: string | null
  runtimeInfo: {
    os: string
    arch: string
    hostname: string
    cpuCount: number
    memoryMb: number
    runnerVersion: string
    binaries: Record<string, string | null>
  } | null
  config: {
    maxConcurrent: number
  } | null
  lastHeartbeatAt: string | null
  registeredAt: string
}

export function RunnersPage() {
  const navigate = useNavigate()
  const { currentOrganization } = useOrganizationStore()
  const [teamFilter, setTeamFilter] = useState<TeamFilterValue>('all')
  const { byId: teamLookup } = useTeamLookup(currentOrganization?.id)

  useEffect(() => {
    document.title = 'Runners | almyty'
    return () => { document.title = 'almyty' }
  }, [])

  const { data: runners = [], isLoading, isError, error, refetch } = useQuery<Runner[]>({
    queryKey: ['runners', currentOrganization?.id],
    queryFn: () => runnersApi.getAll(),
    enabled: !!currentOrganization,
    refetchInterval: RUNNER_HEARTBEAT_POLL_MS,
  })

  const visibleRunners = filterByTeamVisibility(runners, teamFilter)
  const onlineCount = runners.filter((r) => r.state === 'online' || r.state === 'busy').length

  const columns = useMemo<ColumnDef<Runner>[]>(() => [
    {
      ...createSortableColumn<Runner>('name', 'Name'),
      cell: ({ row }) => {
        const r = row.original
        return (
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-primary/10 rounded-lg flex items-center justify-center">
              <Cpu className="h-4 w-4 text-primary" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium">{r.name}</span>
                <VisibilityBadge
                  visibility={r.visibility}
                  teamId={r.teamId}
                  teamLookup={teamLookup}
                />
              </div>
              {r.runtimeInfo?.hostname && (
                <div className="text-xs text-muted-foreground">{r.runtimeInfo.hostname}</div>
              )}
            </div>
          </div>
        )
      },
    },
    {
      ...createSortableColumn<Runner>('state', 'State'),
      cell: ({ row }) => (
        <Badge variant={runnerStateVariant[row.original.state]}>{row.original.state}</Badge>
      ),
    },
    {
      accessorKey: 'runtimeInfo',
      header: 'OS / arch',
      cell: ({ row }) => {
        const rt = row.original.runtimeInfo
        return (
          <span className="text-sm text-muted-foreground">
            {rt ? `${rt.os} / ${rt.arch}` : '\u2014'}
          </span>
        )
      },
    },
    {
      accessorKey: 'lastHeartbeatAt',
      header: 'Last heartbeat',
      cell: ({ row }) => (
        <span
          className="text-sm text-muted-foreground"
          title={row.original.lastHeartbeatAt ?? ''}
        >
          {row.original.lastHeartbeatAt ? formatRelativeTime(row.original.lastHeartbeatAt) : 'never'}
        </span>
      ),
    },
    {
      accessorKey: 'config',
      header: 'Capacity',
      cell: ({ row }) => {
        const max = row.original.config?.maxConcurrent ?? 0
        return (
          <span className="text-sm text-muted-foreground">
            {max ? `0 / ${max}` : '\u2014'}
          </span>
        )
      },
    },
    {
      accessorKey: 'labels',
      header: 'Labels',
      cell: ({ row }) => {
        const entries = Object.entries(row.original.labels ?? {})
        if (entries.length === 0) {
          return <span className="text-sm text-muted-foreground">{"\u2014"}</span>
        }
        return (
          <div className="flex flex-wrap gap-1">
            {entries.slice(0, 4).map(([k, v]) => (
              <Badge key={k} variant="outline" className="font-normal">
                {k}={v}
              </Badge>
            ))}
            {entries.length > 4 && (
              <span className="text-xs text-muted-foreground">+{entries.length - 4}</span>
            )}
          </div>
        )
      },
    },
    createActionsColumn<Runner>(
      () => {},
      () => {},
      [
        { label: 'View details', onClick: (r) => navigate(`/runners/${r.id}`) },
      ],
    ),
  ], [navigate, teamLookup])

  if (isError) {
    return (
      <div className="space-y-6">
        <RunnersHeader runners={runners} onlineCount={onlineCount} onCreate={() => navigate('/runners/new')} />
        <QueryError error={error as Error} onRetry={refetch} title="Couldn't load runners" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <RunnersHeader runners={runners} onlineCount={onlineCount} onCreate={() => navigate('/runners/new')} />

      {!isLoading && runners.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={Cpu}
              title="No runners registered"
              description="A runner connects one of your machines and publishes its capabilities as tools. Code and credentials stay local."
              action={
                <Button onClick={() => navigate('/runners/new')}>
                  <Plus className="mr-2 h-4 w-4" />
                  Set up runner
                </Button>
              }
              className="py-16"
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="pt-6 space-y-4">
            <div className="flex items-center justify-end">
              <TeamFilter
                organizationId={currentOrganization?.id}
                value={teamFilter}
                onChange={setTeamFilter}
              />
            </div>
            <DataTable
              columns={columns}
              data={visibleRunners}
              loading={isLoading}
              searchKey="name"
              searchPlaceholder="Search runners..."
              onRowClick={(r) => navigate(`/runners/${r.id}`)}
              hideSelectionCount
              hideColumnsButton
              emptyState={
                <EmptyState
                  icon={Cpu}
                  title="No runners match your filters"
                  description="Try changing the team filter or search."
                  className="py-16"
                />
              }
            />
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function RunnersHeader({
  runners,
  onlineCount,
  onCreate,
}: {
  runners: Runner[]
  onlineCount: number
  onCreate: () => void
}) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-4xl font-heading font-extrabold tracking-tight bg-gradient-to-r from-violet-500 to-cyan-400 bg-clip-text text-transparent">
          Runners
        </h1>
        <p className="text-muted-foreground">
          {runners.length} runner{runners.length !== 1 ? 's' : ''} &middot; {onlineCount} online
        </p>
      </div>
      <Button onClick={onCreate}>
        <Plus className="mr-2 h-4 w-4" />
        Start a runner
      </Button>
    </div>
  )
}
