/**
 * One credential (/credentials/:id): the detail header every resource has
 * (back, logo, name, whether it works, "Check again"), then Overview (the
 * account, the key, never shown and replaceable in place, and who can use
 * it) and Used by. Delete sits at the bottom of Overview behind a one-line
 * confirm.
 *
 * A key a single API, MCP server, channel or app keeps for itself has the
 * same page, without the check: it is changed where it is used.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, ChevronRight, RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { DETAIL_TITLE_CLASSES } from '@/components/layout/page-header'
import { ServiceIcon } from '@/components/connect/service-tiles'
import { StatusLabel } from '@/components/connect/status-label'
import { WhoCanUse, WhoCanUseLine } from '@/components/connect/who-can-use'
import { ConnectServiceForm, connectorIcon, useConnectOwners, useConnectors } from '@/components/connections/connect-flow'
import { connectionCheck, connectionWho } from '@/components/connections/connection-status'
import type { Visibility, VisibilityValue } from '@/components/ui/visibility-field'
import { useOrganizationRole } from '@/hooks/use-organization-role'
import { credentialsApi } from '@/lib/api'
import { connectionsApi, errorMessage } from '@/lib/connections-api'
import { cn, pluralized } from '@/lib/utils'
import { useNotifications } from '@/store/app'
import type { Connection, Connector } from '@/types/connections'
import { storedRow, type CredentialUse, type StoredCredential } from './credential-rows'
import { CONNECTIONS_QUERY_KEY, CREDENTIALS_PATH, CREDENTIALS_QUERY_KEY } from './paths'

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

/** The header every detail page opens with: back, icon, name, one line under it, status and actions. */
function DetailHeader({ icon, name, subtitle, status, actions }: { icon: ReactNode; name: string; subtitle: ReactNode; status?: ReactNode; actions?: ReactNode }) {
  const navigate = useNavigate()
  return (
    <>
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm text-muted-foreground">
        <Link to={CREDENTIALS_PATH} className="hover:text-foreground">
          Credentials
        </Link>
        <ChevronRight className="h-3 w-3" aria-hidden />
        <span className="truncate text-foreground">{name}</span>
      </nav>
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <Button variant="outline" size="sm" onClick={() => navigate(CREDENTIALS_PATH)} aria-label="Back to credentials">
            <ArrowLeft className="h-4 w-4" aria-hidden />
          </Button>
          <ServiceIcon size="lg">{icon}</ServiceIcon>
          <div className="min-w-0">
            <h1 className={cn(DETAIL_TITLE_CLASSES, 'truncate')}>{name}</h1>
            <p className="text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {status}
          {actions}
        </div>
      </header>
    </>
  )
}

function UsedByList({ uses }: { uses: CredentialUse[] }) {
  if (uses.length === 0) return <p className="text-sm text-muted-foreground">Nothing uses it yet.</p>
  return (
    <ul className="divide-y rounded-md border" data-testid="used-by-list">
      {uses.map((u, i) => (
        <li key={`${u.label}:${i}`} className="px-3 py-2 text-sm">
          {u.href ? (
            <Link to={u.href} className="text-primary hover:underline">
              {u.label}
            </Link>
          ) : (
            u.label
          )}
        </li>
      ))}
    </ul>
  )
}

function DeleteSection({ name, uses, pending, onDelete }: { name: string; uses: number; pending: boolean; onDelete: () => void }) {
  const { confirm, dialog } = useConfirm()
  return (
    <section className="border-t pt-6">
      <Button
        variant="ghost"
        className="text-destructive hover:text-destructive"
        disabled={pending}
        onClick={async () => {
          const ok = await confirm({
            title: `Delete ${name}?`,
            description: uses > 0 ? `${pluralized(uses, 'thing')} still use${uses === 1 ? 's' : ''} it and will stop working.` : undefined,
            confirmLabel: 'Delete',
            destructive: true,
          })
          if (ok) onDelete()
        }}
      >
        Delete credential
      </Button>
      {dialog}
    </section>
  )
}

