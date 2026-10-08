/**
 * Memory accounts: almyty's own memory, and every account of a memory
 * service (Mem0, Zep, Supermemory and the rest), several per service,
 * each a named credential. The Memory page lists them with their health,
 * the move page moves memories between them, and wherever an account is
 * picked one can be added in place (AddMemoryAccountFlow).
 */
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { ArrowRightLeft, Plus, RefreshCw } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DataTable } from '@/components/ui/data-table'
import { ServiceIcon } from '@/components/connect/service-tiles'
import { connectorIcon, useConnectors } from '@/components/connections/connect-flow'
import { CredentialForm } from '@/components/credentials/credential-form'
import { StatusLabel } from '@/components/connect/status-label'
import { connectionCheck } from '@/components/connections/connection-status'
import { CONNECTIONS_QUERY_KEY, credentialPath } from '@/components/credentials/paths'
import { connectionsApi } from '@/lib/connections-api'
import { memoriesApi, type MemoryAccountRow, type MemoryAccountsOverview, type MemoryMove } from '@/lib/api'
import { formatRelativeTime, pluralized } from '@/lib/utils'
import { useNotifications } from '@/store/app'
import type { Connection } from '@/types/connections'

export const NATIVE_ACCOUNT_ID = 'almyty-native'
export const MEMORY_ACCOUNTS_QUERY_KEY = ['memories', 'accounts', 'overview'] as const
export const MEMORY_MOVES_QUERY_KEY = ['memories', 'moves'] as const

export const MEMORY_ACCOUNTS_PATH = '/memories?tab=accounts'
export function addMemoryAccountPath(service?: string | null): string {
  return `/memories/accounts/new${service ? `?service=${encodeURIComponent(service)}` : ''}`
}
export function moveMemoriesPath(from?: string | null): string {
  return `/memories/move${from ? `?from=${encodeURIComponent(from)}` : ''}`
}
export function memoryMovePath(id: string): string {
  return `/memories/moves/${encodeURIComponent(id)}`
}

export function useMemoryAccountsOverview() {
  return useQuery<MemoryAccountsOverview>({
    queryKey: MEMORY_ACCOUNTS_QUERY_KEY,
    queryFn: async () => {
      const data = await memoriesApi.accountsOverview()
      return { accounts: data?.accounts ?? [], services: data?.services ?? [] }
    },
  })
}

/** An account's name as a person reads it, with its service when that is not already in the name. */
export function accountLabel(account: Pick<MemoryAccountRow, 'id' | 'name' | 'serviceName'>): string {
  if (account.id === NATIVE_ACCOUNT_ID) return account.name
  return account.name.toLowerCase().includes(account.serviceName.toLowerCase()) ? account.name : `${account.name} (${account.serviceName})`
}

/** The account a move names, from the list; a removed account is named by its service. */
export function moveAccountName(accounts: MemoryAccountRow[], service: string, credentialId: string | null, serviceName = service): string {
  const id = credentialId ?? NATIVE_ACCOUNT_ID
  const found = accounts.find((a) => a.id === id)
  return found ? accountLabel(found) : credentialId ? `${serviceName} (removed account)` : "almyty's own memory"
}

/** Where a move stands, in words. */
export function moveStatusLabel(move: Pick<MemoryMove, 'status' | 'moved' | 'failed' | 'total'>): string {
  const of = move.total ? ` of ${move.total}` : ''
  switch (move.status) {
    case 'queued':
      return 'Waiting to start'
    case 'running':
      return `Moving: ${move.moved}${of} done`
    case 'failed':
      return `Stopped after ${pluralized(move.moved, 'memory', 'memories')}`
    default:
      return move.failed > 0 ? `${pluralized(move.moved, 'memory', 'memories')} moved, ${move.failed} not` : `${pluralized(move.moved, 'memory', 'memories')} moved`
  }
}

export function moveStatusVariant(move: Pick<MemoryMove, 'status' | 'failed'>): 'success' | 'warning' | 'destructive' | 'outline' | 'secondary' {
  if (move.status === 'failed') return 'destructive'
  if (move.status === 'completed') return move.failed > 0 ? 'warning' : 'success'
  return 'secondary'
}

