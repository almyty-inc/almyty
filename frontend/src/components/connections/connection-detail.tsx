/**
 * One connection (/connections/:id), laid out like a provider on Models:
 * its logo, name and whether it works; "Check again"; the account, the key
 * (never shown, replaceable in place) and who can use it; what uses it; and
 * Disconnect at the bottom behind a one-line confirm.
 */
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { DETAIL_TITLE_CLASSES } from '@/components/layout/page-header'
import { ServiceIcon } from '@/components/connect/service-tiles'
import { StatusLabel } from '@/components/connect/status-label'
import { WhoCanUse } from '@/components/connect/who-can-use'
import { useOrganizationRole } from '@/hooks/use-organization-role'
import { connectionsApi, errorMessage } from '@/lib/connections-api'
import { cn } from '@/lib/utils'
import { useNotifications } from '@/store/app'
import type { Connection, Connector } from '@/types/connections'
import { ConnectServiceForm, connectorIcon, useConnectors } from './connect-flow'
import { connectionCheck, connectionWho } from './connection-status'
import { CONNECTIONS_PATH, CONNECTIONS_QUERY_KEY, connectionAccessPath } from './paths'

type CheckOutcome = { ok: boolean; message: string }

export function useConnections() {
  return useQuery({
    queryKey: CONNECTIONS_QUERY_KEY,
    queryFn: async () => {
      const rows = await connectionsApi.list()
      return Array.isArray(rows) ? rows : []
    },
  })
}

export interface ConnectionDetailProps {
  connection: Connection
  connector?: Connector | null
  /** Where Disconnect lands. */
  onDisconnected: () => void
}

