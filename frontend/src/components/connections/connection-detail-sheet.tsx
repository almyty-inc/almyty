/**
 * One connection: health with the last error, validate / rotate / disconnect,
 * what uses it, and the grants editor.
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Activity, KeyRound, Loader2, Unplug } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
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
import { connectionsApi, errorMessage } from '@/lib/connections-api'
import { useNotifications } from '@/store/app'
import { CONNECT_METHOD_LABELS, type Connection, type Connector } from '@/types/connections'
import { ConnectionHealthBadge } from './health-badge'
import { GrantsEditor } from './grants-editor'

export const CONNECTIONS_QUERY_KEY = ['connections'] as const

export interface ConnectionDetailSheetProps {
  connection: Connection | null
  connector?: Connector | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The parent opens the connect sheet in rotate mode. */
  onRotate: (connection: Connection) => void
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return 'Never'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

export function ConnectionDetailSheet({ connection, connector, open, onOpenChange, onRotate }: ConnectionDetailSheetProps) {
  const queryClient = useQueryClient()
  const notifications = useNotifications()
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)

  const invalidate = () => queryClient.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY })

  const validate = useMutation({
    mutationFn: (id: string) => connectionsApi.validate(id),
    onSuccess: (result) => {
      invalidate()
      const status = result?.health?.status
      if (status === 'valid') notifications.success('Connection valid', `${connection?.name ?? 'The connection'} answered.`)
      else notifications.error('Validation failed', result?.health?.error || `Health is ${status ?? 'unknown'}.`)
    },
    onError: (error: unknown) => notifications.error('Validation failed', errorMessage(error, 'The account did not answer')),
  })

  const disconnect = useMutation({
    mutationFn: (id: string) => connectionsApi.remove(id),
    onSuccess: () => {
      invalidate()
      setConfirmDisconnect(false)
      onOpenChange(false)
      notifications.success('Disconnected', `${connection?.name ?? 'The connection'} was removed.`)
    },
    onError: (error: unknown) => {
      setConfirmDisconnect(false)
      notifications.error('Could not disconnect', errorMessage(error, 'The connection was not removed'))
    },
  })

  const methodType = connection?.method ?? connector?.connect?.[0]?.type ?? null
  const method = methodType ? connector?.connect?.find((m) => m.type === methodType) : undefined
  const usedBy = connection?.usedBy ?? []

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-lg">
        {connection && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                <span className="truncate">{connection.name}</span>
                <ConnectionHealthBadge health={connection.health} />
              </SheetTitle>
              <SheetDescription>
                {connector?.displayName ?? connection.connectorDisplayName ?? connection.connectorKey}
                {connection.accountLabel ? ` as ${connection.accountLabel}` : ''}
                {' '}
                <span className="text-muted-foreground">({connection.owner === 'org' ? 'organization' : 'personal'})</span>
              </SheetDescription>
            </SheetHeader>

            <div className="mt-4 space-y-5">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
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
                <Button type="button" variant="outline" size="sm" onClick={() => onRotate(connection)}>
                  <KeyRound className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                  Rotate
                </Button>
                <Button type="button" variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => setConfirmDisconnect(true)}>
                  <Unplug className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                  Disconnect
                </Button>
              </div>

              <Separator />

              <section className="space-y-2" aria-label="Used by">
                <h3 className="text-sm font-semibold">Used by</h3>
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
              </section>

              <Separator />

              <GrantsEditor connectionId={connection.id} />
            </div>
          </>
        )}
      </SheetContent>

      <AlertDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {connection?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {usedBy.length > 0
                ? `${usedBy.length} thing${usedBy.length === 1 ? '' : 's'} still use${usedBy.length === 1 ? 's' : ''} it and will fail until reconnected. `
                : ''}
              The stored secret is deleted. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction onClick={() => connection && disconnect.mutate(connection.id)} disabled={disconnect.isPending}>
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  )
}
