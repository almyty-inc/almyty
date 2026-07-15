import React, { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useNotifications } from '@/store/app'
import { organizationsApi } from '@/lib/api'

const RETENTION_MIN_DAYS = 1
const RETENTION_MAX_DAYS = 3650

const DATA_CLASSES = [
  { key: 'agentRunsDays', label: 'Agent runs', hint: 'Completed, failed, cancelled and timed-out runs. Active runs are never deleted.' },
  { key: 'conversationsDays', label: 'Conversations', hint: 'Conversations and all of their messages.' },
  { key: 'requestLogsDays', label: 'Request logs', hint: 'Gateway request/response logs.' },
  { key: 'usageMetricsDays', label: 'Usage metrics', hint: 'Per-request usage and cost metrics.' },
  { key: 'auditLogDays', label: 'Audit log', hint: 'The audit trail itself. Consider your compliance obligations before limiting this.' },
] as const

type DayField = typeof DATA_CLASSES[number]['key']

type RetentionForm = Record<DayField, number | ''> & { enabled: boolean }

const EMPTY_FORM: RetentionForm = {
  enabled: true,
  agentRunsDays: '',
  conversationsDays: '',
  requestLogsDays: '',
  usageMetricsDays: '',
  auditLogDays: '',
}

export function DataRetentionCard({ organizationId }: { organizationId?: string }) {
  const { success, error } = useNotifications()
  const queryClient = useQueryClient()
  const [form, setForm] = useState<RetentionForm>(EMPTY_FORM)

  const { data: policy, isLoading } = useQuery({
    queryKey: ['retention-policy', organizationId],
    queryFn: () => organizationsApi.getRetention(organizationId!),
    enabled: !!organizationId,
  })

  // Initialize form values when the policy loads
  React.useEffect(() => {
    if (!policy) return
    setForm({
      enabled: policy.enabled !== false,
      agentRunsDays: policy.agentRunsDays ?? '',
      conversationsDays: policy.conversationsDays ?? '',
      requestLogsDays: policy.requestLogsDays ?? '',
      usageMetricsDays: policy.usageMetricsDays ?? '',
      auditLogDays: policy.auditLogDays ?? '',
    })
  }, [policy])

  const updateMutation = useMutation({
    mutationFn: (data: Parameters<typeof organizationsApi.updateRetention>[1]) =>
      organizationsApi.updateRetention(organizationId!, data),
    onSuccess: async () => {
      success('Retention policy saved', 'Data older than the configured limits will be deleted by the hourly sweep.')
      await queryClient.invalidateQueries({ queryKey: ['retention-policy', organizationId] })
    },
    onError: (err: any) => {
      error('Failed to save retention policy', err.response?.data?.message || 'Please try again.')
    },
  })

  if (!organizationId) return null

  const setDays = (key: DayField, raw: string) => {
    setForm((prev) => ({ ...prev, [key]: raw === '' ? '' : parseInt(raw, 10) }))
  }

  const handleSave = () => {
    for (const { key, label } of DATA_CLASSES) {
      const value = form[key]
      if (value === '') continue
      if (!Number.isInteger(value) || value < RETENTION_MIN_DAYS || value > RETENTION_MAX_DAYS) {
        error('Invalid retention period', `${label} must be between ${RETENTION_MIN_DAYS} and ${RETENTION_MAX_DAYS} days, or empty to keep forever.`)
        return
      }
    }
    updateMutation.mutate({
      enabled: form.enabled,
      agentRunsDays: form.agentRunsDays === '' ? null : form.agentRunsDays,
      conversationsDays: form.conversationsDays === '' ? null : form.conversationsDays,
      requestLogsDays: form.requestLogsDays === '' ? null : form.requestLogsDays,
      usageMetricsDays: form.usageMetricsDays === '' ? null : form.usageMetricsDays,
      auditLogDays: form.auditLogDays === '' ? null : form.auditLogDays,
    })
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>Data Retention</CardTitle>
          <CardDescription>
            How long each data class is kept before it is automatically deleted. Leave a field empty to keep that data forever.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="retention-enabled" className="text-sm font-medium text-muted-foreground">Enabled</Label>
          <Switch
            id="retention-enabled"
            checked={form.enabled}
            onCheckedChange={(checked) => setForm((prev) => ({ ...prev, enabled: checked }))}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading retention policy...</div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {DATA_CLASSES.map(({ key, label, hint }) => (
                <div key={key} className="space-y-2">
                  <Label htmlFor={`retention-${key}`} className="text-sm font-medium text-muted-foreground">
                    {label} (days)
                  </Label>
                  <Input
                    id={`retention-${key}`}
                    type="number"
                    min={RETENTION_MIN_DAYS}
                    max={RETENTION_MAX_DAYS}
                    value={form[key]}
                    onChange={(e) => setDays(key, e.target.value)}
                    placeholder="Keep forever"
                    disabled={!form.enabled}
                  />
                  <p className="text-xs text-muted-foreground">{hint}</p>
                </div>
              ))}
            </div>

            <Button onClick={handleSave} disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving...' : 'Save Retention Policy'}
            </Button>

            <p className="text-xs text-muted-foreground border-t pt-4">
              We use cookieless product analytics (PostHog, hosted in the EU)
              to understand how the app is used and improve it. No advertising
              cookies are set.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}