/** A row of the accounts table: an account, or a service nobody has an account for yet. */
type AccountTableRow =
  | { kind: 'account'; key: string; account: MemoryAccountRow }
  | { kind: 'service'; key: string; service: { id: string; name: string } }

/**
 * Every memory account with its health, and every memory service with no
 * account yet ("Not set up", with Add account). Health is the account's
 * last check; "Check" runs it again.
 */
export function MemoryAccountsTable({ overview, loading }: { overview: MemoryAccountsOverview | undefined; loading?: boolean }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const notify = useNotifications()
  const connectors = useConnectors()
  const [checking, setChecking] = useState<string | null>(null)
  const check = useMutation({
    mutationFn: (id: string) => connectionsApi.validate(id),
    onMutate: (id) => setChecking(id),
    onSettled: () => {
      setChecking(null)
      qc.invalidateQueries({ queryKey: MEMORY_ACCOUNTS_QUERY_KEY })
      qc.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY })
    },
    onError: (err: any) => notify.error('Check failed', err?.message ?? String(err)),
  })

  const rows: AccountTableRow[] = useMemo(() => {
    const out: AccountTableRow[] = (overview?.accounts ?? []).map((a) => ({ kind: 'account' as const, key: a.id, account: a }))
    for (const s of overview?.services ?? []) if (s.accounts === 0) out.push({ kind: 'service', key: `service:${s.id}`, service: s })
    return out
  }, [overview])

  const iconFor = (service: string) => {
    const connector = (connectors.data ?? []).find((c) => c.key === service)
    return connector ? connectorIcon(connector) : connectorIcon({ key: service, kind: 'memory', providerType: undefined } as any)
  }

  const columns = useMemo<ColumnDef<AccountTableRow>[]>(
    () => [
      {
        id: 'name',
        header: 'Account',
        cell: ({ row }) => {
          const r = row.original
          if (r.kind === 'service') return <span className="text-sm text-muted-foreground">No account yet</span>
          return (
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{r.account.name}</span>
                {r.account.isDefault && <Badge variant="secondary">Default</Badge>}
              </div>
              {r.account.accountLabel && <div className="text-xs text-muted-foreground">{r.account.accountLabel}</div>}
            </div>
          )
        },
      },
      {
        id: 'service',
        header: 'Service',
        cell: ({ row }) => {
          const r = row.original
          const id = r.kind === 'account' ? r.account.service : r.service.id
          const name = r.kind === 'account' ? r.account.serviceName : r.service.name
          return (
            <span className="flex items-center gap-2 text-sm">
              <ServiceIcon>{iconFor(id)}</ServiceIcon>
              {name}
            </span>
          )
        },
      },
      {
        id: 'health',
        header: 'Health',
        cell: ({ row }) => {
          const r = row.original
          if (r.kind === 'service') {
            return (
              <Badge variant="outline" data-testid="memory-service-not-set-up">
                Not set up
              </Badge>
            )
          }
          const h = r.account.health
          // The Credentials table's own words and look ("Works", "Needs attention", "Not checked yet").
          const connector = (connectors.data ?? []).find((c) => c.key === r.account.service)
          return (
            <div className="space-y-1">
              <StatusLabel check={connectionCheck({ health: h as any }, connector)} testId="credential-status" />
              {h.error && <p className="max-w-sm text-xs text-muted-foreground" data-testid="memory-account-error">{h.error}</p>}
              {!h.error && h.checkedAt && r.account.id !== NATIVE_ACCOUNT_ID && (
                <p className="text-xs text-muted-foreground">Checked {formatRelativeTime(h.checkedAt)}</p>
              )}
            </div>
          )
        },
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => {
          const r = row.original
          if (r.kind === 'service') {
            return (
              <div className="flex justify-end">
                <Button asChild size="sm" variant="outline" onClick={(e) => e.stopPropagation()}>
                  <Link to={addMemoryAccountPath(r.service.id)}>
                    <Plus className="mr-1 h-3.5 w-3.5" /> Add account
                  </Link>
                </Button>
              </div>
            )
          }
          const a = r.account
          return (
            <div className="flex justify-end gap-2" onClick={(e) => e.stopPropagation()}>
              {a.id !== NATIVE_ACCOUNT_ID && (
                <Button size="sm" variant="ghost" disabled={checking === a.id} onClick={() => check.mutate(a.id)} aria-label={`Check ${a.name}`}>
                  <RefreshCw className={`mr-1 h-3.5 w-3.5 ${checking === a.id ? 'animate-spin' : ''}`} /> Check
                </Button>
              )}
              {a.canMoveFrom && (
                <Button asChild size="sm" variant="ghost">
                  <Link to={moveMemoriesPath(a.id)} aria-label={`Move memories from ${a.name}`}>
                    <ArrowRightLeft className="mr-1 h-3.5 w-3.5" /> Move memories
                  </Link>
                </Button>
              )}
            </div>
          )
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [checking, connectors.data],
  )

  return (
    <DataTable
      columns={columns}
      data={rows}
      loading={loading}
      hideSelectionCount
      hideColumnsButton
      hidePaginationWhenSinglePage
      onRowClick={(r) => {
        if (r.kind === 'account' && r.account.id !== NATIVE_ACCOUNT_ID) navigate(credentialPath(r.account.id))
      }}
    />
  )
}

/** Recent moves, newest first; a row opens the move's own page. */
export function MemoryMovesTable({ moves, accounts, loading }: { moves: MemoryMove[]; accounts: MemoryAccountRow[]; loading?: boolean }) {
  const navigate = useNavigate()
  const columns = useMemo<ColumnDef<MemoryMove>[]>(
    () => [
      { id: 'from', header: 'From', cell: ({ row }) => <span className="text-sm">{moveAccountName(accounts, row.original.sourceService, row.original.sourceCredentialId)}</span> },
      { id: 'to', header: 'To', cell: ({ row }) => <span className="text-sm">{moveAccountName(accounts, row.original.targetService, row.original.targetCredentialId)}</span> },
      { id: 'what', header: 'Whose memories', cell: ({ row }) => <span className="text-sm text-muted-foreground">{whoseLabel(row.original)}</span> },
      {
        id: 'status',
        header: 'Result',
        cell: ({ row }) => <Badge variant={moveStatusVariant(row.original)}>{moveStatusLabel(row.original)}</Badge>,
      },
      { id: 'started', header: 'Started', cell: ({ row }) => <span className="text-sm text-muted-foreground">{formatRelativeTime(row.original.createdAt)}</span> },
    ],
    [accounts],
  )
  return (
    <DataTable
      columns={columns}
      data={moves}
      loading={loading}
      hideSelectionCount
      hideColumnsButton
      hidePaginationWhenSinglePage
      onRowClick={(m) => navigate(memoryMovePath(m.id))}
      emptyState={<p className="py-6 text-center text-sm text-muted-foreground">No memories have been moved yet.</p>}
    />
  )
}

/** Whose memories a move covers, in words. */
export function whoseLabel(move: Pick<MemoryMove, 'scopeType' | 'mode'>): string {
  const whose = move.scopeType === 'agent' ? "An agent's own" : move.scopeType === 'user' ? 'Your own' : "The organization's"
  return `${whose} ${move.mode === 'document' ? 'documents' : 'memories'}`
}

/** Add an account using the shared credential form, limited to memory services. */
export function AddMemoryAccountFlow({
  services,
  service,
  onPickService,
  onConnected,
  onCancel,
  embedded = false,
}: {
  /** The memory services almyty has an adapter for (MemoryAccountsOverview.services). */
  services: Array<{ id: string }>
  service: string | null
  onPickService: (service: string | null) => void
  onConnected: (connection: Connection) => void
  onCancel?: () => void
  embedded?: boolean
}) {
  const qc = useQueryClient()
  return (
    <CredentialForm
      kind="memory"
      withoutModels
      allowedKeys={services.map((s) => s.id)}
      service={service}
      onServiceChange={onPickService}
      embedded={embedded}
      onCancel={embedded ? onCancel : undefined}
      onSaved={(saved) => {
        if (!saved.connection) return
        qc.invalidateQueries({ queryKey: MEMORY_ACCOUNTS_QUERY_KEY })
        qc.invalidateQueries({ queryKey: ['memories', 'accounts'] })
        onConnected(saved.connection)
      }}
    />
  )
}
