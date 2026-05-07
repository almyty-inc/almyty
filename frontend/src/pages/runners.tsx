import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Cpu, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { EmptyState } from '@/components/ui/empty-state'
import { QueryError } from '@/components/ui/query-error'
import { runnersApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'
import { runnerStateVariant, RUNNER_HEARTBEAT_POLL_MS } from './runners-shared'
import { formatRelativeTime } from '@/lib/utils'

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
  config: {
    maxConcurrent: number
  } | null
  lastHeartbeatAt: string | null
  registeredAt: string
}

export function RunnersPage() {
  const navigate = useNavigate()
  const { currentOrganization } = useOrganizationStore()

  const { data: runners = [], isLoading, isError, error, refetch } = useQuery<Runner[]>({
    // Polling cadence is half the runner heartbeat interval so the
    // UI shows transitions within roughly one heartbeat. Streamable
    // HTTP is the long-term home for live updates; until the
    // backend exposes a runner-state subscription on it (open
    // question in the PR description), polling is the conservative
    // choice and matches what other list pages do.
    queryKey: ['runners', currentOrganization?.id],
    queryFn: () => runnersApi.getAll(),
    enabled: !!currentOrganization,
    refetchInterval: RUNNER_HEARTBEAT_POLL_MS,
  })

  if (isError) {
    return (
      <div className="space-y-6">
        <RunnersHeader onCreate={() => navigate('/runners/new')} />
        <QueryError error={error as Error} onRetry={refetch} title="Couldn't load runners" />
      </div>
    )
  }

  if (!isLoading && runners.length === 0) {
    return (
      <div className="space-y-6">
        <RunnersHeader onCreate={() => navigate('/runners/new')} />
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              icon={Cpu}
              title="No runners registered"
              description="A runner is a long-running daemon you start on a machine you own. It accepts jobs from your agents and runs processes locally — Claude Code, Codex, git, npm, anything on PATH."
              action={
                <Button onClick={() => navigate('/runners/new')}>
                  <Plus className="mr-2 h-4 w-4" />
                  Start a runner
                </Button>
              }
            />
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <RunnersHeader onCreate={() => navigate('/runners/new')} />
      <Card>
        <CardContent className="pt-6">
          {isLoading ? (
            <div className="py-12 flex justify-center">
              <LoadingSpinner size="lg" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="pb-2 pr-4 font-medium">Name</th>
                    <th className="pb-2 pr-4 font-medium">State</th>
                    <th className="pb-2 pr-4 font-medium">OS / arch</th>
                    <th className="pb-2 pr-4 font-medium">Last heartbeat</th>
                    <th className="pb-2 pr-4 font-medium">Capacity</th>
                    <th className="pb-2 font-medium">Labels</th>
                  </tr>
                </thead>
                <tbody>
                  {runners.map((r) => (
                    <RunnerRow key={r.id} runner={r} onOpen={() => navigate(`/runners/${r.id}`)} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function RunnersHeader({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex items-start justify-between">
      <div>
        <h1 className="text-2xl font-bold">Runners</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Long-running daemons on machines you own. They execute processes for your agents.
        </p>
      </div>
      <Button onClick={onCreate}>
        <Plus className="mr-2 h-4 w-4" />
        Start a runner
      </Button>
    </div>
  )
}

function RunnerRow({ runner, onOpen }: { runner: Runner; onOpen: () => void }) {
  const inUse = 0 // capacity.inUse not in list payload; backend returns it on detail
  const max = runner.config?.maxConcurrent ?? 0
  const labelEntries = Object.entries(runner.labels ?? {})

  return (
    <tr
      onClick={onOpen}
      className="border-b last:border-b-0 cursor-pointer hover:bg-muted/40 transition-colors"
    >
      <td className="py-3 pr-4 font-medium">{runner.name}</td>
      <td className="py-3 pr-4">
        <Badge variant={runnerStateVariant[runner.state]}>{runner.state}</Badge>
      </td>
      <td className="py-3 pr-4 text-muted-foreground">
        {runner.runtimeInfo
          ? `${runner.runtimeInfo.os} / ${runner.runtimeInfo.arch}`
          : '—'}
      </td>
      <td className="py-3 pr-4 text-muted-foreground" title={runner.lastHeartbeatAt ?? ''}>
        {runner.lastHeartbeatAt ? formatRelativeTime(runner.lastHeartbeatAt) : 'never'}
      </td>
      <td className="py-3 pr-4 text-muted-foreground">
        {max ? `${inUse} / ${max}` : '—'}
      </td>
      <td className="py-3">
        <div className="flex flex-wrap gap-1">
          {labelEntries.length === 0
            ? <span className="text-muted-foreground">—</span>
            : labelEntries.slice(0, 4).map(([k, v]) => (
              <Badge key={k} variant="outline" className="font-normal">
                {k}={v}
              </Badge>
            ))}
          {labelEntries.length > 4 && (
            <span className="text-xs text-muted-foreground">+{labelEntries.length - 4}</span>
          )}
        </div>
      </td>
    </tr>
  )
}
