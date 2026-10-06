/**
 * The Always on card: on the agent's overview, and in the builder where the
 * Heartbeat card was. What wakes the agent, what it may do on its own, its
 * last wake and next timer, a switch, "Wake now", and the page that edits
 * it (/agents/:id/always-on). One line says how it differs from a schedule.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Radio, Zap } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { agentsApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { formatRunTime } from '@/lib/schedule'
import { ALWAYS_ON_VS_SCHEDULE, describeActMode, describeWakes, wakeSourceLabel } from '@/lib/always-on'
import { useNotifications } from '@/store/app'
import { pluralized } from '@/lib/utils'

export function AlwaysOnCard({ agentId, unsaved = false }: { agentId?: string; unsaved?: boolean }) {
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  const [busy, setBusy] = useState(false)
  const view = useQuery({
    queryKey: ['agent-always-on', agentId],
    queryFn: () => agentsApi.getAlwaysOn(agentId!),
    enabled: !!agentId,
  })
  const config = view.data?.alwaysOn ?? null
  const setUp = !!config?.brief
  const enabled = !!config?.enabled

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['agent-always-on', agentId] })
    await queryClient.invalidateQueries({ queryKey: ['agent', agentId] })
  }

  const toggle = async (on: boolean) => {
    if (!agentId) return
    setBusy(true)
    try {
      await agentsApi.setAlwaysOn(agentId, { enabled: on })
      success(on ? 'Always on is on' : 'Always on is off', on ? describeWakes(config) : 'It keeps its settings for when you turn it back on.')
      await refresh()
    } catch (err) {
      errorNotif('Could not change Always on', getApiErrorMessage(err, 'Please try again.'))
    } finally {
      setBusy(false)
    }
  }

  const wakeNow = async () => {
    if (!agentId) return
    setBusy(true)
    try {
      await agentsApi.wakeNow(agentId)
      success('Waking it now', 'It picks up its standing conversation in a moment.')
      setTimeout(() => void refresh(), 1500)
    } catch (err) {
      errorNotif('Could not wake it', getApiErrorMessage(err, 'Please try again.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card data-testid="always-on-card">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Radio className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-base">Always on</CardTitle>
        </div>
        <CardDescription className="text-xs">{ALWAYS_ON_VS_SCHEDULE}</CardDescription>
      </CardHeader>
      <CardContent>
        {!agentId || unsaved ? (
          <p className="text-sm text-muted-foreground">Save the agent first, then set up Always on.</p>
        ) : view.isLoading ? null : !setUp ? (
          <Button asChild size="sm">
            <Link to={`/agents/${agentId}/always-on`}>Set up always on</Link>
          </Button>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="always-on-toggle" className="font-normal">
                <span className="block text-sm font-medium" data-testid="always-on-card-summary">
                  {enabled ? describeWakes(config, view.data?.effectiveTimerMinutes) : `Off: ${describeWakes(config, view.data?.effectiveTimerMinutes)}`}
                </span>
                <span className="block text-xs text-muted-foreground">{describeActMode(config)}</span>
              </Label>
              <Switch id="always-on-toggle" checked={enabled} disabled={busy} onCheckedChange={toggle} />
            </div>
            {view.data?.lastWake && (
              <p className="text-xs text-muted-foreground" data-testid="always-on-last-wake">
                Last woke {formatRunTime(view.data.lastWake.at)} ({wakeSourceLabel(view.data.lastWake.source).toLowerCase()}): {view.data.lastWake.summary}
                {view.data.lastWake.runId && (
                  <>
                    {' '}
                    <Link className="underline" to={`/agents/${agentId}/runs/${view.data.lastWake.runId}`}>
                      See the run
                    </Link>
                  </>
                )}
              </p>
            )}
            {enabled && view.data?.nextWakeAt && (
              <p className="text-xs text-muted-foreground" data-testid="always-on-next-wake">
                Next timer: {formatRunTime(view.data.nextWakeAt)}
              </p>
            )}
            {enabled && !!view.data?.queued && (
              <p className="text-xs text-muted-foreground">
                {pluralized(view.data.queued, 'thing')} waiting for it
                {view.data.liveRunId ? ' (it picks them up while it works)' : ''}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button asChild size="sm" variant="outline">
                <Link to={`/agents/${agentId}/always-on`}>
                  <Pencil className="mr-2 h-4 w-4" />
                  Edit always on
                </Link>
              </Button>
              {enabled && (
                <Button size="sm" variant="outline" disabled={busy} onClick={wakeNow}>
                  <Zap className="mr-2 h-4 w-4" />
                  Wake now
                </Button>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
