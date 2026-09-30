/**
 * The Schedule card on the agent's overview: the schedule in plain words,
 * its next run, where the result goes, a switch, and the page that edits
 * it (/agents/:id/schedule). Turning it off here keeps what was set, so
 * turning it back on runs it the same way.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Timer, Pencil } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { agentsApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import {
  describeDelivery,
  describeSchedule,
  formatRunTime,
  requestFromStored,
  type AgentSchedule,
  type ChannelDeliveryOutcome,
  type ScheduleDelivery,
} from '@/lib/schedule'
import { useNotifications } from '@/store/app'
import type { Agent } from '@/types'

/** "Posts the result to #sales" / "Sends the result to the agent's webhook". */
export function deliveryWords(deliverTo: ScheduleDelivery | null | undefined): string | null {
  if (!deliverTo) return null
  if (deliverTo.kind === 'webhook') return "Sends the result to the agent's webhook"
  return `Posts the result to ${deliverTo.label || deliverTo.to || 'a channel'}`
}

/**
 * Under a run's status in Recent runs: whether its scheduled result reached
 * its channel, and if not, why (the platform's own words).
 */
export function DeliveryNote({ outcome }: { outcome: ChannelDeliveryOutcome | null | undefined }) {
  const note = describeDelivery(outcome)
  if (!note) return null
  return (
    <p className={note.failed ? 'mt-1 max-w-[260px] text-xs text-destructive' : 'mt-1 max-w-[260px] text-xs text-muted-foreground'}>
      {note.text}
    </p>
  )
}
export function ScheduleCard({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  const [saving, setSaving] = useState(false)
  const schedule = agent.settings?.schedule as AgentSchedule | undefined
  const enabled = !!schedule?.enabled

  const view = useQuery({
    queryKey: ['agent-schedule', agent.id, enabled, schedule?.kind, schedule?.time, schedule?.timezone],
    queryFn: () => agentsApi.getSchedule(agent.id),
    enabled: enabled,
  })

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['agent', agent.id] })
    await queryClient.invalidateQueries({ queryKey: ['agent-schedule', agent.id] })
  }

  const toggle = async (on: boolean) => {
    setSaving(true)
    try {
      if (on && schedule) {
        await agentsApi.schedule(agent.id, requestFromStored(schedule))
        success('Schedule on', describeSchedule(schedule))
      } else {
        await agentsApi.unschedule(agent.id)
        success('Schedule off', 'It keeps its settings for when you turn it back on.')
      }
      await refresh()
    } catch (err) {
      errorNotif('Could not change the schedule', getApiErrorMessage(err, 'Please try again.'))
    } finally {
      setSaving(false)
    }
  }

  const summary = schedule ? describeSchedule(schedule) : null
  const delivery = deliveryWords(schedule?.deliverTo)

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Timer className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-base">Schedule</CardTitle>
        </div>
        <CardDescription className="text-xs">
          Run this agent on its own: at a time of day, once a month, or every few minutes.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!schedule ? (
          <Button asChild size="sm">
            <Link to={`/agents/${agent.id}/schedule`}>Set up a schedule</Link>
          </Button>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="schedule-toggle" className="font-normal">
                <span className="block text-sm font-medium" data-testid="schedule-card-summary">
                  {enabled ? summary : `Off: ${summary}`}
                </span>
              </Label>
              <Switch id="schedule-toggle" checked={enabled} disabled={saving} onCheckedChange={toggle} />
            </div>
            {enabled && view.data?.nextRunAt && (
              <p className="text-xs text-muted-foreground" data-testid="schedule-card-next-run">
                Next run: {formatRunTime(view.data.nextRunAt, schedule.kind && schedule.kind !== 'interval' ? schedule.timezone : null)}
              </p>
            )}
            {delivery && <p className="text-xs text-muted-foreground">{delivery}</p>}
            <Button asChild size="sm" variant="outline">
              <Link to={`/agents/${agent.id}/schedule`}>
                <Pencil className="mr-2 h-4 w-4" />
                Edit schedule
              </Link>
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
