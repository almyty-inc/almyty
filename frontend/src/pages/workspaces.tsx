import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Cpu, Layers, Search } from 'lucide-react'

import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { EmptyState } from '@/components/ui/empty-state'
import { QueryError } from '@/components/ui/query-error'
import { runnersApi, workspacesApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'
import { workspaceStatusVariant, RUNNER_HEARTBEAT_POLL_MS } from './runners-shared'
import { formatRelativeTime } from '@/lib/utils'

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
interface Runner { id: string; name: string }

const STATUSES: Workspace['status'][] = ['active', 'released', 'expired', 'stranded']

export function WorkspacesPage() {
  const { currentOrganization } = useOrganizationStore()
  const navigate = useNavigate()
  const [statusFilter, setStatusFilter] = useState<Set<Workspace['status']>>(new Set(['active']))
  const [runnerFilter, setRunnerFilter] = useState<string>('')

  useEffect(() => {
    document.title = 'Workspaces | almyty'
    return () => { document.title = 'almyty' }
  }, [])
  const [search, setSearch] = useState('')

  const wsQuery = useQuery<Workspace[]>({
    queryKey: ['workspaces', currentOrganization?.id],
    queryFn: () => workspacesApi.getAll(),
    enabled: !!currentOrganization,
    refetchInterval: RUNNER_HEARTBEAT_POLL_MS,
  })

  const runnersQuery = useQuery<Runner[]>({
    queryKey: ['runners', currentOrganization?.id],
    queryFn: () => runnersApi.getAll(),
    enabled: !!currentOrganization,
  })

  const runnerNameById = useMemo(() => {
    const m: Record<string, string> = {}
    for (const r of runnersQuery.data ?? []) m[r.id] = r.name
    return m
  }, [runnersQuery.data])

  const filtered = useMemo(() => {
    const all = wsQuery.data ?? []
    return all.filter(w => {
      if (!statusFilter.has(w.status)) return false
      if (runnerFilter && w.runnerId !== runnerFilter) return false
      if (search && !w.cwd.toLowerCase().includes(search.toLowerCase())) return false
      return true
    })
  }, [wsQuery.data, statusFilter, runnerFilter, search])

  const toggleStatus = (s: Workspace['status']) => {
    setStatusFilter(prev => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return next
    })
  }

  if (wsQuery.isError) {
    return (
      <div className="space-y-6">
        <Header />
        <QueryError error={wsQuery.error as Error} onRetry={wsQuery.refetch} title="Couldn't load workspaces" />
      </div>
    )
  }

  if (!wsQuery.isLoading && (wsQuery.data ?? []).length === 0) {
    return (
      <div className="space-y-6">
        <Header />
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              icon={Layers}
              title="No workspaces yet"
              description="A workspace is a (runner, cwd) reservation with a TTL. Workspaces are created by agents when they need to run jobs in a specific directory; you don't create them by hand."
              action={
                <Button onClick={() => navigate('/runners')}>
                  <Cpu className="mr-2 h-4 w-4" />
                  Manage runners
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
      <Header />
      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[200px] max-w-sm">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Filter by cwd"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pl-8"
              />
            </div>
            <select
              value={runnerFilter}
              onChange={e => setRunnerFilter(e.target.value)}
              className="border rounded h-9 px-2 text-sm bg-background"
            >
              <option value="">All runners</option>
              {(runnersQuery.data ?? []).map(r => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
            <div className="flex items-center gap-1">
              {STATUSES.map(s => (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggleStatus(s)}
                  className={`text-xs px-2 py-1 rounded border ${statusFilter.has(s) ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground'}`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {wsQuery.isLoading ? (
            <div className="py-12 flex justify-center"><LoadingSpinner size="lg" /></div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="pb-2 pr-4 font-medium">Id</th>
                    <th className="pb-2 pr-4 font-medium">Runner</th>
                    <th className="pb-2 pr-4 font-medium">cwd</th>
                    <th className="pb-2 pr-4 font-medium">Isolation</th>
                    <th className="pb-2 pr-4 font-medium">Status</th>
                    <th className="pb-2 pr-4 font-medium">TTL / closed</th>
                    <th className="pb-2 font-medium">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(w => (
                    <tr
                      key={w.id}
                      className="border-b last:border-b-0 cursor-pointer hover:bg-muted/40 transition-colors"
                      onClick={() => navigate(`/workspaces/${w.id}`)}
                    >
                      <td className="py-2 pr-4 font-mono text-xs">{w.id.slice(0, 8)}…</td>
                      <td className="py-2 pr-4">
                        <Link
                          to={`/runners/${w.runnerId}`}
                          className="hover:underline"
                          onClick={e => e.stopPropagation()}
                        >
                          {runnerNameById[w.runnerId] ?? w.runnerId.slice(0, 8) + '…'}
                        </Link>
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">{w.cwd}</td>
                      <td className="py-2 pr-4">
                        <Badge variant="outline" className="font-normal">{w.isolation}</Badge>
                      </td>
                      <td className="py-2 pr-4">
                        <Badge variant={workspaceStatusVariant[w.status]}>{w.status}</Badge>
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {w.status === 'active'
                          ? (w.ttlAt ? `expires ${formatRelativeTime(w.ttlAt)}` : 'no TTL')
                          : (w.closeReason?.kind ?? '—')}
                      </td>
                      <td className="py-2 text-muted-foreground" title={w.createdAt}>
                        {formatRelativeTime(w.createdAt)}
                      </td>
                    </tr>
                  ))}
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={7} className="py-12 text-center text-sm text-muted-foreground">
                        No workspaces match the current filter.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function Header() {
  return (
    <div>
      <h1 className="text-2xl font-bold">Workspaces</h1>
      <p className="text-sm text-muted-foreground mt-1">
        (runner, cwd) reservations with a TTL. Created by your agents; surfaced here for audit and recovery.
      </p>
    </div>
  )
}
