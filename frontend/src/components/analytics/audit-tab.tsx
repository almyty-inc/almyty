import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Activity, Download, Filter, Lock, ScrollText, Users } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'
import { analyticsApi, auditExportApi, auditLogsApi } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useOrganizationStore } from '@/store/organization'
import { useNotifications } from '@/store/app'
import { EntitlementGate } from '@/components/entitlement-gate'
import { tierForEntitlement } from '@/lib/plan-catalog'
import type { AuditLogEntry } from '@/types'

/** Locked affordance shown when the license lacks the audit_export entitlement. */
function AuditExportLocked() {
  const tier = tierForEntitlement('audit_export')
  return (
    <Link
      to="/settings/billing"
      className="inline-flex items-center gap-1.5 rounded-md border border-dashed px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors"
      title={`Audit export is part of the ${tier.label} plan`}
    >
      <Lock className="h-3.5 w-3.5" />
      Export ({tier.label})
    </Link>
  )
}

/** Export buttons shown when the license grants audit_export. */
function AuditExportButtons({
  resourceType,
  action,
}: {
  resourceType: string
  action: string
}) {
  const { error } = useNotifications()
  const [busy, setBusy] = useState<'json' | 'csv' | null>(null)

  const download = async (format: 'json' | 'csv') => {
    setBusy(format)
    try {
      const params: Record<string, string> = {}
      if (resourceType) params.resourceType = resourceType
      if (action) params.action = action
      await auditExportApi.download(format, params)
    } catch (err: any) {
      error('Export failed', getApiErrorMessage(err, 'Could not export the audit log.'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="inline-flex items-center gap-1.5">
      <Button variant="outline" size="sm" className="h-7 text-xs" disabled={busy !== null} onClick={() => download('csv')}>
        <Download className="h-3.5 w-3.5 mr-1" />
        {busy === 'csv' ? 'Exporting...' : 'CSV'}
      </Button>
      <Button variant="outline" size="sm" className="h-7 text-xs" disabled={busy !== null} onClick={() => download('json')}>
        <Download className="h-3.5 w-3.5 mr-1" />
        {busy === 'json' ? 'Exporting...' : 'JSON'}
      </Button>
    </div>
  )
}

import { TABLE_HEAD_CLASS as TH } from './constants'
import { formatMs, formatNumber } from './format'
import { StatCard } from './stat-card'
import { getApiErrorMessage } from '@/lib/api-error'

/** A figure, or a dash when the query behind it did not answer. */
function auditFigure(summary: any, key: string, value: number | undefined): string {
  if (summary?.unavailable?.includes(key)) return '—'
  return formatNumber(value || 0)
}

export function AuditTab() {
  const { currentOrganization } = useOrganizationStore()
  const [auditPage, setAuditPage] = useState(1)
  const [auditResourceFilter, setAuditResourceFilter] = useState('')
  const [auditActionFilter, setAuditActionFilter] = useState('')

  const {
    data: auditSummary,
    isLoading: loadingAuditSummary,
    isError: summaryError,
    error: summaryErrorObj,
    refetch: refetchSummary,
  } = useQuery({
    queryKey: ['analytics-audit-summary', currentOrganization?.id],
    queryFn: () => analyticsApi.getAuditSummary(),
    enabled: !!currentOrganization,
    refetchInterval: 30000,
  })

  const {
    data: auditLogs,
    isLoading: loadingAuditLogs,
    isError: logsError,
    error: logsErrorObj,
    refetch: refetchLogs,
  } = useQuery({
    queryKey: [
      'analytics-audit-logs',
      currentOrganization?.id,
      auditPage,
      auditResourceFilter,
      auditActionFilter,
    ],
    queryFn: async () => {
      const params: Record<string, string> = { page: String(auditPage), limit: '25' }
      if (auditResourceFilter) params.resourceType = auditResourceFilter
      if (auditActionFilter) params.action = auditActionFilter
      return auditLogsApi.getAll(params)
    },
    enabled: !!currentOrganization,
  })

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      {loadingAuditSummary ? (
        <div className="flex items-center justify-center h-48">
          <LoadingSpinner size="lg" />
        </div>
      ) : summaryError ? (
        // The summary used to render `null` on failure, so the whole
        // card row vanished with no explanation and nothing to retry.
        <QueryError
          error={summaryErrorObj}
          onRetry={() => refetchSummary()}
          title="Couldn't load the audit summary"
        />
      ) : auditSummary ? (
        <>
          {/*
            "0 events today" and "the query failed" are the same picture
            without this. On a compliance surface that distinction is the
            whole point, so the API now says when a figure could not be
            read and the cards show a dash instead of a confident zero.
          */}
          {auditSummary.partial && (
            <div
              data-testid="audit-summary-partial"
              className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm"
            >
              <Activity className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <p className="text-amber-800 dark:text-amber-300">
                Some figures could not be read just now, so they are shown as &mdash; rather than zero. Reload to try
                again.
              </p>
            </div>
          )}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard
              icon={ScrollText}
              label="Actions Today"
              value={auditFigure(auditSummary, 'today', auditSummary.totals?.today)}
            />
            <StatCard
              icon={Activity}
              label="Actions This Week"
              value={auditFigure(auditSummary, 'thisWeek', auditSummary.totals?.thisWeek)}
            />
            <StatCard
              icon={Activity}
              label="Actions This Month"
              value={auditFigure(auditSummary, 'thisMonth', auditSummary.totals?.thisMonth)}
            />
            <StatCard
              icon={Users}
              label="Active Users"
              value={auditFigure(auditSummary, 'topUsers', auditSummary.topUsers?.length)}
            />
          </div>

          {/* Breakdown cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">By Resource Type</CardTitle>
              </CardHeader>
              <CardContent>
                {auditSummary.byResourceType?.length > 0 ? (
                  <div className="space-y-2">
                    {auditSummary.byResourceType.map((r: any) => (
                      <div key={r.resourceType} className="flex items-center justify-between py-1">
                        <Badge variant="outline" className="text-xs capitalize">
                          {r.resourceType.replace('_', ' ')}
                        </Badge>
                        <span className="text-sm font-medium">{formatNumber(r.count)}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-4">No data</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Top Users</CardTitle>
              </CardHeader>
              <CardContent>
                {auditSummary.topUsers?.length > 0 ? (
                  <div className="space-y-2">
                    {auditSummary.topUsers.map((u: any) => (
                      <div key={u.userId} className="flex items-center justify-between py-1">
                        <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                          {u.userEmail || u.userId?.slice(0, 8)}
                        </span>
                        <span className="text-sm font-medium">{formatNumber(u.count)}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-4">No data</p>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      ) : null}

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1.5">
          <Filter className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Resource:</span>
          <select
            value={auditResourceFilter}
            onChange={(e) => {
              setAuditResourceFilter(e.target.value)
              setAuditPage(1)
            }}
            className="text-xs border rounded px-2 py-1 bg-background"
            aria-label="Filter by resource type"
          >
            <option value="">All</option>
            <option value="agent">Agent</option>
            <option value="agent_run">Agent Run</option>
            <option value="tool">Tool</option>
            <option value="gateway">Gateway</option>
            <option value="api">API</option>
            <option value="memory">Memory</option>
            <option value="file">File</option>
            <option value="interface">Interface</option>
            <option value="credential">Credential</option>
            <option value="user">User</option>
            <option value="organization">Organization</option>
            <option value="llm_provider">Provider</option>
            <option value="llm_session">Model call</option>
          </select>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Action:</span>
          <select
            value={auditActionFilter}
            onChange={(e) => {
              setAuditActionFilter(e.target.value)
              setAuditPage(1)
            }}
            className="text-xs border rounded px-2 py-1 bg-background"
            aria-label="Filter by action"
          >
            <option value="">All</option>
            <option value="create">Create</option>
            <option value="update">Update</option>
            <option value="delete">Delete</option>
            <option value="execute">Execute</option>
            <option value="invoke">Invoke</option>
            <option value="activate">Activate</option>
            <option value="deactivate">Deactivate</option>
            <option value="tool_execute">Tool Execute</option>
            <option value="run_start">Run Start</option>
            <option value="run_complete">Run Complete</option>
            <option value="run_fail">Run Fail</option>
            <option value="login">Login</option>
          </select>
        </div>
        {(auditResourceFilter || auditActionFilter) && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs"
            onClick={() => {
              setAuditResourceFilter('')
              setAuditActionFilter('')
              setAuditPage(1)
            }}
          >
            Clear filters
          </Button>
        )}

        <div className="ml-auto">
          <EntitlementGate
            feature="audit_export"
            mode="lock"
            fallback={<AuditExportLocked />}
          >
            <AuditExportButtons resourceType={auditResourceFilter} action={auditActionFilter} />
          </EntitlementGate>
        </div>
      </div>

      {/* Audit log table */}
      {loadingAuditLogs ? (
        <div className="flex items-center justify-center h-48">
          <LoadingSpinner size="lg" />
        </div>
      ) : logsError ? (
        // A failed fetch used to fall through to "No audit log entries
        // yet". On a compliance surface an unreadable log must never be
        // presented as an empty one.
        <QueryError
          error={logsErrorObj}
          onRetry={() => refetchLogs()}
          title="Couldn't load the audit log"
        />
      ) : auditLogs?.data?.length > 0 ? (
        <>
          <div className="rounded-lg border bg-card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left bg-muted">
                  <th className={TH}>Time</th>
                  <th className={TH}>User</th>
                  <th className={TH}>Action</th>
                  <th className={TH}>Resource</th>
                  <th className={TH}>Name</th>
                  <th className={TH}>Status</th>
                  <th className={`${TH} text-right`}>Duration</th>
                  <th className={TH}>IP</th>
                </tr>
              </thead>
              <tbody>
                {auditLogs.data.map((entry: AuditLogEntry) => (
                  <tr key={entry.id} className="border-b last:border-0 hover:bg-muted/30 text-xs">
                    <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                      {new Date(entry.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground truncate max-w-[150px]">
                      {entry.userEmail || entry.userId?.slice(0, 8) || '--'}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="outline" className="text-[10px] capitalize">
                        {entry.action.replace(/_/g, ' ')}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="secondary" className="text-[10px] capitalize">
                        {entry.resourceType.replace(/_/g, ' ')}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 font-medium truncate max-w-[200px]">
                      {entry.resourceName || entry.resourceId?.slice(0, 8) || '--'}
                    </td>
                    <td className="px-4 py-3">
                      {entry.status ? (
                        <span
                          className={cn(
                            'font-medium',
                            entry.status === 'success'
                              ? 'text-green-600 dark:text-green-400'
                              : entry.status === 'error'
                                ? 'text-red-600 dark:text-red-400'
                                : 'text-muted-foreground',
                          )}
                        >
                          {entry.status}
                        </span>
                      ) : (
                        '--'
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-muted-foreground">
                      {entry.duration ? formatMs(entry.duration) : '--'}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground font-mono">
                      {entry.ipAddress || '--'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              Page {auditLogs.pagination?.page || auditLogs.page || 1} of{' '}
              {auditLogs.pagination?.totalPages || auditLogs.totalPages || 1} (
              {auditLogs.pagination?.total || auditLogs.total || 0} total)
            </span>
            <div className="flex gap-1">
              <Button
                variant="outline"
                size="sm"
                disabled={auditPage <= 1}
                onClick={() => setAuditPage((p) => p - 1)}
              >
                Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={auditPage >= (auditLogs.pagination?.totalPages || auditLogs.totalPages || 1)}
                onClick={() => setAuditPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      ) : (
        <div className="text-center py-12">
          <ScrollText className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm font-medium text-muted-foreground">No audit log entries yet</p>
          <p className="text-xs text-muted-foreground mt-1">
            Audit events will appear here as actions are performed in the system.
          </p>
        </div>
      )}
    </div>
  )
}
