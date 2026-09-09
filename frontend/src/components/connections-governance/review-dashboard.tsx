/**
 * Review: personal (user-scoped) connections that agents or workspaces
 * hold grants on, with the owner, the grants and their environments, health,
 * the last resolve, and a one-click revoke of those grants.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, ShieldOff } from 'lucide-react'

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
import { Label } from '@/components/ui/label'
import { QueryError } from '@/components/ui/query-error'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ConnectionHealthBadge } from '@/components/connections/health-badge'
import { CONNECTIONS_QUERY_KEY } from '@/components/connections/connection-detail-sheet'
import { errorMessage } from '@/lib/connections-api'
import { REVIEW_QUERY_KEY, connectionsReviewApi } from '@/lib/connections-governance-api'
import { useNotifications } from '@/store/app'
import type { ConnectionHealth } from '@/types/connections'
import type { ReviewEnvironment, ReviewRow } from '@/types/connections-governance'

const SELECT_CLASS =
  'flex h-9 rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30'

function formatDate(iso: string | null | undefined): string {
  if (!iso) return 'Never'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

export function ownerLabel(owner: ReviewRow['owner']): string {
  return owner.name || owner.email || owner.id
}

export function ReviewDashboard() {
  const queryClient = useQueryClient()
  const notifications = useNotifications()
  const [environment, setEnvironment] = useState<ReviewEnvironment>('production')
  const [toRevoke, setToRevoke] = useState<ReviewRow | null>(null)

  const reviewQuery = useQuery({
    queryKey: [...REVIEW_QUERY_KEY, environment],
    queryFn: async () => {
      const rows = await connectionsReviewApi.list(environment)
      return Array.isArray(rows) ? rows : []
    },
  })

  const revoke = useMutation({
    mutationFn: (row: ReviewRow) => connectionsReviewApi.revokeGrants(row.connection.id),
    onSuccess: (result, row) => {
      queryClient.invalidateQueries({ queryKey: REVIEW_QUERY_KEY })
      queryClient.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY })
      queryClient.invalidateQueries({ queryKey: ['connections', row.connection.id, 'grants'] })
      setToRevoke(null)
      const n = result?.revoked ?? 0
      notifications.success('Grants revoked', `${n} grant${n === 1 ? '' : 's'} on ${row.connection.name} removed.`)
    },
    onError: (error: unknown) => {
      setToRevoke(null)
      notifications.error('Could not revoke', errorMessage(error, 'The grants were not removed'))
    },
  })

  const rows = reviewQuery.data ?? []

  return (
    <div className="space-y-3" data-testid="review-panel">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">Personal connections that agents or workspaces can resolve. A production agent on a member's own key is a governance gap: move it to an organization connection, or revoke.</p>
        <div className="flex shrink-0 items-center gap-2">
          <Label htmlFor="review-environment" className="text-xs text-muted-foreground">Environment</Label>
          <select id="review-environment" className={SELECT_CLASS} value={environment} onChange={(e) => setEnvironment(e.target.value as ReviewEnvironment)}>
            <option value="production">production</option>
            <option value="any">any</option>
          </select>
        </div>
      </div>

      {reviewQuery.isError && <QueryError error={reviewQuery.error} onRetry={() => reviewQuery.refetch()} title="Review could not be loaded" />}

      {reviewQuery.isLoading && (
        <div className="space-y-2" aria-busy="true">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-14 rounded-lg" />)}
        </div>
      )}

      {!reviewQuery.isLoading && !reviewQuery.isError && rows.length === 0 && (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={Eye}
              title="Nothing to review"
              description={environment === 'any' ? 'No personal connection is granted to an agent or workspace.' : `No personal connection is granted to a ${environment} agent. Switch to any to see every environment.`}
            />
          </CardContent>
        </Card>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <Table data-testid="review-table">
            <TableHeader>
              <TableRow>
                <TableHead>Connection</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Granted to</TableHead>
                <TableHead>Health</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead className="w-[140px]"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.connection.id} data-testid={`review-row-${row.connection.id}`}>
                  <TableCell className="align-top">
                    <div className="font-medium">{row.connection.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {row.connection.connectorKey}
                      {row.connection.accountLabel ? ` | ${row.connection.accountLabel}` : ''}
                    </div>
                  </TableCell>
                  <TableCell className="align-top text-sm">{ownerLabel(row.owner)}</TableCell>
                  <TableCell className="align-top">
                    <ul className="space-y-1" data-testid="review-grants">
                      {row.grants.map((g) => (
                        <li key={g.id} className="flex flex-wrap items-center gap-1.5 text-sm">
                          <Badge variant="outline" className="text-[10px]">{g.principalType}</Badge>
                          <span className="truncate">{g.principalName || g.principalId}</span>
                          {g.environment && (
                            <Badge variant={g.environment === 'production' ? 'default' : 'secondary'} className="text-[10px]" data-testid="grant-environment">{g.environment}</Badge>
                          )}
                        </li>
                      ))}
                    </ul>
                  </TableCell>
                  <TableCell className="align-top">
                    <ConnectionHealthBadge health={row.connection.health as ConnectionHealth} />
                  </TableCell>
                  <TableCell className="align-top text-xs text-muted-foreground">
                    {row.lastResolve ? (
                      <>
                        <div>{formatDate(row.lastResolve.at)}</div>
                        {row.lastResolve.purpose && <div className="truncate">{row.lastResolve.purpose}</div>}
                      </>
                    ) : 'Never'}
                  </TableCell>
                  <TableCell className="align-top">
                    <Button type="button" variant="outline" size="sm" onClick={() => setToRevoke(row)} aria-label={`Revoke grants on ${row.connection.name}`}>
                      <ShieldOff className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                      Revoke grants
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <AlertDialog open={!!toRevoke} onOpenChange={(next) => !next && setToRevoke(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke grants on {toRevoke?.connection.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {toRevoke ? `${toRevoke.grants.length} agent and workspace grant${toRevoke.grants.length === 1 ? '' : 's'} will be removed. ` : ''}
              {toRevoke ? `${ownerLabel(toRevoke.owner)} keeps the connection; nothing else can resolve it until it is granted again.` : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction onClick={() => toRevoke && revoke.mutate(toRevoke)} disabled={revoke.isPending}>Revoke</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
