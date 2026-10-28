import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Trash2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { EntitlementGate } from '@/components/entitlement-gate'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { UpgradePrompt } from '@/components/plan-indicator'
import { api } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { formatRelativeTime } from '@/lib/utils'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { useLeaveGuard } from '@/hooks/use-leave-guard'

/**
 * Stream the audit log to a SIEM.
 *
 * The backend has been complete and unreachable: an organization could
 * not configure a target without calling the API by hand, which is not a
 * feature anyone bought. Behind the same entitlement as the rest of the
 * audit pack, so an ungranted org sees the upgrade prompt and never fires
 * a request the guard would refuse.
 *
 * Each target says whether its last delivery worked (and the error when it
 * did not), which actions it streams, and can be changed in place.
 */
const FEATURE = 'audit_export'

const TARGETS = [
  { value: 'webhook', label: 'Webhook', hint: 'Any HTTPS endpoint that accepts JSON' },
  { value: 'splunk_hec', label: 'Splunk HEC', hint: 'HTTP Event Collector' },
  { value: 'datadog', label: 'Datadog', hint: 'Logs intake' },
] as const

interface StreamConfig {
  id: string
  target: string
  endpoint: string
  actionFilter?: string[] | null
  enabled?: boolean
  hasToken?: boolean
  lastDeliveredAt?: string | null
  lastError?: string | null
  createdAt?: string
}

/** "approval_decided, sso_login" -> ['approval_decided', 'sso_login']; blank -> []. */
export function parseActionFilter(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))]
}

/** How a target's deliveries are going, in words. */
export function deliveryStatus(row: StreamConfig): { tone: 'ok' | 'error' | 'idle'; text: string } {
  if (row.lastError) {
    return {
      tone: 'error',
      text: row.lastDeliveredAt
        ? `Last delivery failed: ${row.lastError} (last success ${formatRelativeTime(row.lastDeliveredAt)})`
        : `Last delivery failed: ${row.lastError}`,
    }
  }
  if (row.lastDeliveredAt) return { tone: 'ok', text: `Delivered ${formatRelativeTime(row.lastDeliveredAt)}` }
  return { tone: 'idle', text: 'Nothing sent yet' }
}

export function AuditStreamsSettings() {
  return (
    <EntitlementGate
      feature={FEATURE}
      mode="lock"
      fallback={
        <UpgradePrompt
          feature={FEATURE}
          title="Audit streaming"
          description="Send every audit event to Splunk, Datadog or a webhook as it happens, instead of exporting the log by hand."
        />
      }
    >
      <AuditStreams />
    </EntitlementGate>
  )
}

