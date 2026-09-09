/**
 * Expiry and rotation: what the nightly sweep would act on (warn and
 * expire lists from GET /expiring, due and manual lists from GET
 * /rotate-due), a "Rotate due now" trigger, and the audit export.
 */
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Loader2, RefreshCw, TimerReset } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { QueryError } from '@/components/ui/query-error'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { CONNECTIONS_QUERY_KEY } from '@/components/connections/connection-detail-sheet'
import { connectionsApi, errorMessage } from '@/lib/connections-api'
import {
  EXPIRING_QUERY_KEY,
  ROTATION_QUERY_KEY,
  connectionsAuditExportApi,
  connectionsExpiryApi,
  connectionsRotationApi,
  daysUntil,
} from '@/lib/connections-governance-api'
import { useNotifications } from '@/store/app'
import type { Connection } from '@/types/connections'
import type { AuditExportFormat, ExpiryAction, RotationCandidate } from '@/types/connections-governance'

type ExpiryStatus = 'warn' | 'expire'
type RotationStatus = 'due' | 'manual'

interface ExpiryLine extends ExpiryAction { status: ExpiryStatus }
interface RotationLine extends RotationCandidate { status: RotationStatus }

function formatDate(iso: string | null | undefined): string {
  if (!iso) return 'Unknown'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString()
}

