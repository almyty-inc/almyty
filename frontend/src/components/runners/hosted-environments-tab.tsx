/**
 * The Hosted tab on /runners: the environments the caller may see, each
 * with the state of the caller's own machine on it (`mine` on each row of
 * GET /environments) and its runner minutes this month
 * (GET /environments/usage). Creating one is a page (/runners/hosted/new),
 * never a dialog.
 */
import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { Cloud, Info, Plus } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { DataTable, createSortableColumn } from '@/components/ui/data-table'
import { EmptyState } from '@/components/ui/empty-state'
import { QueryError } from '@/components/ui/query-error'
import { VisibilityBadge, useTeamLookup } from '@/components/ui/team-filter'
import { environmentsApi } from '@/lib/api'
import { formatDate, formatRelativeTime } from '@/lib/utils'
import { useOrganizationStore } from '@/store/organization'
import { RUNNER_HEARTBEAT_POLL_MS } from '@/pages/runners-shared'
import {
  MACHINE_STATUS_LABEL,
  MACHINE_STATUS_VARIANT,
  filesKeptUntil,
  formatMinutes,
  imageLabel,
  machineStatus,
  readHostedSettings,
  type EnvironmentUsage,
  type HostedEnvironment,
  type HostedWorkspace,
  type MyMachine,
} from './hosted-shared'

export const NEW_ENVIRONMENT_PATH = '/runners/hosted/new'
export const environmentPath = (id: string) => `/runners/hosted/${encodeURIComponent(id)}`
export const HOSTED_DOCS_URL = 'https://docs.almyty.com/hosted-machines'

/** The environments list, whether hosted machines are on, and the install's settings: one query, shared by every hosted page. */
export function useEnvironments() {
  const orgId = useOrganizationStore((s) => s.currentOrganization?.id)
  const query = useQuery({
    queryKey: ['environments', orgId],
    queryFn: () => environmentsApi.list(),
    enabled: !!orgId,
    // Each row carries the caller's machine, so the list polls like runners.
    refetchInterval: RUNNER_HEARTBEAT_POLL_MS,
  })
  const body = query.data
  return {
    ...query,
    environments: (Array.isArray(body?.data) ? body.data : []) as HostedEnvironment[],
    /** Unknown until loaded. */
    enabled: body ? body.enabled !== false : undefined,
    /** The install's choices; null until the API has sent them. */
    settings: readHostedSettings(body?.settings),
  }
}

/** Runner minutes this month: per environment the caller can see, and the organization's total for owners and admins. */
export function useEnvironmentUsage() {
  const orgId = useOrganizationStore((s) => s.currentOrganization?.id)
  return useQuery<EnvironmentUsage>({
    queryKey: ['environment-usage', orgId],
    queryFn: () => environmentsApi.usage(),
    enabled: !!orgId,
  })
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
export function MachineCell({ mine, keepDays }: { mine: MyMachine | null | undefined; keepDays: number | undefined }) {
  if (!mine) {
    return <span className="text-sm text-muted-foreground" data-testid="machine-none">Not started yet</span>
  }
  const status = machineStatus(mine)
  return (
    <div className="space-y-0.5" data-testid="machine-cell">
      <Badge variant={MACHINE_STATUS_VARIANT[status]}>{MACHINE_STATUS_LABEL[status]}</Badge>
      <div className="text-xs text-muted-foreground">
        {status === 'parked' && keepDays
          ? `Files kept until ${formatDate(filesKeptUntil(mine, keepDays))}`
          : mine.lastActiveAt
            ? `Last active ${formatRelativeTime(mine.lastActiveAt)}`
            : null}
      </div>
    </div>
  )
}

/**
 * The Hosted tab's one line, in the PageIntro look. The runners intro is
 * about connecting your own machine, which says the wrong thing here.
 * Shown only while hosted machines are on.
 */
export function HostedIntro() {
  const { enabled } = useEnvironments()
  if (!enabled) return null
  return (
    <div className="flex items-start gap-3 rounded-lg border border-violet-500/20 bg-violet-500/5 px-4 py-3 text-sm" data-testid="hosted-intro" role="note">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-violet-600 dark:text-violet-400" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-muted-foreground">
        almyty starts a machine for your agent when it needs one and parks it when nobody uses it. Its files stay.{' '}
        <a href={HOSTED_DOCS_URL} target="_blank" rel="noopener noreferrer" className="whitespace-nowrap font-medium text-violet-600 hover:underline dark:text-violet-400">
          How it works
        </a>
      </p>
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

/** The server sent no usable form choices (images, idle bounds, how long files are kept), so there is nothing honest to offer. */
export function SettingsMissing() {
  return (
    <Card>
      <CardContent className="pt-6 text-sm text-muted-foreground" data-testid="hosted-settings-missing">
        This server did not say what an environment may use, so one cannot be set up here right now. Try again later, or ask whoever runs the server.
      </CardContent>
    </Card>
  )
}

export function HostedEnvironmentsTab() {
  const navigate = useNavigate()
  const orgId = useOrganizationStore((s) => s.currentOrganization?.id)
  const { byId: teamLookup } = useTeamLookup(orgId)
  const list = useEnvironments()
  const usage = useEnvironmentUsage()
  const keepDays = list.settings?.suspendedRetention.keepDays
  const minutesById = useMemo(
    () => new Map((usage.data?.environments ?? []).map((u) => [u.environmentId, u.minutes])),
    [usage.data],
  )

  const columns = useMemo(() => hostedColumns(keepDays, minutesById, teamLookup), [keepDays, minutesById, teamLookup])

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
  const organization = usage.data?.organization
  return (
    <Card>
      <CardContent className="pt-6 space-y-4" data-testid="hosted-environments">
        {organization && (
          <p className="text-sm text-muted-foreground" data-testid="hosted-org-usage">
            Your organization's hosted machines ran <span className="font-medium text-foreground">{formatMinutes(organization.minutes)}</span> this month.
          </p>
        )}
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

function hostedColumns(
  keepDays: number | undefined,
  minutesById: Map<string, number>,
  teamLookup: ReturnType<typeof useTeamLookup>['byId'],
): ColumnDef<HostedEnvironment>[] {
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
      cell: ({ row }) => <MachineCell mine={row.original.mine} keepDays={keepDays} />,
    },
    {
      id: 'usage',
      header: 'This month',
      cell: ({ row }) => <span className="text-sm text-muted-foreground">{formatMinutes(minutesById.get(row.original.id) ?? 0)}</span>,
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