export interface CredentialDetailProps {
  connection: Connection
  connector?: Connector | null
  /** Where Delete lands. */
  onDeleted: () => void
}

export function CredentialDetail({ connection, connector, onDeleted }: CredentialDetailProps) {
  const queryClient = useQueryClient()
  const notifications = useNotifications()
  const { canManage } = useOrganizationRole()
  const [replacing, setReplacing] = useState(false)
  const [outcome, setOutcome] = useState<CheckOutcome | null>(null)

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY })
    queryClient.invalidateQueries({ queryKey: CREDENTIALS_QUERY_KEY })
  }

  const check = useMutation({
    mutationFn: () => connectionsApi.validate(connection.id),
    onSuccess: (result) => {
      invalidate()
      const next = connectionCheck(result ?? connection, connector)
      setOutcome({ ok: next.state === 'ok', message: next.state === 'ok' ? `${next.label}.` : next.error || `${connection.name} needs attention.` })
    },
    onError: (error: unknown) => setOutcome({ ok: false, message: errorMessage(error, 'The check did not finish.') }),
  })

  const remove = useMutation({
    mutationFn: () => connectionsApi.remove(connection.id),
    onSuccess: (result) => {
      invalidate()
      notifications.success('Credential deleted', result?.revokeError ? `${connection.name} is gone here. Revoke the key at the service as well.` : `${connection.name} is gone.`)
      onDeleted()
    },
    onError: (error: unknown) => notifications.error('Could not delete', errorMessage(error, 'The credential was not deleted.')),
  })


  // Who can use it, changed here like a provider connection's. The key a
  // provider connection keeps for itself is changed on that connection.
  const owners = useConnectOwners()
  const who = connectionWho(connection)
  const shareOptions: Visibility[] = connection.providerId ? [who] : [who, ...owners.options.filter((o) => o !== who)]
  const share = useMutation({
    mutationFn: (next: VisibilityValue) =>
      connectionsApi.setSharing(connection.id, { owner: next.visibility, ...(next.visibility === 'team' && next.teamId ? { teamId: next.teamId } : {}) }),
    onSuccess: () => {
      invalidate()
      notifications.success('Saved', 'Who can use it changed.')
    },
    onError: (error: unknown) => notifications.error('Could not change who can use it', errorMessage(error, 'Nothing was changed.')),
  })
  const status = connectionCheck(connection, connector)
  const uses: CredentialUse[] = (connection.usedBy ?? []).map((u) => ({ label: u.name }))
  const service = connector?.displayName ?? connection.connectorDisplayName ?? connection.connectorKey

  return (
    <div className="space-y-8" data-testid="credential-detail">
      <DetailHeader
        icon={connectorIcon(connector ?? { key: connection.connectorKey, displayName: service })}
        name={connection.name}
        subtitle={connection.accountLabel ? `${service} · ${connection.accountLabel}` : service}
        status={<StatusLabel check={status} testId="credential-status" />}
        actions={
          <Button variant="outline" size="sm" onClick={() => check.mutate()} disabled={check.isPending} className="gap-2">
            <RefreshCw className={cn('h-4 w-4', check.isPending && 'animate-spin')} aria-hidden />
            {check.isPending ? 'Checking...' : 'Check again'}
          </Button>
        }
      />

      {status.error && !outcome && (
        <p className="break-words rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" data-testid="credential-last-error">
          {status.error}
        </p>
      )}
      {outcome && (
        <p
          role="status"
          data-testid="credential-check-result"
          className={cn(
            'break-words rounded-md border p-3 text-sm',
            outcome.ok ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200' : 'border-destructive/30 bg-destructive/5 text-destructive',
          )}
        >
          {outcome.message}
        </p>
      )}

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="used-by">Used by ({uses.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="space-y-6">
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
              <WhoCanUse
                value={{ visibility: who, teamId: connection.teamId ?? null }}
                onChange={(next) => {
                  if (next.visibility === 'team' && !next.teamId) return
                  share.mutate(next)
                }}
                disabled={share.isPending}
                noun="this credential"
                options={shareOptions}
              />
            </CardContent>
          </Card>
          <DeleteSection name={connection.name} uses={uses.length} pending={remove.isPending} onDelete={() => remove.mutate()} />
        </TabsContent>
        <TabsContent value="used-by">
          <UsedByList uses={uses} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

/** A key a single API, MCP server, channel or app keeps: shown here, changed there. */
export function StoredCredentialDetail({ credential, onDeleted }: { credential: StoredCredential; onDeleted: () => void }) {
  const queryClient = useQueryClient()
  const notifications = useNotifications()
  const row = storedRow(credential)
  const owner = row.uses[0]

  const remove = useMutation({
    mutationFn: () => credentialsApi.remove(credential.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CREDENTIALS_QUERY_KEY })
      notifications.success('Credential deleted', `${credential.name} is gone.`)
      onDeleted()
    },
    onError: (error: unknown) => notifications.error('Could not delete', errorMessage(error, 'The credential was not deleted.')),
  })

  return (
    <div className="space-y-8" data-testid="credential-detail">
      <DetailHeader icon={connectorIcon({ key: 'other' })} name={credential.name} subtitle={row.service} />
      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="used-by">Used by ({row.uses.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="space-y-6">
          <Card>
            <CardContent className="space-y-5 pt-6">
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="text-muted-foreground">Key:</span>
                <span>Stored encrypted. It is never shown again.</span>
                {owner?.href && (
                  <Link to={owner.href} className="text-primary hover:underline">
                    Change it where it is used
                  </Link>
                )}
              </p>
              <WhoCanUseLine summary={row.who} />
            </CardContent>
          </Card>
          <DeleteSection name={credential.name} uses={row.uses.length} pending={remove.isPending} onDelete={() => remove.mutate()} />
        </TabsContent>
        <TabsContent value="used-by">
          <UsedByList uses={row.uses} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

/** /credentials/:id */
export function CredentialDetailPage() {
  const { id = '' } = useParams<{ id: string }>()
  const navigate = useNavigate()
  // The list is what every other surface reads and invalidates, so the page
  // reads the same query rather than a second per-id cache.
  const connectionsQuery = useConnections()
  const connectorsQuery = useConnectors()

  const connection = (connectionsQuery.data ?? []).find((c) => c.id === id) ?? null
  const connector = connection ? (connectorsQuery.data ?? []).find((c) => c.key === connection.connectorKey) ?? null : null
  // Not a shared credential: maybe a key one API, server, channel or app keeps.
  const storedQuery = useQuery({
    queryKey: [...CREDENTIALS_QUERY_KEY, 'one', id],
    queryFn: async () => (await credentialsApi.getById(id)) as StoredCredential,
    enabled: !!id && connectionsQuery.isSuccess && !connection,
    retry: false,
  })

  const name = connection?.name ?? storedQuery.data?.name
  useEffect(() => {
    document.title = name ? `${name} | Credentials | almyty` : 'Credential | almyty'
    return () => {
      document.title = 'almyty'
    }
  }, [name])

  const back = (
    <Link to={CREDENTIALS_PATH} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
      Credentials
    </Link>
  )

  if (connectionsQuery.isError) {
    return (
      <div className="space-y-4">
        {back}
        <QueryError error={connectionsQuery.error} onRetry={() => connectionsQuery.refetch()} title="Couldn't load this credential" />
      </div>
    )
  }
  if (connectionsQuery.isLoading || (!connection && storedQuery.isLoading)) {
    return (
      <div className="flex h-96 items-center justify-center" aria-busy="true">
        <LoadingSpinner size="lg" />
      </div>
    )
  }
  if (connection) return <CredentialDetail connection={connection} connector={connector} onDeleted={() => navigate(CREDENTIALS_PATH)} />
  if (storedQuery.data) return <StoredCredentialDetail credential={storedQuery.data} onDeleted={() => navigate(CREDENTIALS_PATH)} />
  return (
    <div className="space-y-4">
      {back}
      <p className="text-muted-foreground">This credential is gone. It may have been deleted.</p>
    </div>
  )
}
