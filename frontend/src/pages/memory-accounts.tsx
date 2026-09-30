/* Pages for memory accounts: adding one, moving memories between them,
 * and one move's progress. The pieces live in components/memory/. */
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { FormPage, FormSection } from '@/components/layout/form-page'
import { QueryError } from '@/components/ui/query-error'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { StatusLabel } from '@/components/connect/status-label'
import { connectionCheck } from '@/components/connections/connection-status'
import { credentialPath } from '@/components/credentials/paths'
import { MoveMemoriesForm } from '@/components/memory/move-memories-form'
import {
  AddMemoryAccountFlow,
  MEMORY_ACCOUNTS_PATH,
  MEMORY_ACCOUNTS_QUERY_KEY,
  MEMORY_MOVES_QUERY_KEY,
  moveAccountName,
  moveStatusLabel,
  moveStatusVariant,
  useMemoryAccountsOverview,
  whoseLabel,
} from '@/components/memory/memory-accounts'
import { memoriesApi, type MemoryMove } from '@/lib/api'
import { formatDateTime, pluralized } from '@/lib/utils'
import { useNotifications } from '@/store/app'
import type { Connection } from '@/types/connections'

function useTitle(title: string) {
  useEffect(() => {
    document.title = `${title} | almyty`
    return () => {
      document.title = 'almyty'
    }
  }, [title])
}

/**
 * /memories/accounts/new: pick a memory service's tile, give it its key.
 * `?service=mem0` opens straight onto that service (the accounts table's
 * "Add account" on a service with none).
 */
export function MemoryAccountNewPage() {
  useTitle('Add memory account')
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const overview = useMemoryAccountsOverview()
  const [connected, setConnected] = useState<Connection | null>(null)
  const service = params.get('service')

  const pick = (next: string | null) => {
    const p = new URLSearchParams(params)
    if (next) p.set('service', next)
    else p.delete('service')
    setParams(p)
  }

  return (
    <FormPage
      title="Add memory account"
      description="An account at a memory service, such as Mem0 or Zep. Add as many as you need, one per key; agents keep their memories in the one you pick for them."
      back={{ to: MEMORY_ACCOUNTS_PATH, label: 'Memory' }}
      width="wide"
    >
      {overview.isError && <QueryError error={overview.error} onRetry={() => overview.refetch()} title="Couldn't load the memory services" />}
      {connected ? (
        <div className="space-y-4" data-testid="memory-account-added">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />
            {connected.name} is added.
            <StatusLabel check={connectionCheck(connected)} testId="connection-status" />
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => navigate(MEMORY_ACCOUNTS_PATH)}>Done</Button>
            <Button variant="outline" onClick={() => navigate(credentialPath(connected.id))}>
              Open account
            </Button>
          </div>
        </div>
      ) : (
        overview.data && (
          <AddMemoryAccountFlow services={overview.data.services} service={service} onPickService={pick} onConnected={setConnected} />
        )
      )}
    </FormPage>
  )
}

/** /memories/move */
export function MemoryMovePage() {
  useTitle('Move memories')
  return <MoveMemoriesForm />
}

/** A move still under way is asked about every two seconds. */
const POLL_MS = 2000
const STALE_MS = 5 * 60 * 1000

/**
 * /memories/moves/:id: where a move stands, what it did, and Resume when
 * it stopped part way or left memories behind.
 */
