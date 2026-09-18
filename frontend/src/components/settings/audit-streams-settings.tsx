import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EntitlementGate } from '@/components/entitlement-gate'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { UpgradePrompt } from '@/components/plan-indicator'
import { api } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'

/**
 * Stream the audit log to a SIEM.
 *
 * The backend has been complete and unreachable: an organization could
 * not configure a target without calling the API by hand, which is not a
 * feature anyone bought. Behind the same entitlement as the rest of the
 * audit pack, so an ungranted org sees the upgrade prompt and never fires
 * a request the guard would refuse.
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
  createdAt?: string
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
  const [target, setTarget] = useState<string>('webhook')
  const [endpoint, setEndpoint] = useState('')
  const [token, setToken] = useState('')

  const streams = useQuery({
    queryKey: ['audit-streams'],
    queryFn: async () => (await api.get('/audit-export/streams')).data.data as StreamConfig[],
  })

  const create = useMutation({
    mutationFn: async () =>
      (await api.post('/audit-export/streams', { target, endpoint: endpoint.trim(), ...(token.trim() ? { token: token.trim() } : {}) })).data.data,
    onSuccess: () => {
      setEndpoint('')
      setToken('')
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
  const canAdd = endpoint.trim().length > 0 && !insecure && !create.isPending

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
            {rows.map((row) => (
              <div key={row.id} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">
                    {TARGETS.find((t) => t.value === row.target)?.label ?? row.target}
                  </div>
                  <div className="truncate font-mono text-xs text-muted-foreground">{row.endpoint}</div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove audit stream ${row.endpoint}`}
                  data-testid={`remove-stream-${row.id}`}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(row.id)}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            ))}
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

        <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
          <div>
            <Label htmlFor="stream-target">Target</Label>
            <Select value={target} onValueChange={setTarget}>
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
            placeholder="Sent as the target's auth header"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </div>

        {create.isError && (
          <p data-testid="stream-error" className="text-xs text-red-600 dark:text-red-400">
            {getApiErrorMessage(create.error, 'Could not add that target')}
          </p>
        )}

        <Button data-testid="add-stream" disabled={!canAdd} onClick={() => create.mutate()}>
          {create.isPending ? 'Adding...' : 'Add target'}
        </Button>
      </CardContent>
    </Card>
  )
}
