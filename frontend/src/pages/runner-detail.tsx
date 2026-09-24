import { DETAIL_TITLE_CLASSES } from '@/components/layout/page-header'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Cpu, Trash2, Wrench } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { runnersApi, workspacesApi, toolsApi } from '@/lib/api'
import { formatRelativeTime } from '@/lib/utils'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import { useAuthStore } from '@/store/auth'
import type { Tool } from '@/types'
import {
  RUNNER_HEARTBEAT_POLL_MS,
  RUNNER_INSTALL_COMMAND,
  RUNNER_LOGIN_COMMAND,
  isPendingRunner,
  runnerStartCommand,
  runnerStateLabel,
  runnerStateVariant,
  workspaceStatusVariant,
} from './runners-shared'
import { getApiErrorMessage } from '@/lib/api-error'
import { VisibilityField, type VisibilityValue } from '@/components/ui/visibility-field'
import { VisibilityBadge, useTeamLookup } from '@/components/ui/team-filter'

interface CodingAgent {
  id: string
  displayName: string
  version: string
  providerFamily: string
  supportsMcp: boolean
  canManage: boolean
}

interface Runner {
  id: string
  name: string
  state: 'registered' | 'online' | 'busy' | 'stale' | 'draining' | 'offline'
  labels: Record<string, string>
  ownerUserId?: string
  visibility?: 'private' | 'team' | 'org'
  teamId?: string | null
  runtimeInfo: {
    os: string
    arch: string
    hostname: string
    cpuCount: number
    memoryMb: number
    runnerVersion: string
    binaries: Record<string, string | null>
    codingAgents?: CodingAgent[]
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
  const { confirm, dialog: confirmDialog } = useConfirm()

  const runnerQuery = useQuery<Runner>({
    queryKey: ['runner', id],
    queryFn: () => runnersApi.getById(id),
    enabled: !!id,
    // The FSM has no edge out of offline -- a runner that lost its
    // grace period is deregistered and re-registered, never revived --
    // so a bare interval polled a record that can never change again
    // for as long as the tab stayed open.
    refetchInterval: (query) =>
      query.state.data?.state === 'offline' ? false : RUNNER_HEARTBEAT_POLL_MS,
  })

  useEffect(() => {
    const name = runnerQuery.data?.name
    document.title = name ? `${name} | almyty` : 'Runner | almyty'
    return () => { document.title = 'almyty' }
  }, [runnerQuery.data])

  const runnerOffline = runnerQuery.data?.state === 'offline'
  const workspacesQuery = useQuery<Workspace[]>({
    queryKey: ['workspaces', { runnerId: id }],
    queryFn: () => workspacesApi.getAll(),
    enabled: !!id,
    // An offline runner cannot take new work, and every workspace
    // pinned to it has already been stranded, so there is nothing
    // left for this poll to find.
    refetchInterval: runnerOffline ? false : RUNNER_HEARTBEAT_POLL_MS,
    select: (all) => all.filter(w => w.runnerId === id),
  })

  const { currentOrganization } = useOrganizationStore()
  const capabilitiesQuery = useQuery<Tool[]>({
    queryKey: ['runner-tools', id],
    queryFn: () => toolsApi.getAll(currentOrganization?.id, { limit: 200 }),
    enabled: !!id && !!currentOrganization,
    select: (all: any) => {
      const list = Array.isArray(all) ? all : (all?.data ?? [])
      return list.filter((t: any) => t.runnerConfig?.runnerId === id) as Tool[]
    },
  })

  const unregisterMutation = useMutation({
    mutationFn: () => runnersApi.unregister(id),
    onSuccess: () => {
      success('Runner deleted')
      queryClient.invalidateQueries({ queryKey: ['runners'] })
      navigate('/runners')
    },
    onError: (err: any) => errNotif('Delete failed', getApiErrorMessage(err)),
  })

  // Visibility is edited in place on this page (no dialog). The draft is
  // null until the owner picks something different.
  const { user } = useAuthStore()
  const { byId: teamLookup } = useTeamLookup(currentOrganization?.id)
  const [visibilityDraft, setVisibilityDraft] = useState<VisibilityValue | null>(null)
  const visibilityMutation = useMutation({
    mutationFn: (next: VisibilityValue) =>
      runnersApi.update(id, { visibility: next.visibility, teamId: next.visibility === 'team' ? next.teamId : null }),
    onSuccess: () => {
      success('Visibility saved')
      setVisibilityDraft(null)
      queryClient.invalidateQueries({ queryKey: ['runner', id] })
      queryClient.invalidateQueries({ queryKey: ['runners'] })
    },
    onError: (err: any) => errNotif('Could not save visibility', getApiErrorMessage(err)),
  })
  const isOwner = !!user?.id && runnerQuery.data?.ownerUserId === user.id

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

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <Cpu className="h-7 w-7 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <h1 className={DETAIL_TITLE_CLASSES}>{runner.name}</h1>
            <div className="flex flex-wrap items-center gap-2 mt-1">
              <Badge variant={isPendingRunner(runner) ? 'outline' : runnerStateVariant[runner.state]}>
                {runnerStateLabel(runner)}
              </Badge>
              <VisibilityBadge visibility={runner.visibility} teamId={runner.teamId} teamLookup={teamLookup} />
              <span className="text-sm text-muted-foreground" title={runner.lastHeartbeatAt ?? ''}>
                {runner.lastHeartbeatAt
                  ? `Last heartbeat ${formatRelativeTime(runner.lastHeartbeatAt)}`
                  : 'No heartbeat yet'}
              </span>
            </div>
          </div>
        </div>
        {/* An offline runner, or one whose daemon never connected, can go. */}
        {(runner.state === 'offline' || isPendingRunner(runner)) && (
          <Button
            variant="destructive"
            disabled={unregisterMutation.isPending}
            onClick={async () => {
              const ok = await confirm({
                title: <>Delete runner {runner.name}?</>,
                confirmLabel: 'Delete runner',
                cancelLabel: 'Keep it',
                destructive: true,
              })
              if (ok) unregisterMutation.mutate()
            }}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Delete runner
          </Button>
        )}
      </div>

      {isPendingRunner(runner) && (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            This runner has never connected. Start it on its machine with{' '}
            <code className="text-foreground">{runnerStartCommand(runner.name, currentOrganization?.id)}</code>
            {' '}after <code className="text-foreground">{RUNNER_INSTALL_COMMAND}</code> and{' '}
            <code className="text-foreground">{RUNNER_LOGIN_COMMAND}</code>, or delete it.
          </CardContent>
        </Card>
      )}

      {isOwner && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Who can see and use it</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <VisibilityField
              organizationId={currentOrganization?.id ?? ''}
              value={visibilityDraft ?? { visibility: runner.visibility ?? 'org', teamId: runner.teamId ?? null }}
              onChange={setVisibilityDraft}
              noun="this runner"
              disabled={visibilityMutation.isPending}
            />
            {visibilityDraft && (
              <div className="flex flex-col-reverse gap-2 sm:flex-row">
                <Button onClick={() => visibilityMutation.mutate(visibilityDraft)} disabled={visibilityMutation.isPending}>
                  Save visibility
                </Button>
                <Button variant="ghost" onClick={() => setVisibilityDraft(null)} disabled={visibilityMutation.isPending}>
                  Discard
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

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
                No labels set. Labels are descriptive tags configured on the runner side via{' '}
                <code>--label k=v</code> or in <code>~/.almyty/config.json</code>. They do not
                affect where work is dispatched yet — routing by label ships with the
                multi-runner scheduler.
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
          <CardTitle className="text-base flex items-center gap-2">
            Coding agents
            {(runner.runtimeInfo?.codingAgents?.length ?? 0) > 0 && (
              <Badge variant="outline" className="ml-1">{runner.runtimeInfo!.codingAgents!.length}</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <CodingAgentsGrid agents={runner.runtimeInfo?.codingAgents ?? []} />
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

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Wrench className="h-4 w-4" />
            Published capabilities
            {capabilitiesQuery.data && capabilitiesQuery.data.length > 0 && (
              <Badge variant="outline" className="ml-1">{capabilitiesQuery.data.length}</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {capabilitiesQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : capabilitiesQuery.data && capabilitiesQuery.data.length > 0 ? (
            <div className="space-y-2">
              {capabilitiesQuery.data.map((tool) => (
                <Link
                  key={tool.id}
                  to={`/tools/${tool.id}`}
                  className="flex items-center justify-between border rounded-md px-3 py-2 hover:bg-muted/50 transition-colors"
                >
                  <div>
                    <code className="text-sm font-mono font-medium">{tool.runnerConfig?.method}</code>
                    <p className="text-xs text-muted-foreground mt-0.5">{tool.description ?? tool.name}</p>
                  </div>
                  <Badge variant={tool.runnerConfig?.requiresWorkspace ? 'default' : 'outline'} className="text-xs">
                    {tool.runnerConfig?.requiresWorkspace ? 'workspace' : 'global'}
                  </Badge>
                </Link>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No capabilities published yet. Capabilities are minted automatically when the runner registers.
            </p>
          )}
        </CardContent>
      </Card>

      {confirmDialog}
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

function CodingAgentsGrid({ agents }: { agents: CodingAgent[] }) {
  if (agents.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No coding agents detected on this host. Install a CLI (claude, codex, gemini, cursor, …) and it
        appears here on the next heartbeat.
      </p>
    )
  }
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 text-sm">
      {agents.map((a) => (
        <div key={a.id} className="flex flex-col gap-1 border rounded px-3 py-2">
          <div className="flex items-center justify-between">
            <span className="font-medium">{a.displayName}</span>
            <span className="text-muted-foreground">{a.version}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{a.providerFamily}</Badge>
            {a.supportsMcp && <Badge variant="outline" className="text-[10px] px-1.5 py-0">MCP</Badge>}
            {a.canManage && <Badge variant="outline" className="text-[10px] px-1.5 py-0">manager</Badge>}
          </div>
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