function AuditStreams() {
  const queryClient = useQueryClient()
  // The target being changed, or null while the form adds a new one.
  const [editing, setEditing] = useState<StreamConfig | null>(null)
  const [target, setTarget] = useState<string>('webhook')
  const [endpoint, setEndpoint] = useState('')
  const [token, setToken] = useState('')
  const [clearToken, setClearToken] = useState(false)
  const [actions, setActions] = useState('')
  const [enabled, setEnabled] = useState(true)

  const streams = useQuery({
    queryKey: ['audit-streams'],
    queryFn: async () => (await api.get('/audit-export/streams')).data.data as StreamConfig[],
  })

  const reset = () => {
    setEditing(null)
    setTarget('webhook')
    setEndpoint('')
    setToken('')
    setClearToken(false)
    setActions('')
    setEnabled(true)
  }

  const startEditing = (row: StreamConfig) => {
    setEditing(row)
    setTarget(row.target)
    setEndpoint(row.endpoint)
    setToken('')
    setClearToken(false)
    setActions((row.actionFilter ?? []).join(', '))
    setEnabled(row.enabled !== false)
  }

  const save = useMutation({
    mutationFn: async () => {
      const filter = parseActionFilter(actions)
      if (editing) {
        const patch: Record<string, unknown> = { endpoint: endpoint.trim(), actionFilter: filter, enabled }
        if (token.trim()) patch.token = token.trim()
        else if (clearToken) patch.token = ''
        return (await api.patch(`/audit-export/streams/${editing.id}`, patch)).data.data
      }
      return (
        await api.post('/audit-export/streams', {
          target,
          endpoint: endpoint.trim(),
          ...(token.trim() ? { token: token.trim() } : {}),
          ...(filter.length ? { actionFilter: filter } : {}),
        })
      ).data.data
    },
    onSuccess: () => {
      reset()
      queryClient.invalidateQueries({ queryKey: ['audit-streams'] })
    },
  })

  const remove = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/audit-export/streams/${id}`)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['audit-streams'] }),
  })

  const rows = streams.data ?? []
  const chosen = TARGETS.find((t) => t.value === target)
  // An endpoint that is not https would send audit events, which name who
  // did what, over the open wire.
  const insecure = endpoint.trim().startsWith('http://')
  const canSave = endpoint.trim().length > 0 && !insecure && !save.isPending

  const { confirm, dialog: confirmDialog } = useConfirm()
  // A target typed in (or being changed) but not saved asks before a
  // navigation throws it away; saving clears the fields, so a saved one
  // does not.
  const guard = useLeaveGuard(!save.isPending && (editing !== null || endpoint !== '' || token !== '' || actions !== ''))
  return (
    <Card>
      <CardHeader>
        <CardTitle>Audit streaming</CardTitle>
        <CardDescription>
          Every audit event is delivered as it happens. Events name who did what, so a target here should be one you control.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {rows.length > 0 && (
          <div className="space-y-2" data-testid="audit-streams">
            {rows.map((row) => {
              const status = deliveryStatus(row)
              return (
                <div key={row.id} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3">
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                      {TARGETS.find((t) => t.value === row.target)?.label ?? row.target}
                      {row.enabled === false && (
                        <Badge variant="outline" className="text-muted-foreground">Off</Badge>
                      )}
                    </div>
                    <div className="truncate font-mono text-xs text-muted-foreground">{row.endpoint}</div>
                    <div className="text-xs text-muted-foreground" data-testid={`stream-filter-${row.id}`}>
                      {row.actionFilter?.length ? `Only: ${row.actionFilter.join(', ')}` : 'Every action'}
                    </div>
                    <div
                      data-testid={`stream-status-${row.id}`}
                      className={
                        status.tone === 'error'
                          ? 'break-words text-xs text-red-600 dark:text-red-400'
                          : status.tone === 'ok'
                            ? 'text-xs text-emerald-600 dark:text-emerald-400'
                            : 'text-xs text-muted-foreground'
                      }
                    >
                      {status.text}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Edit audit stream ${row.endpoint}`}
                      data-testid={`edit-stream-${row.id}`}
                      onClick={() => startEditing(row)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove audit stream ${row.endpoint}`}
                      data-testid={`remove-stream-${row.id}`}
                      disabled={remove.isPending}
                      onClick={async () => {
                        const ok = await confirm({
                          title: 'Remove this audit stream?',
                          description: `Audit events stop being sent to ${row.endpoint}.`,
                          confirmLabel: 'Remove stream',
                          destructive: true,
                        })
                        if (ok) remove.mutate(row.id)
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {remove.isError && (
          // A refused removal left the row in place with no reason
          // given, which reads as a dead button.
          <p data-testid="remove-stream-error" className="text-xs text-red-600 dark:text-red-400">
            {getApiErrorMessage(remove.error, 'The target was not removed.')}
          </p>
        )}

        {rows.length === 0 && !streams.isLoading && (
          <p className="text-sm text-muted-foreground" data-testid="no-streams">
            No target configured. Audit events are still recorded and can be exported from Analytics; this sends them onward
            as they happen.
          </p>
        )}

        {editing && (
          <p className="text-sm font-medium text-foreground" data-testid="editing-stream">
            Changing the {TARGETS.find((t) => t.value === editing.target)?.label ?? editing.target} target
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
          <div>
            <Label htmlFor="stream-target">Target</Label>
            <Select value={target} onValueChange={setTarget} disabled={!!editing}>
              <SelectTrigger id="stream-target" className="mt-1" aria-label="Target">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TARGETS.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="stream-endpoint">Endpoint</Label>
            <Input
              id="stream-endpoint"
              className="mt-1"
              placeholder="https://http-intake.logs.datadoghq.com/api/v2/logs"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
            />
            <p className="mt-1 text-xs text-muted-foreground">{chosen?.hint}</p>
            {insecure && (
              <p data-testid="stream-insecure" className="mt-1 text-xs text-red-600 dark:text-red-400">
                Use https. Audit events name who did what, and this would send them in the clear.
              </p>
            )}
          </div>
        </div>

        <div>
          <Label htmlFor="stream-token">Token (optional)</Label>
          <Input
            id="stream-token"
            className="mt-1"
            type="password"
            placeholder={editing?.hasToken ? 'Leave blank to keep the current token' : "Sent as the target's auth header"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          {editing?.hasToken && !token && (
            <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox checked={clearToken} onCheckedChange={(checked) => setClearToken(checked === true)} />
              Remove the current token
            </label>
          )}
        </div>

        <div>
          <Label htmlFor="stream-actions">Only these actions (optional)</Label>
          <Input
            id="stream-actions"
            className="mt-1"
            placeholder="approval_decided, sso_login, member_role_change"
            value={actions}
            onChange={(e) => setActions(e.target.value)}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Action names as the audit trail shows them, separated by commas. Leave blank to stream every action.
          </p>
        </div>

        {editing && (
          <div className="flex items-center justify-between gap-4 rounded-md border p-3">
            <div>
              <Label htmlFor="stream-enabled">On</Label>
              <p className="text-xs text-muted-foreground">A target that is off is kept but sent nothing.</p>
            </div>
            <Switch id="stream-enabled" checked={enabled} onCheckedChange={setEnabled} />
          </div>
        )}

        {save.isError && (
          <p data-testid="stream-error" className="text-xs text-red-600 dark:text-red-400">
            {getApiErrorMessage(save.error, editing ? 'Could not save that target' : 'Could not add that target')}
          </p>
        )}

        <div className="flex gap-2">
          <Button data-testid="add-stream" disabled={!canSave} onClick={() => save.mutate()}>
            {save.isPending ? (editing ? 'Saving...' : 'Adding...') : editing ? 'Save changes' : 'Add target'}
          </Button>
          {editing && (
            <Button variant="outline" data-testid="cancel-edit-stream" onClick={reset}>
              Cancel
            </Button>
          )}
        </div>
      </CardContent>
      {confirmDialog}
      {guard.element}
    </Card>
  )
}
