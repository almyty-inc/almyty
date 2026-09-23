/**
 * One connection, as a page (/settings/connections/:id): health with the
 * last error, validate / rotate / disconnect, what uses it, and the grants
 * editor. Rotate opens the connect flow inline on this page.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { Activity, KeyRound, Loader2, Plug, Unplug } from 'lucide-react'

import { FormPage, FormSection } from '@/components/layout/form-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { connectionsApi, connectorsApi, errorMessage } from '@/lib/connections-api'
import { useNotifications } from '@/store/app'
import { CONNECT_METHOD_LABELS, type Connection, type Connector } from '@/types/connections'
import { ConnectFlow, CONNECTORS_QUERY_KEY } from './connect-sheet'
import { ConnectionHealthBadge } from './health-badge'
import { GrantsEditor } from './grants-editor'

export const CONNECTIONS_QUERY_KEY = ['connections'] as const
export const CONNECTIONS_PATH = '/settings/connections'

function formatDate(iso: string | null | undefined): string {
  if (!iso) return 'Never'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
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
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [rotating, setRotating] = useState(false)

  const invalidate = () => queryClient.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY })

  const validate = useMutation({
    mutationFn: (id: string) => connectionsApi.validate(id),
    onSuccess: (result) => {
      invalidate()
      const status = result?.health?.status
      if (status === 'valid') notifications.success('Connection valid', `${connection.name} answered.`)
      else notifications.error('Validation failed', result?.health?.error || `Health is ${status ?? 'unknown'}.`)
    },
    onError: (error: unknown) => notifications.error('Validation failed', errorMessage(error, 'The account did not answer')),
  })

  const disconnect = useMutation({
    mutationFn: (id: string) => connectionsApi.remove(id),
    onSuccess: () => {
      invalidate()
      setConfirmDisconnect(false)
      notifications.success('Disconnected', `${connection.name} was removed.`)
      onDisconnected()
    },
    onError: (error: unknown) => {
      setConfirmDisconnect(false)
      notifications.error('Could not disconnect', errorMessage(error, 'The connection was not removed'))
    },
  })

  const methodType = connection.method ?? connector?.connect?.[0]?.type ?? null
  const method = methodType ? connector?.connect?.find((m) => m.type === methodType) : undefined
  const usedBy = connection.usedBy ?? []

  return (
    <div className="space-y-6" data-testid="connection-detail">
      <FormSection>
        <div className="flex flex-wrap items-center gap-2">
          <ConnectionHealthBadge health={connection.health} />
          <span className="text-sm text-muted-foreground">
            {connector?.displayName ?? connection.connectorDisplayName ?? connection.connectorKey}
            {connection.accountLabel ? ` as ${connection.accountLabel}` : ''}{' '}
            ({connection.owner === 'org' ? 'organization' : 'personal'})
          </span>
        </div>
        <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
          <dt className="text-muted-foreground">Method</dt>
          <dd>{methodType ? (method?.label || CONNECT_METHOD_LABELS[methodType]) : 'Unknown'}</dd>
          <dt className="text-muted-foreground">Last checked</dt>
          <dd>{formatDate(connection.health?.checkedAt)}</dd>
          <dt className="text-muted-foreground">Connected</dt>
          <dd>{formatDate(connection.createdAt)}</dd>
          <dt className="text-muted-foreground">Expires</dt>
          <dd>{formatDate(connection.expiresAt)}</dd>
        </dl>

        {connection.health?.error && (
          <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm" data-testid="connection-last-error">
            <p className="font-medium text-destructive">Last error</p>
            <p className="mt-0.5 break-words text-muted-foreground">{connection.health.error}</p>
          </div>
        )}

        {connection.scopesGranted && connection.scopesGranted.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Scopes granted</p>
            <div className="flex flex-wrap gap-1">
              {connection.scopesGranted.map((s) => (
                <span key={s} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{s}</span>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => validate.mutate(connection.id)} disabled={validate.isPending}>
            {validate.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Activity className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />}
            Validate
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setRotating(true)} disabled={rotating} aria-expanded={rotating}>
            <KeyRound className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Rotate
          </Button>
          <Button type="button" variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => setConfirmDisconnect(true)}>
            <Unplug className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Disconnect
          </Button>
        </div>

        {rotating && (
          <ConnectFlow
            embedded
            rotateConnection={connection}
            onCancel={() => setRotating(false)}
            onConnected={(rotated) => {
              setRotating(false)
              invalidate()
              notifications.success('Secret rotated', `${rotated.name} is ${rotated.health?.status === 'valid' ? 'valid and ' : ''}ready to use.`)
            }}
          />
        )}
      </FormSection>

      <FormSection title="Used by">
        {usedBy.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing uses this connection yet.</p>
        ) : (
          <ul className="space-y-1" data-testid="used-by-list">
            {usedBy.map((u) => (
              <li key={`${u.type}:${u.id}`} className="flex items-center gap-2 text-sm">
                <Badge variant="outline" className="text-[10px]">{u.type}</Badge>
                <span className="truncate">{u.name}</span>
              </li>
            ))}
          </ul>
        )}
      </FormSection>

      <FormSection>
        <GrantsEditor connectionId={connection.id} />
      </FormSection>

      <AlertDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {connection.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {usedBy.length > 0
                ? `${usedBy.length} thing${usedBy.length === 1 ? '' : 's'} still use${usedBy.length === 1 ? 's' : ''} it and will fail until reconnected. `
                : ''}
              The stored secret is deleted. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => disconnect.mutate(connection.id)} disabled={disconnect.isPending}>
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** /settings/connections/:id */
export function ConnectionDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  // The list is what every other surface reads and invalidates, so the
  // page reads the same query rather than a second per-id cache.
  const connectionsQuery = useQuery({
    queryKey: CONNECTIONS_QUERY_KEY,
    queryFn: async () => {
      const rows = await connectionsApi.list()
      return Array.isArray(rows) ? rows : []
    },
  })
  const connectorsQuery = useQuery({
    queryKey: CONNECTORS_QUERY_KEY,
    queryFn: async () => {
      const rows = await connectorsApi.list()
      return Array.isArray(rows) ? rows : []
    },
  })

  const connection = (connectionsQuery.data ?? []).find((c) => c.id === id) ?? null
  const connector = connection ? (connectorsQuery.data ?? []).find((c) => c.key === connection.connectorKey) ?? null : null
  const back = { to: CONNECTIONS_PATH, label: 'Connections' }

  if (connectionsQuery.isLoading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <LoadingSpinner size="md" />
      </div>
    )
  }
  if (!connection) {
    return (
      <FormPage title="Connection not found" back={back}>
        <EmptyState
          variant="panel"
          icon={Plug}
          title="Connection not found"
          description="It may have been disconnected. Settings > Connections lists the ones that exist."
        />
      </FormPage>
    )
  }
  return (
    <FormPage title={connection.name} back={back}>
      <ConnectionDetail connection={connection} connector={connector} onDisconnected={() => navigate(CONNECTIONS_PATH)} />
    </FormPage>
  )
}