export function ConnectionDetail({ connection, connector, onDisconnected }: ConnectionDetailProps) {
  const queryClient = useQueryClient()
  const notifications = useNotifications()
  const { confirm, dialog: confirmDialog } = useConfirm()
  const { canManage } = useOrganizationRole()
  const [replacing, setReplacing] = useState(false)
  const [outcome, setOutcome] = useState<CheckOutcome | null>(null)

  const invalidate = () => queryClient.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY })

  const check = useMutation({
    mutationFn: () => connectionsApi.validate(connection.id),
    onSuccess: (result) => {
      invalidate()
      const next = connectionCheck(result ?? connection, connector)
      setOutcome({ ok: next.state === 'ok', message: next.state === 'ok' ? `${next.label}.` : next.error || `${connection.name} needs attention.` })
    },
    onError: (error: unknown) => setOutcome({ ok: false, message: errorMessage(error, 'The check did not finish.') }),
  })

  const disconnect = useMutation({
    mutationFn: () => connectionsApi.remove(connection.id),
    onSuccess: (result) => {
      invalidate()
      notifications.success('Disconnected', result?.revokeError ? `${connection.name} is gone here. Revoke the key at the service as well.` : `${connection.name} is gone.`)
      onDisconnected()
    },
    onError: (error: unknown) => notifications.error('Could not disconnect', errorMessage(error, 'The connection was not removed.')),
  })

  const status = connectionCheck(connection, connector)
  const usedBy = connection.usedBy ?? []

  return (
    <div className="space-y-6" data-testid="connection-detail">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <ServiceIcon size="lg">{connectorIcon(connector ?? { key: connection.connectorKey, kind: connection.kind ?? 'tool_source' })}</ServiceIcon>
          <div className="min-w-0 space-y-1">
            <h1 className={cn(DETAIL_TITLE_CLASSES, 'truncate')}>{connection.name}</h1>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <span>{connector?.displayName ?? connection.connectorDisplayName ?? connection.connectorKey}</span>
              <StatusLabel check={status} testId="connection-status" />
            </div>
          </div>
        </div>
        <Button variant="outline" onClick={() => check.mutate()} disabled={check.isPending} className="gap-2">
          <RefreshCw className={cn('h-4 w-4', check.isPending && 'animate-spin')} aria-hidden />
          {check.isPending ? 'Checking...' : 'Check again'}
        </Button>
      </header>

      {status.error && !outcome && (
        <p className="break-words rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" data-testid="connection-last-error">
          {status.error}
        </p>
      )}
      {outcome && (
        <p
          role="status"
          data-testid="connection-check-result"
          className={cn(
            'break-words rounded-md border p-3 text-sm',
            outcome.ok ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200' : 'border-destructive/30 bg-destructive/5 text-destructive',
          )}
        >
          {outcome.message}
        </p>
      )}

      <Card>
        <CardContent className="space-y-5 pt-6">
          {connection.accountLabel && (
            <p className="text-sm">
              <span className="text-muted-foreground">Account:</span> {connection.accountLabel}
            </p>
          )}
          <div className="space-y-2">
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="text-muted-foreground">Key:</span>
              <span>Stored encrypted. It is never shown again.</span>
              {!replacing && connector && (
                <button type="button" className="text-primary hover:underline" onClick={() => setReplacing(true)}>
                  Replace key
                </button>
              )}
            </p>
            {replacing && connector && (
              <div className="rounded-lg border p-3">
                <ConnectServiceForm
                  connector={connector}
                  rotateConnection={connection}
                  onCancel={() => setReplacing(false)}
                  onConnected={(rotated) => {
                    setReplacing(false)
                    invalidate()
                    const next = connectionCheck(rotated, connector)
                    setOutcome({ ok: next.state === 'ok', message: next.state === 'ok' ? `New key saved. ${next.label}.` : next.error || 'New key saved.' })
                  }}
                />
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <WhoCanUse value={{ visibility: connectionWho(connection), teamId: null }} onChange={() => {}} options={[connectionWho(connection)]} />
            {canManage && connection.owner === 'org' && (
              <Link to={connectionAccessPath(connection.id)} className="text-sm text-primary hover:underline">
                Change
              </Link>
            )}
          </div>
        </CardContent>
      </Card>

      <section aria-labelledby="used-by-heading" className="space-y-2">
        <h2 id="used-by-heading" className="text-lg font-semibold">
          Used by
        </h2>
        {usedBy.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing uses it yet.</p>
        ) : (
          <ul className="space-y-1" data-testid="used-by-list">
            {usedBy.map((u) => (
              <li key={`${u.type}:${u.id}`} className="text-sm">
                {u.name} <span className="text-muted-foreground">({u.type})</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="border-t pt-6">
        <Button
          variant="ghost"
          className="text-destructive hover:text-destructive"
          disabled={disconnect.isPending}
          onClick={async () => {
            const ok = await confirm({
              title: `Disconnect ${connection.name}?`,
              description:
                usedBy.length > 0
                  ? `${usedBy.length} thing${usedBy.length === 1 ? '' : 's'} still use${usedBy.length === 1 ? 's' : ''} it and will stop working. The key is deleted.`
                  : 'The key is deleted.',
              confirmLabel: 'Disconnect',
              destructive: true,
            })
            if (ok) disconnect.mutate()
          }}
        >
          Disconnect
        </Button>
      </section>
      {confirmDialog}
    </div>
  )
}

/** /connections/:id */
export function ConnectionDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  // The list is what every other surface reads and invalidates, so the page
  // reads the same query rather than a second per-id cache.
  const connectionsQuery = useConnections()
  const connectorsQuery = useConnectors()

  const connection = (connectionsQuery.data ?? []).find((c) => c.id === id) ?? null
  const connector = connection ? (connectorsQuery.data ?? []).find((c) => c.key === connection.connectorKey) ?? null : null

  useEffect(() => {
    document.title = connection ? `${connection.name} | Connections | almyty` : 'Connection | almyty'
    return () => {
      document.title = 'almyty'
    }
  }, [connection?.name])

  const back = (
    <Link to={CONNECTIONS_PATH} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
      Connections
    </Link>
  )

  if (connectionsQuery.isError) {
    return (
      <div className="space-y-4">
        {back}
        <QueryError error={connectionsQuery.error} onRetry={() => connectionsQuery.refetch()} title="Couldn't load this connection" />
      </div>
    )
  }
  if (connectionsQuery.isLoading) {
    return (
      <div className="flex h-96 items-center justify-center" aria-busy="true">
        <LoadingSpinner size="lg" />
      </div>
    )
  }
  if (!connection) {
    return (
      <div className="space-y-4">
        {back}
        <p className="text-muted-foreground">This connection is gone. It may have been disconnected.</p>
      </div>
    )
  }
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {back}
      <ConnectionDetail connection={connection} connector={connector} onDisconnected={() => navigate(CONNECTIONS_PATH)} />
    </div>
  )
}
