import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Activity, Download, Filter, Lock, ScrollText, Users } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
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
      error('Export failed', err?.response?.data?.message || 'Could not export the audit log.')
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

import { formatMs, formatNumber } from './format'
import { StatCard } from './stat-card'

export function AuditTab() {
  const { currentOrganization } = useOrganizationStore()
  const [auditPage, setAuditPage] = useState(1)
  const [auditResourceFilter, setAuditResourceFilter] = useState('')
  const [auditActionFilter, setAuditActionFilter] = useState('')

  const { data: auditSummary, isLoading: loadingAuditSummary } = useQuery({
    queryKey: ['analytics-audit-summary', currentOrganization?.id],
    queryFn: () => analyticsApi.getAuditSummary(),
    enabled: !!currentOrganization,
    refetchInterval: 30000,
  })

  const { data: auditLogs, isLoading: loadingAuditLogs } = useQuery({
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
      ) : auditSummary ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard
              icon={ScrollText}
              label="Actions Today"
              value={formatNumber(auditSummary.totals?.today || 0)}
            />
            <StatCard
              icon={Activity}
              label="Actions This Week"
              value={formatNumber(auditSummary.totals?.thisWeek || 0)}
            />
            <StatCard
              icon={Activity}
              label="Actions This Month"
              value={formatNumber(auditSummary.totals?.thisMonth || 0)}
            />
            <StatCard
              icon={Users}
              label="Active Users"
              value={String(auditSummary.topUsers?.length || 0)}
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
            <option value="llm_provider">LLM Provider</option>
            <option value="llm_session">LLM Session</option>
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
      ) : auditLogs?.data?.length > 0 ? (
        <>
          <div className="rounded-lg border bg-card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground bg-muted">
                  <th className="px-3 py-2 font-medium">Time</th>
                  <th className="px-3 py-2 font-medium">User</th>
                  <th className="px-3 py-2 font-medium">Action</th>
                  <th className="px-3 py-2 font-medium">Resource</th>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium text-right">Duration</th>
                  <th className="px-3 py-2 font-medium">IP</th>
                </tr>
              </thead>
              <tbody>
                {auditLogs.data.map((entry: AuditLogEntry) => (
                  <tr key={entry.id} className="border-b last:border-0 hover:bg-muted/30 text-xs">
                    <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                      {new Date(entry.createdAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground truncate max-w-[150px]">
                      {entry.userEmail || entry.userId?.slice(0, 8) || '--'}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant="outline" className="text-[10px] capitalize">
                        {entry.action.replace(/_/g, ' ')}
                      </Badge>
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant="secondary" className="text-[10px] capitalize">
                        {entry.resourceType.replace(/_/g, ' ')}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 font-medium truncate max-w-[200px]">
                      {entry.resourceName || entry.resourceId?.slice(0, 8) || '--'}
                    </td>
                    <td className="px-3 py-2">
                      {entry.status ? (
                        <span
                          className={cn(
                            'font-medium',
                            entry.status === 'success'
                              ? 'text-green-600'
                              : entry.status === 'error'
                                ? 'text-red-600'
                                : 'text-muted-foreground',
                          )}
                        >
                          {entry.status}
                        </span>
                      ) : (
                        '--'
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-muted-foreground">
                      {entry.duration ? formatMs(entry.duration) : '--'}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground font-mono">
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
