/**
 * The organization's connection policies: kind badge, name, what the rule
 * does in words, an enabled switch, edit and delete.
 */
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react'

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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { QueryError } from '@/components/ui/query-error'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { CONNECTORS_QUERY_KEY } from '@/components/connections/connect-sheet'
import { connectorsApi, errorMessage } from '@/lib/connections-api'
import { POLICIES_QUERY_KEY, connectionPoliciesApi, describePolicyRule } from '@/lib/connections-governance-api'
import { cn } from '@/lib/utils'
import { useNotifications } from '@/store/app'
import { POLICY_KIND_LABELS, type ConnectionPolicy, type ConnectionPolicyKind } from '@/types/connections-governance'
import { PolicyDialog } from './policy-dialog'

const KIND_BADGE_CLASS: Record<ConnectionPolicyKind, string> = {
  connector_allowlist: 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
  connector_denylist: 'border-rose-500/40 text-rose-600 dark:text-rose-400',
  scope_rule: 'border-violet-500/40 text-violet-600 dark:text-violet-400',
  expiry_rule: 'border-amber-500/40 text-amber-600 dark:text-amber-400',
  rotation_rule: 'border-cyan-500/40 text-cyan-600 dark:text-cyan-400',
}

export function PolicyKindBadge({ kind, className }: { kind: ConnectionPolicyKind; className?: string }) {
  return (
    <Badge variant="outline" className={cn('text-[10px] font-medium', KIND_BADGE_CLASS[kind], className)} data-testid="policy-kind-badge" data-kind={kind}>
      {POLICY_KIND_LABELS[kind] ?? kind}
    </Badge>
  )
}

export function PoliciesTable() {
  const queryClient = useQueryClient()
  const notifications = useNotifications()
  const [dialog, setDialog] = useState<{ open: boolean; policy: ConnectionPolicy | null }>({ open: false, policy: null })
  const [toDelete, setToDelete] = useState<ConnectionPolicy | null>(null)

  const policiesQuery = useQuery({
    queryKey: POLICIES_QUERY_KEY,
    queryFn: async () => {
      const rows = await connectionPoliciesApi.list()
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

  const connectorNames = useMemo(() => Object.fromEntries((connectorsQuery.data ?? []).map((c) => [c.key, c.displayName])), [connectorsQuery.data])

  const invalidate = () => queryClient.invalidateQueries({ queryKey: POLICIES_QUERY_KEY })

  const toggle = useMutation({
    mutationFn: ({ policy, enabled }: { policy: ConnectionPolicy; enabled: boolean }) => connectionPoliciesApi.update(policy.id, { enabled }),
    onSuccess: (_result, { enabled }) => {
      invalidate()
      notifications.success(enabled ? 'Policy enabled' : 'Policy disabled', enabled ? 'It is evaluated from now on.' : 'It is kept but no longer evaluated.')
    },
    onError: (error: unknown) => notifications.error('Could not save', errorMessage(error, 'The policy was not changed')),
  })

  const remove = useMutation({
    mutationFn: (policy: ConnectionPolicy) => connectionPoliciesApi.remove(policy.id),
    onSuccess: () => {
      invalidate()
      setToDelete(null)
      notifications.success('Policy deleted', 'The rule is gone.')
    },
    onError: (error: unknown) => {
      setToDelete(null)
      notifications.error('Could not delete', errorMessage(error, 'The policy was not removed'))
    },
  })

  const policies = policiesQuery.data ?? []

  return (
    <div className="space-y-3" data-testid="policies-panel">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Org-wide rules over what may be connected and how connections may be used. Disabled rules are kept but never evaluated.</p>
        <Button type="button" size="sm" onClick={() => setDialog({ open: true, policy: null })} className="shrink-0">
          <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />
          Add policy
        </Button>
      </div>

      {policiesQuery.isError && <QueryError error={policiesQuery.error} onRetry={() => policiesQuery.refetch()} title="Policies could not be loaded" />}

      {policiesQuery.isLoading && (
        <div className="space-y-2" aria-busy="true">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 rounded-lg" />)}
        </div>
      )}

      {!policiesQuery.isLoading && !policiesQuery.isError && policies.length === 0 && (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={ShieldCheck}
              title="No policies yet"
              description="Without rules every connector may be connected and every grant is honoured as written."
              action={<Button type="button" variant="outline" onClick={() => setDialog({ open: true, policy: null })}>Add policy</Button>}
            />
          </CardContent>
        </Card>
      )}

      {policies.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <Table data-testid="policies-table">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[130px]">Kind</TableHead>
                <TableHead>Rule</TableHead>
                <TableHead className="w-[90px]">Enabled</TableHead>
                <TableHead className="w-[90px]"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {policies.map((policy) => {
                const label = policy.name || POLICY_KIND_LABELS[policy.kind]
                return (
                  <TableRow key={policy.id} data-testid={`policy-row-${policy.id}`} data-kind={policy.kind}>
                    <TableCell className="align-top"><PolicyKindBadge kind={policy.kind} /></TableCell>
                    <TableCell className="align-top">
                      {policy.name && <div className="font-medium">{policy.name}</div>}
                      <div className={cn('text-sm', policy.name ? 'text-muted-foreground' : '')} data-testid="policy-summary">{describePolicyRule(policy, connectorNames)}</div>
                    </TableCell>
                    <TableCell className="align-top">
                      <Switch
                        checked={policy.enabled}
                        onCheckedChange={(enabled) => toggle.mutate({ policy, enabled })}
                        disabled={toggle.isPending}
                        aria-label={`${policy.enabled ? 'Disable' : 'Enable'} ${label}`}
                      />
                    </TableCell>
                    <TableCell className="align-top">
                      <div className="flex justify-end gap-1">
                        <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label={`Edit ${label}`} onClick={() => setDialog({ open: true, policy })}>
                          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                        </Button>
                        <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label={`Delete ${label}`} onClick={() => setToDelete(policy)}>
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <PolicyDialog open={dialog.open} policy={dialog.policy} onOpenChange={(open) => setDialog((prev) => ({ ...prev, open }))} />

      <AlertDialog open={!!toDelete} onOpenChange={(next) => !next && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {toDelete?.name || (toDelete ? POLICY_KIND_LABELS[toDelete.kind] : 'policy')}?</AlertDialogTitle>
            <AlertDialogDescription>
              {toDelete ? describePolicyRule(toDelete, connectorNames) : ''} The rule stops being evaluated at once. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction onClick={() => toDelete && remove.mutate(toDelete)} disabled={remove.isPending}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
