/**
 * The Hosted tab on /runners: the environments the caller may see, each
 * with the state of the caller's own machine on it. Creating one is a page
 * (/runners/hosted/new), never a dialog.
 */
import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { Cloud, Plus } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { DataTable, createSortableColumn } from '@/components/ui/data-table'
import { EmptyState } from '@/components/ui/empty-state'
import { QueryError } from '@/components/ui/query-error'
import { VisibilityBadge, useTeamLookup } from '@/components/ui/team-filter'
import { environmentsApi } from '@/lib/api'
import { formatDate, formatRelativeTime } from '@/lib/utils'
import { useAuthStore } from '@/store/auth'
import { useOrganizationStore } from '@/store/organization'
import { RUNNER_HEARTBEAT_POLL_MS } from '@/pages/runners-shared'
import {
  MACHINE_STATUS_LABEL,
  MACHINE_STATUS_VARIANT,
  filesKeptUntil,
  imageLabel,
  machineStatus,
  ownWorkspace,
  readHostedSettings,
  type HostedEnvironment,
  type HostedSettings,
  type HostedWorkspace,
} from './hosted-shared'

export const NEW_ENVIRONMENT_PATH = '/runners/hosted/new'
export const environmentPath = (id: string) => `/runners/hosted/${encodeURIComponent(id)}`

/** The environments list, whether hosted machines are on, and the install's settings: one query, shared by every hosted page. */
export function useEnvironments() {
  const orgId = useOrganizationStore((s) => s.currentOrganization?.id)
  const query = useQuery({
    queryKey: ['environments', orgId],
    queryFn: () => environmentsApi.list(),
    enabled: !!orgId,
  })
  const body = query.data
  return {
    ...query,
    environments: (Array.isArray(body?.data) ? body.data : []) as HostedEnvironment[],
    /** Unknown until loaded; the API leaves it out only when it predates the flag, so absent counts as on. */
    enabled: body ? body.enabled !== false : undefined,
    settings: readHostedSettings(body?.settings),
  }
}

/** One environment's workspaces (the caller's own; every one for an org admin), polled like runners. */
export function useEnvironmentWorkspaces(environmentId: string, { poll = true }: { poll?: boolean } = {}) {
  return useQuery<HostedWorkspace[]>({
    queryKey: ['environment-workspaces', environmentId],
    queryFn: async () => {
      const rows = await environmentsApi.workspaces(environmentId)
      return Array.isArray(rows) ? rows : []
    },
    enabled: !!environmentId,
    refetchInterval: poll ? RUNNER_HEARTBEAT_POLL_MS : false,
  })
}

/** The caller's machine on an environment, in a word, with when it was last used or how long its files are kept. */
export function MachineCell({ environmentId, keepDays }: { environmentId: string; keepDays: number }) {
  const userId = useAuthStore((s) => s.user?.id)
  const query = useEnvironmentWorkspaces(environmentId)
  if (query.isLoading) return <span className="text-sm text-muted-foreground">…</span>
  const mine = ownWorkspace(query.data ?? [], userId)
  if (!mine) {
    return <span className="text-sm text-muted-foreground" data-testid="machine-none">Not started yet</span>
  }
  const status = machineStatus(mine)
  return (
    <div className="space-y-0.5" data-testid="machine-cell">
      <Badge variant={MACHINE_STATUS_VARIANT[status]}>{MACHINE_STATUS_LABEL[status]}</Badge>
      <div className="text-xs text-muted-foreground">
        {status === 'parked'
          ? `Files kept until ${formatDate(filesKeptUntil(mine, keepDays))}`
          : mine.lastActiveAt
            ? `Last active ${formatRelativeTime(mine.lastActiveAt)}`
            : null}
      </div>
    </div>
  )
}

export function HostedUnavailable() {
  return (
    <Card>
      <CardContent className="pt-6 text-sm text-muted-foreground" data-testid="hosted-unavailable">
        Hosted machines aren't available on this server. You can still run work on <span className="text-foreground">your own machines</span>.
      </CardContent>
    </Card>
  )
}

export function HostedEnvironmentsTab() {
  const navigate = useNavigate()
  const orgId = useOrganizationStore((s) => s.currentOrganization?.id)
  const { byId: teamLookup } = useTeamLookup(orgId)
  const list = useEnvironments()
  const { settings } = list

  const columns = useMemo(() => hostedColumns(settings, teamLookup), [settings, teamLookup])

  if (list.isError) return <QueryError error={list.error as Error} onRetry={() => list.refetch()} title="Couldn't load hosted environments" />
  if (list.enabled === false) return <HostedUnavailable />
  if (!list.isLoading && list.environments.length === 0) {
    return (
      <EmptyState
        variant="panel"
        icon={Cloud}
        title="No hosted environments yet"
        description="A hosted environment is a machine almyty runs for you. Describe it once: the repository, what it starts with, the sites it may reach. It starts when an agent needs it and parks itself when nobody uses it."
        action={
          <Button onClick={() => navigate(NEW_ENVIRONMENT_PATH)}>
            <Plus className="mr-2 h-4 w-4" />
            New environment
          </Button>
        }
      />
    )
  }
  return (
    <Card>
      <CardContent className="pt-6" data-testid="hosted-environments">
        <DataTable
          columns={columns}
          data={list.environments}
          loading={list.isLoading}
          searchKey="name"
          searchPlaceholder="Search environments..."
          onRowClick={(env) => navigate(environmentPath(env.id))}
          hideSelectionCount
          hideColumnsButton
        />
      </CardContent>
    </Card>
  )
}

function hostedColumns(settings: HostedSettings, teamLookup: ReturnType<typeof useTeamLookup>['byId']): ColumnDef<HostedEnvironment>[] {
  return [
    {
      ...createSortableColumn<HostedEnvironment>('name', 'Name'),
      cell: ({ row }) => {
        const env = row.original
        return (
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-primary/10 rounded-lg flex items-center justify-center">
              <Cloud className="h-4 w-4 text-primary" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium">{env.name}</span>
                <VisibilityBadge visibility={env.visibility} teamId={env.teamId} teamLookup={teamLookup} />
              </div>
              {env.repo?.url && <div className="truncate text-xs text-muted-foreground">{env.repo.url.replace(/^https:\/\//, '')}</div>}
            </div>
          </div>
        )
      },
    },
    {
      id: 'machine',
      header: 'Your machine',
      cell: ({ row }) => <MachineCell environmentId={row.original.id} keepDays={settings.suspendedRetention.keepDays} />,
    },
    {
      id: 'image',
      header: 'Starts with',
      cell: ({ row }) => <span className="text-sm text-muted-foreground">{imageLabel(row.original.image.base)}</span>,
    },
    {
      accessorKey: 'idleTimeoutMinutes',
      header: 'Parks after',
      cell: ({ row }) => <span className="text-sm text-muted-foreground">{row.original.idleTimeoutMinutes} min</span>,
    },
  ]
}
