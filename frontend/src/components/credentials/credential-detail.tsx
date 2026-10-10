/**
 * One credential (/credentials/:id), laid out like every detail page: the
 * shared DetailHeader (back, logo, name, what it is, whether it works,
 * "Check again"), Overview and Used by tabs, one details section (the
 * account, the key, who can use it) closed by its DangerZone.
 *
 * Nothing here knows a particular service. The logo is the connector's
 * brand mark, the account row is named by the connector's own form, and
 * whether the server can check the key is the connector's validation kind
 * (connectorCanCheck): a key that is only stored shows "Not checked" and no
 * "Check again". A check's answer lands in the status label, with what it
 * learned (health.detail) beside it and, when it failed, one line under
 * the name.
 *
 * A key a single API, MCP server, channel or app keeps for itself has the
 * same page, without the check: it is changed where it is used.
 */
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { DANGER_BUTTON_CLASSES, DangerZone } from '@/components/ui/danger-zone'
import { DetailItem, DetailList } from '@/components/ui/detail-list'
import { DetailBackLink, DetailHeader } from '@/components/layout/detail-header'
import { FormSection } from '@/components/layout/form-page'
import { StatusLabel } from '@/components/connect/status-label'
import { WhoCanUse } from '@/components/connect/who-can-use'
import { ConnectServiceForm, connectorIcon, useConnectOwners, useConnectors } from '@/components/connections/connect-flow'
import { NOT_CHECKED, connectionCheck, connectionWho, connectorCanCheck } from '@/components/connections/connection-status'
import type { Visibility, VisibilityValue } from '@/components/ui/visibility-field'
import { credentialsApi } from '@/lib/api'
import { connectionsApi, errorMessage } from '@/lib/connections-api'
import { cn, pluralized } from '@/lib/utils'
import { useNotifications } from '@/store/app'
import type { Connection, Connector } from '@/types/connections'
import { storedRow, type CredentialUse, type StoredCredential } from './credential-rows'
import { CONNECTIONS_QUERY_KEY, CREDENTIALS_PATH, CREDENTIALS_QUERY_KEY } from './paths'

const BACK = { to: CREDENTIALS_PATH, label: 'Credentials' }

export function useConnections() {
  return useQuery({
    queryKey: CONNECTIONS_QUERY_KEY,
    queryFn: async () => {
      const rows = await connectionsApi.list()
      return Array.isArray(rows) ? rows : []
    },
  })
}

/**
 * What the account row is called: the title the connector's own form gives
 * the field the account comes from ("API server URL"), else "Account".
 */