export function MemoryMoveDetailPage() {
  useTitle('Memory move')
  const { id = '' } = useParams()
  const qc = useQueryClient()
  const notify = useNotifications()
  const overview = useMemoryAccountsOverview()
  const moveQ = useQuery<MemoryMove>({
    queryKey: [...MEMORY_MOVES_QUERY_KEY, id],
    queryFn: () => memoriesApi.getMove(id),
    refetchInterval: (q) => {
      const s = (q.state.data as MemoryMove | undefined)?.status
      return s === 'queued' || s === 'running' ? POLL_MS : false
    },
  })
  const resume = useMutation({
    mutationFn: () => memoriesApi.resumeMove(id),
    onSuccess: (move) => {
      qc.setQueryData([...MEMORY_MOVES_QUERY_KEY, id], move)
      qc.invalidateQueries({ queryKey: MEMORY_MOVES_QUERY_KEY })
    },
    onError: (err: any) => notify.error('Could not resume', err?.message ?? String(err)),
  })
  const move = moveQ.data
  const accounts = overview.data?.accounts ?? []

  useEffect(() => {
    if (move?.status === 'completed' || move?.status === 'failed') qc.invalidateQueries({ queryKey: MEMORY_ACCOUNTS_QUERY_KEY })
  }, [move?.status, qc])

  const stale = move?.status === 'running' && Date.now() - new Date(move.updatedAt).getTime() > STALE_MS
  const resumable = !!move && (move.status === 'failed' || (move.status === 'completed' && move.failed > 0) || stale)
  const pct = move?.total ? Math.min(100, Math.round((move.moved / move.total) * 100)) : null

  return (
    <FormPage
      title="Memory move"
      description={move ? `${whoseLabel(move)}, started ${formatDateTime(move.createdAt)}` : undefined}
      back={{ to: MEMORY_ACCOUNTS_PATH, label: 'Memory' }}
      width="narrow"
      actions={
        resumable ? (
          <Button onClick={() => resume.mutate()} disabled={resume.isPending}>
            {move?.status === 'completed' ? 'Try the rest again' : 'Resume'}
          </Button>
        ) : undefined
      }
    >
      {moveQ.isError ? (
        <QueryError error={moveQ.error} onRetry={() => moveQ.refetch()} title="Couldn't load this move" />
      ) : !move ? (
        <LoadingSpinner />
      ) : (
        <>
          <FormSection>
            <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
              <dt className="text-muted-foreground">From</dt>
              <dd data-testid="move-from">{moveAccountName(accounts, move.sourceService, move.sourceCredentialId)}</dd>
              <dt className="text-muted-foreground">To</dt>
              <dd data-testid="move-to">{moveAccountName(accounts, move.targetService, move.targetCredentialId)}</dd>
              <dt className="text-muted-foreground">Result</dt>
              <dd>
                <Badge variant={moveStatusVariant(move)} data-testid="move-status">
                  {stale ? 'Stopped responding' : moveStatusLabel(move)}
                </Badge>
              </dd>
            </dl>
            {(move.status === 'queued' || move.status === 'running') && (
              <div className="space-y-1" data-testid="move-progress">
                <div className="h-2 w-full overflow-hidden rounded bg-muted">
                  <div className="h-full bg-primary transition-all" style={{ width: `${pct ?? 5}%` }} />
                </div>
                <p className="text-xs text-muted-foreground">
                  {pluralized(move.moved, 'memory', 'memories')} moved{move.total ? ` of ${move.total}` : ''}. You can leave this page; the move keeps going.
                </p>
              </div>
            )}
            {move.failed > 0 && move.status !== 'running' && (
              <p className="text-sm text-amber-700 dark:text-amber-400" data-testid="move-failed">
                {pluralized(move.failed, 'memory', 'memories')} could not be moved and {move.failed === 1 ? 'is' : 'are'} still where {move.failed === 1 ? 'it was' : 'they were'}. Try them again once the account works.
              </p>
            )}
            {move.lastError && (
              <p role="alert" className="text-sm text-destructive" data-testid="move-error">
                {move.lastError}
              </p>
            )}
          </FormSection>
          {move.warnings.length > 0 && (
            <FormSection title="What the other account does not keep">
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                {move.warnings.map((w, i) => (
                  <li key={i}>
                    {pluralized(w.count, 'memory', 'memories')}: {w.field.replace(/_/g, ' ')}
                  </li>
                ))}
              </ul>
            </FormSection>
          )}
          <p className="text-sm">
            <Link to={MEMORY_ACCOUNTS_PATH} className="text-primary hover:underline">
              Back to memory accounts
            </Link>
          </p>
        </>
      )}
    </FormPage>
  )
}
