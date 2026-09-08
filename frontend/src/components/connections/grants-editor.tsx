/**
 * Who may use a connection. Lists the grants, adds one (principal type,
 * principal picked from the org's users / teams / agents / workspaces or a
 * fixed role, permission, optional expiry) and revokes with a confirm.
 */
import { useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus, ShieldCheck, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import { agentsApi, organizationsApi, workspacesApi } from '@/lib/api'
import { connectionsApi, errorMessage } from '@/lib/connections-api'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import type { ConnectionGrant, GrantPermission, GrantPrincipalType } from '@/types/connections'

export const grantsQueryKey = (connectionId: string) => ['connections', connectionId, 'grants'] as const

const SELECT_CLASS =
  'flex h-9 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-50'

export const PRINCIPAL_TYPE_LABELS: Record<GrantPrincipalType, string> = {
  user: 'User',
  team: 'Team',
  role: 'Role',
  agent: 'Agent',
  workspace: 'Workspace',
}

export const ROLE_PRINCIPALS: Array<{ id: string; label: string }> = [
  { id: 'owner', label: 'Owners' },
  { id: 'admin', label: 'Admins' },
  { id: 'member', label: 'Members' },
]

interface PrincipalOption {
  id: string
  label: string
}

function asList(payload: unknown, key?: string): any[] {
  if (Array.isArray(payload)) return payload
  if (key && payload && typeof payload === 'object' && Array.isArray((payload as any)[key])) return (payload as any)[key]
  return []
}

/** Names the picker shows for a principal type; pure so the mapping is testable. */
export function toPrincipalOptions(type: GrantPrincipalType, rows: unknown): PrincipalOption[] {
  switch (type) {
    case 'user':
      return asList(rows, 'members').map((m: any) => {
        const user = m.user ?? m
        const name = [user.firstName, user.lastName].filter(Boolean).join(' ')
        return { id: String(m.userId ?? user.id ?? m.id), label: name ? `${name} (${user.email ?? ''})`.replace(' ()', '') : user.email ?? String(m.userId ?? m.id) }
      })
    case 'team':
      return asList(rows, 'teams').map((t: any) => ({ id: String(t.id), label: t.name ?? t.id }))
    case 'agent':
      return asList(rows, 'agents').map((a: any) => ({ id: String(a.id), label: a.name ?? a.id }))
    case 'workspace':
      return asList(rows, 'workspaces').map((w: any) => ({ id: String(w.id), label: w.name ?? w.id }))
    case 'role':
      return ROLE_PRINCIPALS
  }
}

export function formatExpiry(iso: string | null | undefined): string {
  if (!iso) return 'Never'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

export interface GrantsEditorProps {
  connectionId: string
  /** Manage rights let the grants change; use-only viewers get a read-only list. */
  canManage?: boolean
}

export function GrantsEditor({ connectionId, canManage = true }: GrantsEditorProps) {
  const queryClient = useQueryClient()
  const notifications = useNotifications()
  const orgId = useOrganizationStore((s) => s.currentOrganization?.id)

  const [principalType, setPrincipalType] = useState<GrantPrincipalType>('user')
  const [principalId, setPrincipalId] = useState('')
  const [permission, setPermission] = useState<GrantPermission>('use')
  const [expiresAt, setExpiresAt] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [toRevoke, setToRevoke] = useState<ConnectionGrant | null>(null)

  const grantsQuery = useQuery({
    queryKey: grantsQueryKey(connectionId),
    queryFn: async () => {
      const rows = await connectionsApi.listGrants(connectionId)
      return Array.isArray(rows) ? rows : []
    },
  })

  const principalsQuery = useQuery({
    queryKey: ['connections', 'principals', principalType, orgId],
    queryFn: async () => {
      switch (principalType) {
        case 'user':
          return organizationsApi.getMembers(orgId!)
        case 'team':
          return organizationsApi.getTeams(orgId!)
        case 'agent':
          return agentsApi.getAll()
        case 'workspace':
          return workspacesApi.getAll()
        default:
          return []
      }
    },
    enabled: canManage && principalType !== 'role' && (principalType === 'agent' || principalType === 'workspace' || !!orgId),
  })

  const options = useMemo(() => toPrincipalOptions(principalType, principalsQuery.data), [principalType, principalsQuery.data])

  const invalidate = () => queryClient.invalidateQueries({ queryKey: grantsQueryKey(connectionId) })

  const addGrant = useMutation({
    mutationFn: () =>
      connectionsApi.addGrant(connectionId, {
        principalType,
        principalId,
        permission,
        ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
      }),
    onSuccess: () => {
      invalidate()
      setPrincipalId('')
      setExpiresAt('')
      setFormError(null)
      notifications.success('Access granted', 'The grant is active.')
    },
    onError: (error: unknown) => setFormError(errorMessage(error, 'The grant was not saved')),
  })

  const revokeGrant = useMutation({
    mutationFn: (grant: ConnectionGrant) => connectionsApi.removeGrant(connectionId, grant.id),
    onSuccess: () => {
      invalidate()
      setToRevoke(null)
      notifications.success('Access revoked', 'The grant is gone.')
    },
    onError: (error: unknown) => {
      setToRevoke(null)
      notifications.error('Could not revoke', errorMessage(error, 'The grant was not removed'))
    },
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!principalId) {
      setFormError('Pick who gets access')
      return
    }
    setFormError(null)
    addGrant.mutate()
  }

  const grants = grantsQuery.data ?? []

  return (
    <section className="space-y-3" aria-label="Grants">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-cyan-500" aria-hidden="true" />
        <h3 className="text-sm font-semibold">Who can use it</h3>
      </div>

      {grantsQuery.isLoading && <p className="text-xs text-muted-foreground">Loading grants</p>}
      {grantsQuery.isError && <p role="alert" className="text-xs text-destructive">{errorMessage(grantsQuery.error, 'Grants could not be loaded')}</p>}
      {!grantsQuery.isLoading && grants.length === 0 && (
        <p className="text-xs text-muted-foreground">No grants yet. Only the owner and org admins can use this connection.</p>
      )}
      {grants.length > 0 && (
        <ul className="divide-y rounded-md border" data-testid="grants-list">
          {grants.map((g) => (
            <li key={g.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[10px]">{PRINCIPAL_TYPE_LABELS[g.principalType] ?? g.principalType}</Badge>
                  <span className="truncate font-medium">{g.principalName || g.principalId}</span>
                  <Badge variant={g.permission === 'manage' ? 'default' : 'secondary'} className="text-[10px]">{g.permission}</Badge>
                </div>
                <div className="text-xs text-muted-foreground">Expires {formatExpiry(g.expiresAt)}</div>
              </div>
              {canManage && (
                <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label={`Revoke ${g.principalName || g.principalId}`} onClick={() => setToRevoke(g)}>
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <form onSubmit={submit} className="space-y-3 rounded-md border bg-muted/20 p-3" noValidate data-testid="grant-form">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="grant-principal-type">Principal type</Label>
              <select
                id="grant-principal-type"
                className={SELECT_CLASS}
                value={principalType}
                onChange={(e) => {
                  setPrincipalType(e.target.value as GrantPrincipalType)
                  setPrincipalId('')
                }}
              >
                {(Object.keys(PRINCIPAL_TYPE_LABELS) as GrantPrincipalType[]).map((t) => (
                  <option key={t} value={t}>{PRINCIPAL_TYPE_LABELS[t]}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="grant-principal">{PRINCIPAL_TYPE_LABELS[principalType]}</Label>
              <select id="grant-principal" className={SELECT_CLASS} value={principalId} onChange={(e) => setPrincipalId(e.target.value)} disabled={principalsQuery.isLoading}>
                <option value="">{principalsQuery.isLoading ? 'Loading' : `Select a ${PRINCIPAL_TYPE_LABELS[principalType].toLowerCase()}`}</option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="grant-permission">Permission</Label>
              <select id="grant-permission" className={SELECT_CLASS} value={permission} onChange={(e) => setPermission(e.target.value as GrantPermission)}>
                <option value="use">Use</option>
                <option value="manage">Manage</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="grant-expires">Expires <span className="font-normal text-muted-foreground">(optional)</span></Label>
              <Input id="grant-expires" type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
            </div>
          </div>
          {formError && <p role="alert" className="text-xs text-destructive">{formError}</p>}
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={addGrant.isPending}>
              {addGrant.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />}
              Add grant
            </Button>
          </div>
        </form>
      )}

      <AlertDialog open={!!toRevoke} onOpenChange={(next) => !next && setToRevoke(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke access?</AlertDialogTitle>
            <AlertDialogDescription>
              {toRevoke?.principalName || toRevoke?.principalId} will no longer be able to use this connection. Anything already running keeps going until it finishes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction onClick={() => toRevoke && revokeGrant.mutate(toRevoke)} disabled={revokeGrant.isPending}>
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