export function accountLabelTitle(connector: Pick<Connector, 'validation' | 'connect'> | null | undefined): string {
  const field = connector?.validation?.accountLabelFrom
  if (typeof field === 'string') {
    for (const method of connector?.connect ?? []) {
      const title = (method.schema?.properties?.[field] as { title?: unknown } | undefined)?.title
      if (typeof title === 'string' && title.trim()) return title
    }
  }
  return 'Account'
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

/** The section's last row: delete, behind a one-line confirm. */
function DeleteCredential({ name, uses, pending, onDelete }: { name: string; uses: number; pending: boolean; onDelete: () => void }) {
  const { confirm, dialog } = useConfirm()
  const cost = uses > 0 ? `${pluralized(uses, 'thing')} still use${uses === 1 ? 's' : ''} it and will stop working.` : undefined
  return (
    <>
      <DangerZone
        variant="inline"
        title="Delete this credential"
        description={cost ?? 'Nothing uses it.'}
        action={
          <Button
            variant="outline"
            size="sm"
            className={DANGER_BUTTON_CLASSES}
            disabled={pending}
            onClick={async () => {
              const ok = await confirm({ title: `Delete ${name}?`, description: cost, confirmLabel: 'Delete', destructive: true })
              if (ok) onDelete()
            }}
          >
            Delete credential
          </Button>
        }
      />
      {dialog}
    </>
  )
}

function KeyValue() {
  return <span>Stored encrypted</span>
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
  const [replacing, setReplacing] = useState(false)

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY })
    queryClient.invalidateQueries({ queryKey: CREDENTIALS_QUERY_KEY })
  }
  // The answer is on the page at once, before the list is fetched again.
  const showAnswer = (next: Connection | null | undefined) => {
    if (next?.id) queryClient.setQueryData<Connection[]>(CONNECTIONS_QUERY_KEY, (rows) => rows?.map((r) => (r.id === next.id ? { ...r, ...next } : r)))
    invalidate()
  }

  const canCheck = connectorCanCheck(connector)
  const check = useMutation({
    mutationFn: () => connectionsApi.validate(connection.id),
    onSuccess: showAnswer,
    onError: (error: unknown) => notifications.error('Could not check', errorMessage(error, 'The check did not finish.')),
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
  const detail = status.state === 'ok' ? connection.health?.detail : null

  return (
    <div className="mx-auto max-w-5xl space-y-6" data-testid="credential-detail">
      <DetailHeader
        back={BACK}
        icon={connectorIcon(connector ?? { key: connection.connectorKey, displayName: service })}
        title={connection.name}
        meta={[
          <span key="service">{service}</span>,
          <StatusLabel key="status" check={status} testId="credential-status" />,
          detail ? <span key="detail" data-testid="credential-check-detail">{detail}</span> : null,
        ]}
        problem={status.state === 'failed' ? status.error || 'The last check failed.' : null}
        problemTestId="credential-last-error"
        actions={
          canCheck && (
            <Button variant="outline" onClick={() => check.mutate()} disabled={check.isPending} className="gap-2">
              <RefreshCw className={cn('h-4 w-4', check.isPending && 'animate-spin')} aria-hidden />
              {check.isPending ? 'Checking...' : 'Check again'}
            </Button>
          )
        }
      />

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="used-by">Used by ({uses.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="pt-2">
          <FormSection>
            <DetailList testId="credential-details">
              {connection.accountLabel && <DetailItem label={accountLabelTitle(connector)} value={connection.accountLabel} testId="credential-account" />}
              <DetailItem
                label="Key"
                value={<KeyValue />}
                action={
                  !replacing && connector ? (
                    <button type="button" className="text-primary hover:underline" onClick={() => setReplacing(true)}>
                      Replace key
                    </button>
                  ) : undefined
                }
                testId="credential-key"
              >
                {replacing && connector && (
                  <div className="rounded-lg border p-3">
                    <ConnectServiceForm
                      connector={connector}
                      rotateConnection={connection}
                      onCancel={() => setReplacing(false)}
                      onConnected={(rotated) => {
                        setReplacing(false)
                        showAnswer(rotated)
                      }}
                    />
                  </div>
                )}
              </DetailItem>
              <DetailItem
                label="Who can use it"
                value={
                  <WhoCanUse
                    showLabel={false}
                    value={{ visibility: who, teamId: connection.teamId ?? null }}
                    onChange={(next) => {
                      if (next.visibility === 'team' && !next.teamId) return
                      share.mutate(next)
                    }}
                    disabled={share.isPending}
                    noun="this credential"
                    options={shareOptions}
                  />
                }
              />
            </DetailList>
            <DeleteCredential name={connection.name} uses={uses.length} pending={remove.isPending} onDelete={() => remove.mutate()} />
          </FormSection>
        </TabsContent>
        <TabsContent value="used-by" className="pt-2">
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
    <div className="mx-auto max-w-5xl space-y-6" data-testid="credential-detail">
      <DetailHeader
        back={BACK}
        icon={connectorIcon({ key: 'other' })}
        title={credential.name}
        meta={[<span key="service">{row.service}</span>, <StatusLabel key="status" check={NOT_CHECKED} testId="credential-status" />]}
      />
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="used-by">Used by ({row.uses.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="pt-2">
          <FormSection>
            <DetailList testId="credential-details">
              <DetailItem
                label="Key"
                value={<KeyValue />}
                action={
                  owner?.href ? (
                    <Link to={owner.href} className="text-primary hover:underline">
                      Change it where it is used
                    </Link>
                  ) : undefined
                }
                testId="credential-key"
              />
              <DetailItem label="Who can use it" value={<span data-testid="who-can-use">{row.who}</span>} />
            </DetailList>
            <DeleteCredential name={credential.name} uses={row.uses.length} pending={remove.isPending} onDelete={() => remove.mutate()} />
          </FormSection>
        </TabsContent>
        <TabsContent value="used-by" className="pt-2">
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

  if (connectionsQuery.isError) {
    return (
      <div className="mx-auto max-w-5xl space-y-4">
        <DetailBackLink {...BACK} />
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
    <div className="mx-auto max-w-5xl space-y-4">
      <DetailBackLink {...BACK} />
      <p className="text-muted-foreground">This credential is gone. It may have been deleted.</p>
    </div>
  )
}