export function ExpiryPanel() {
  const queryClient = useQueryClient()
  const notifications = useNotifications()
  const [exporting, setExporting] = useState<AuditExportFormat | null>(null)

  const expiringQuery = useQuery({ queryKey: EXPIRING_QUERY_KEY, queryFn: () => connectionsExpiryApi.list() })
  const rotationQuery = useQuery({ queryKey: ROTATION_QUERY_KEY, queryFn: () => connectionsRotationApi.candidates() })
  const connectionsQuery = useQuery({
    queryKey: CONNECTIONS_QUERY_KEY,
    queryFn: async () => {
      const rows = await connectionsApi.list()
      return Array.isArray(rows) ? rows : []
    },
  })
  const byId = useMemo(() => new Map<string, Connection>((connectionsQuery.data ?? []).map((c) => [c.id, c])), [connectionsQuery.data])
  const nameOf = (id: string, connectorKey: string | null) => byId.get(id)?.name ?? (connectorKey ? `${connectorKey} connection` : id)
  const ownerOf = (id: string, ownerUserId: string | null) => {
    const c = byId.get(id)
    if (c) return c.owner === 'user' ? 'personal' : 'org'
    return ownerUserId ? 'personal' : 'org'
  }

  const expiryLines: ExpiryLine[] = useMemo(() => {
    const data = expiringQuery.data
    if (!data) return []
    return [...(data.expire ?? []).map((a) => ({ ...a, status: 'expire' as const })), ...(data.warn ?? []).map((a) => ({ ...a, status: 'warn' as const }))]
  }, [expiringQuery.data])

  const rotationLines: RotationLine[] = useMemo(() => {
    const data = rotationQuery.data
    if (!data) return []
    return [...(data.due ?? []).map((a) => ({ ...a, status: 'due' as const })), ...(data.manual ?? []).map((a) => ({ ...a, status: 'manual' as const }))]
  }, [rotationQuery.data])

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: EXPIRING_QUERY_KEY })
    queryClient.invalidateQueries({ queryKey: ROTATION_QUERY_KEY })
    queryClient.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY })
  }

  const rotateDue = useMutation({
    mutationFn: () => connectionsRotationApi.rotateDue(),
    onSuccess: (result) => {
      refresh()
      const rotated = result?.rotated ?? 0
      const failed = result?.failed ?? 0
      const manual = result?.manual ?? 0
      const parts = [`${rotated} rotated`, manual ? `${manual} manual` : '', failed ? `${failed} failed` : ''].filter(Boolean).join(', ')
      if (failed > 0) notifications.warning('Rotation run finished', parts)
      else notifications.success('Rotation run finished', parts)
    },
    onError: (error: unknown) => notifications.error('Rotation did not run', errorMessage(error, 'The rotation run failed')),
  })

  const enforceExpiry = useMutation({
    mutationFn: () => connectionsExpiryApi.enforce(),
    onSuccess: (result) => {
      refresh()
      const parts = [`${result?.warned ?? 0} warned`, `${result?.expired ?? 0} expired`, result?.enforce ? `${result?.revokedGrants ?? 0} grants revoked` : ''].filter(Boolean).join(', ')
      notifications.success('Expiry run finished', parts)
    },
    onError: (error: unknown) => notifications.error('Expiry did not run', errorMessage(error, 'The expiry run failed')),
  })

  const exportAudit = async (format: AuditExportFormat) => {
    setExporting(format)
    try {
      const result = await connectionsAuditExportApi.download(format)
      const retention = result.retentionDays === 'unlimited' ? 'no retention window' : result.retentionDays !== null ? `${result.retentionDays} day retention` : ''
      notifications.success('Export ready', [result.count !== null ? `${result.count} events` : '', retention, result.filename].filter(Boolean).join(', '))
    } catch (error) {
      notifications.error('Export failed', errorMessage(error, 'The audit export could not be downloaded'))
    } finally {
      setExporting(null)
    }
  }

  return (
    <div className="space-y-4" data-testid="expiry-panel">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle className="text-base">Expiring secrets</CardTitle>
              <CardDescription>
                What the nightly sweep would act on under the expiry rules{expiringQuery.data ? (expiringQuery.data.enforce ? '; grants are revoked on expiry.' : '; owners are notified, grants stay.') : '.'}
              </CardDescription>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => enforceExpiry.mutate()} disabled={enforceExpiry.isPending} className="shrink-0">
              {enforceExpiry.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <TimerReset className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />}
              Run expiry now
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {expiringQuery.isError && <QueryError error={expiringQuery.error} onRetry={() => expiringQuery.refetch()} title="Expiring connections could not be loaded" />}
          {expiringQuery.isLoading && <Skeleton className="h-12 rounded-lg" />}
          {!expiringQuery.isLoading && !expiringQuery.isError && expiryLines.length === 0 && (
            <p className="text-sm text-muted-foreground" data-testid="expiring-empty">Nothing is inside a warning window or past its maximum age.</p>
          )}
          {expiryLines.length > 0 && (
            <div className="overflow-x-auto rounded-lg border">
              <Table data-testid="expiring-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Connection</TableHead>
                    <TableHead>Owner</TableHead>
                    <TableHead>Age</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {expiryLines.map((line) => {
                    const left = daysUntil(line.expiresOn)
                    return (
                      <TableRow key={`${line.status}-${line.connectionId}`} data-testid={`expiring-row-${line.connectionId}`} data-status={line.status}>
                        <TableCell>
                          <div className="font-medium">{nameOf(line.connectionId, line.connectorKey)}</div>
                          {line.connectorKey && <div className="text-xs text-muted-foreground">{line.connectorKey}</div>}
                        </TableCell>
                        <TableCell className="text-sm">{ownerOf(line.connectionId, line.ownerUserId)}</TableCell>
                        <TableCell className="text-sm">{line.ageDays} of {line.maxAgeDays} days</TableCell>
                        <TableCell className="text-sm">
                          {formatDate(line.expiresOn)}
                          {left !== null && <span className="ml-1 text-xs text-muted-foreground">({left <= 0 ? 'past' : `in ${left} day${left === 1 ? '' : 's'}`})</span>}
                        </TableCell>
                        <TableCell>
                          <Badge variant={line.status === 'expire' ? 'destructive' : 'secondary'} className="text-[10px]">{line.status === 'expire' ? 'expired' : 'expiring'}</Badge>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle className="text-base">Rotation due</CardTitle>
              <CardDescription>Secrets older than their rotation interval. Due ones rotate through the provider API; manual ones are reported to their owners.</CardDescription>
            </div>
            <Button type="button" size="sm" onClick={() => rotateDue.mutate()} disabled={rotateDue.isPending} className="shrink-0">
              {rotateDue.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />}
              Rotate due now
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {rotationQuery.isError && <QueryError error={rotationQuery.error} onRetry={() => rotationQuery.refetch()} title="Rotation candidates could not be loaded" />}
          {rotationQuery.isLoading && <Skeleton className="h-12 rounded-lg" />}
          {!rotationQuery.isLoading && !rotationQuery.isError && rotationLines.length === 0 && (
            <p className="text-sm text-muted-foreground" data-testid="rotation-empty">Nothing is due for rotation.</p>
          )}
          {rotationLines.length > 0 && (
            <div className="overflow-x-auto rounded-lg border">
              <Table data-testid="rotation-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Connection</TableHead>
                    <TableHead>Owner</TableHead>
                    <TableHead>Age</TableHead>
                    <TableHead>How</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rotationLines.map((line) => (
                    <TableRow key={`${line.status}-${line.connectionId}`} data-testid={`rotation-row-${line.connectionId}`} data-status={line.status}>
                      <TableCell>
                        <div className="font-medium">{nameOf(line.connectionId, line.connectorKey)}</div>
                        {line.connectorKey && <div className="text-xs text-muted-foreground">{line.connectorKey}</div>}
                      </TableCell>
                      <TableCell className="text-sm">{ownerOf(line.connectionId, line.ownerUserId)}</TableCell>
                      <TableCell className="text-sm">{line.ageDays} days, every {line.everyDays}</TableCell>
                      <TableCell>
                        <Badge variant={line.status === 'due' ? 'default' : 'outline'} className="text-[10px]">{line.status === 'due' ? 'provider API' : 'manual'}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Audit export</CardTitle>
          <CardDescription>The connections event stream, newest first: connects, validations, grants, rotations and policy changes, with an EU AI Act Annex IV mapping in the JSON envelope.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2" data-testid="audit-export-buttons">
            <Button type="button" variant="outline" size="sm" onClick={() => exportAudit('json')} disabled={exporting !== null}>
              {exporting === 'json' ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />}
              Export JSON
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => exportAudit('csv')} disabled={exporting !== null}>
              {exporting === 'csv' ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />}
              Export CSV
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
