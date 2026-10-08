/**
 * One hosted environment, at /runners/hosted/:id: the machines on it (the
 * caller's own; every one for an org admin) with Suspend and Release, the
 * agents that run on it, and its settings, edited in place.
 */
import { DETAIL_TITLE_CLASSES } from '@/components/layout/page-header'
import { useEffect, useMemo } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { ArrowLeft, Bot, Cloud, Trash2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { DataTable } from '@/components/ui/data-table'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { VisibilityBadge, useTeamLookup } from '@/components/ui/team-filter'
import { EnvironmentForm } from '@/components/runners/environment-form'
import { HostedUnavailable, useEnvironmentWorkspaces, useEnvironments } from '@/components/runners/hosted-environments-tab'
import {
  MACHINE_STATUS_LABEL,
  MACHINE_STATUS_VARIANT,
  filesKeptUntil,
  isLiveWorkspace,
  machineStatus,
  type HostedEnvironment,
  type HostedWorkspace,
} from '@/components/runners/hosted-shared'
import { agentsApi, environmentsApi, organizationsApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { formatDate, formatDateTime, formatRelativeTime, pluralized } from '@/lib/utils'
import { useNotifications } from '@/store/app'
import { useAuthStore } from '@/store/auth'
import { useOrganizationStore } from '@/store/organization'
import { useOrganizationRole } from '@/hooks/use-organization-role'
import { HOSTED_TAB_PATH } from './environment-new'

interface Member {
  id?: string
  userId?: string
  firstName?: string
  lastName?: string
  email?: string
}

export function EnvironmentDetailPage() {
  const { id = '' } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { success, error: notifyError } = useNotifications()
  const { confirm, dialog: confirmDialog } = useConfirm()
  const orgId = useOrganizationStore((s) => s.currentOrganization?.id)
  const userId = useAuthStore((s) => s.user?.id)
  const { canManage } = useOrganizationRole()
  const { byId: teamLookup } = useTeamLookup(orgId)
  const list = useEnvironments()

  const envQuery = useQuery<HostedEnvironment>({
    queryKey: ['environment', id],
    queryFn: () => environmentsApi.getById(id),
    enabled: !!id,
  })
  const env = envQuery.data

  useEffect(() => {
    document.title = env?.name ? `${env.name} | almyty` : 'Environment | almyty'
    return () => { document.title = 'almyty' }
  }, [env?.name])

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['environment', id] })
    queryClient.invalidateQueries({ queryKey: ['environments'] })
    queryClient.invalidateQueries({ queryKey: ['environment-workspaces', id] })
  }

  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) => environmentsApi.update(id, body),
    onSuccess: () => {
      success('Environment saved', 'Machines started from now on use the new settings.')
      refresh()
    },
    onError: (err) => notifyError('Could not save the environment', getApiErrorMessage(err)),
  })
  const remove = useMutation({
    mutationFn: () => environmentsApi.remove(id),
    onSuccess: () => {
      success('Environment deleted')
      queryClient.invalidateQueries({ queryKey: ['environments'] })
      navigate(HOSTED_TAB_PATH)
    },
    onError: (err) => notifyError('Could not delete the environment', getApiErrorMessage(err)),
  })

  if (envQuery.isLoading) {
    return (
      <div className="space-y-6">
        <BackLink />
        <div className="py-12 flex justify-center"><LoadingSpinner size="lg" /></div>
      </div>
    )
  }
  if (envQuery.isError || !env) {
    return (
      <div className="space-y-6">
        <BackLink />
        <QueryError error={envQuery.error as Error} onRetry={() => envQuery.refetch()} title="Couldn't load the environment" />
      </div>
    )
  }

  const mayChange = env.ownerUserId === userId || canManage
  const hostedOff = list.enabled === false

  return (
    <div className="space-y-6">
      <BackLink />

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <Cloud className="h-7 w-7 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <h1 className={DETAIL_TITLE_CLASSES}>{env.name}</h1>
            <div className="flex flex-wrap items-center gap-2 mt-1">
              <Badge variant="outline">hosted</Badge>
              <VisibilityBadge visibility={env.visibility} teamId={env.teamId} teamLookup={teamLookup} />
              <span className="text-sm text-muted-foreground">Parks after {pluralized(env.idleTimeoutMinutes, 'minute')} without use</span>
            </div>
          </div>
        </div>
        {mayChange && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive"
            disabled={remove.isPending}
            onClick={async () => {
              const ok = await confirm({
                title: <>Delete environment {env.name}?</>,
                description: 'Every machine on it stops and its files are deleted.',
                confirmLabel: 'Delete',
                cancelLabel: 'Keep it',
                destructive: true,
              })
              if (ok) remove.mutate()
            }}
          >
            <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
            Delete
          </Button>
        )}
      </div>

      {hostedOff && <HostedUnavailable />}

      <MachinesCard environment={env} keepDays={list.settings.suspendedRetention.keepDays} userId={userId} confirm={confirm} />

      <AgentsCard environmentId={env.id} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Settings</CardTitle>
          <CardDescription className="text-xs">
            {mayChange ? 'Changes apply to machines started after you save. A running machine keeps its settings until it parks.' : 'Only its owner or an organization admin can change it.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <EnvironmentForm
            key={`${env.id}-${env.version}-${env.updatedAt ?? ''}`}
            organizationId={orgId ?? ''}
            settings={list.settings}
            initial={env}
            submitLabel="Save changes"
            submitting={update.isPending}
            disabled={!mayChange || hostedOff}
            onSubmit={(body) => update.mutate(body)}
          />
        </CardContent>
      </Card>

      {confirmDialog}
    </div>
  )
}

function BackLink() {
  return (
    <Link to={HOSTED_TAB_PATH} className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="mr-1 h-4 w-4" />
      Runners
    </Link>
  )
}

function MachinesCard({
  environment,
  keepDays,
  userId,
  confirm,
}: {
  environment: HostedEnvironment
  keepDays: number
  userId?: string
  confirm: ReturnType<typeof useConfirm>['confirm']
}) {
  const queryClient = useQueryClient()
  const { success, error: notifyError } = useNotifications()
  const orgId = useOrganizationStore((s) => s.currentOrganization?.id)
  const query = useEnvironmentWorkspaces(environment.id)
  const rows = useMemo(() => (query.data ?? []).filter(isLiveWorkspace), [query.data])
  const othersShown = rows.some((w) => w.ownerUserId !== userId)
  const members = useQuery<Member[]>({
    queryKey: ['organization-members', orgId],
    queryFn: () => organizationsApi.getMembers(orgId as string),
    enabled: !!orgId && othersShown,
  })

  const after = (verb: string) => ({
    onSuccess: () => {
      success(verb)
      queryClient.invalidateQueries({ queryKey: ['environment-workspaces', environment.id] })
    },
    onError: (err: unknown) => notifyError('That did not work', getApiErrorMessage(err)),
  })
  const suspend = useMutation({ mutationFn: (w: HostedWorkspace) => environmentsApi.suspend(environment.id, w.id), ...after('Machine parked') })
  const release = useMutation({ mutationFn: (w: HostedWorkspace) => environmentsApi.release(environment.id, w.id), ...after('Workspace released') })

  const whose = (w: HostedWorkspace): string => {
    const person = w.ownerUserId === userId
      ? 'You'
      : (() => {
          const list = Array.isArray(members.data) ? members.data : []
          const m = list.find((x) => (x.userId ?? x.id) === w.ownerUserId)
          return m ? [m.firstName, m.lastName].filter(Boolean).join(' ') || m.email || 'A member' : 'A member'
        })()
    return w.agentId ? `${person}, for an agent` : person
  }

  const columns: ColumnDef<HostedWorkspace>[] = [
    { id: 'whose', header: 'Whose', cell: ({ row }) => <span className="text-sm">{whose(row.original)}</span> },
    {
      id: 'status',
      header: 'Machine',
      cell: ({ row }) => {
        const status = machineStatus(row.original)
        return (
          <div className="space-y-0.5">
            <Badge variant={MACHINE_STATUS_VARIANT[status]}>{MACHINE_STATUS_LABEL[status]}</Badge>
            {status === 'failed' && row.original.machine?.lastError && (
              <p className="max-w-xs text-xs text-destructive">{row.original.machine.lastError}</p>
            )}
          </div>
        )
      },
    },
    {
      id: 'lastActive',
      header: 'Last active',
      cell: ({ row }) => {
        const at = row.original.lastActiveAt
        return <span className="text-sm text-muted-foreground" title={at ? formatDateTime(at) : ''}>{at ? formatRelativeTime(at) : 'never'}</span>
      },
    },
    {
      id: 'files',
      header: 'Files',
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {machineStatus(row.original) === 'parked' ? `kept until ${formatDate(filesKeptUntil(row.original, keepDays))}` : 'kept'}
        </span>
      ),
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => {
        const w = row.original
        const status = machineStatus(w)
        return (
          <div className="flex justify-end gap-2">
            {(status === 'running' || status === 'waking') && (
              <Button variant="outline" size="sm" disabled={suspend.isPending} onClick={() => suspend.mutate(w)} title="Stop the machine now; its files stay">
                Suspend
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              disabled={release.isPending}
              onClick={async () => {
                const ok = await confirm({
                  title: 'Release this workspace and delete its files?',
                  confirmLabel: 'Release',
                  cancelLabel: 'Keep it',
                  destructive: true,
                })
                if (ok) release.mutate(w)
              }}
            >
              Release
            </Button>
          </div>
        )
      },
    },
  ]

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{othersShown ? 'Machines' : 'Your machine'}</CardTitle>
        <CardDescription className="text-xs">
          Everyone who uses this environment gets a machine and files of their own. A machine parks itself after {pluralized(environment.idleTimeoutMinutes, 'minute')} without use; a parked machine's files are kept for {keepDays} days after its last use.
        </CardDescription>
      </CardHeader>
      <CardContent data-testid="environment-machines">
        {query.isError ? (
          <QueryError error={query.error as Error} onRetry={() => query.refetch()} title="Couldn't load the machines" />
        ) : !query.isLoading && rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No machine yet. Yours starts the first time one of your agents or tools uses this environment.</p>
        ) : (
          <DataTable columns={columns} data={rows} loading={query.isLoading} hideSelectionCount hideColumnsButton hidePaginationWhenSinglePage />
        )}
      </CardContent>
    </Card>
  )
}

function AgentsCard({ environmentId }: { environmentId: string }) {
  const agentsQuery = useQuery({ queryKey: ['agents-list'], queryFn: () => agentsApi.getAll() })
  const all: any[] = Array.isArray(agentsQuery.data) ? agentsQuery.data : (agentsQuery.data as any)?.data ?? []
  const here = all.filter((a) => a?.agentConfig?.environmentId === environmentId)
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Agents that run here</CardTitle>
      </CardHeader>
      <CardContent>
        {agentsQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : here.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            None yet. To run an agent here, open it, click Edit, and under Capabilities choose this environment in <span className="text-foreground">Runs on</span>.
          </p>
        ) : (
          <div className="space-y-2">
            {here.map((a) => (
              <Link key={a.id} to={`/agents/${a.id}`} className="flex items-center gap-2 border rounded-md px-3 py-2 hover:bg-muted/50 transition-colors">
                <Bot className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">{a.name}</span>
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
