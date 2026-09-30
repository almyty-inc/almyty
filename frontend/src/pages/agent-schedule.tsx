/**
 * /agents/:id/schedule -- when an agent runs on its own, and where the
 * result goes.
 *
 * A schedule is a time of day on chosen days (every day, weekdays, or the
 * days picked), a day of the month, or every few minutes, in a time zone
 * (the person's own from their profile until they pick another). The
 * result can go to the agent's webhook or into one of its channels: a
 * Slack channel, a Teams chat, email addresses, a phone number. The page
 * says the schedule back in plain words with its next runs, as the
 * server works them out (daylight saving included).
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock } from 'lucide-react'

import { Field, FormPage, FormSection } from '@/components/layout/form-page'
import { WithAgent } from '@/components/channels/channel-page-loader'
import { TimeZoneSelect, browserTimeZone } from '@/components/settings/time-zone-select'
import { CodeEditor } from '@/components/ui/code-editor'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { agentsApi, authApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { CHANNEL_LABELS } from '@/lib/agent-channels'
import {
  DAY_NAMES,
  EVERY_DAY,
  WEEKDAYS,
  WEEK_ORDER,
  dayChoiceOf,
  describeSchedule,
  formatRunTime,
  type AgentSchedule,
  type DayChoice,
  type DeliveryOptions,
  type PostChannelOption,
  type ScheduleKind,
  type ScheduleRequest,
} from '@/lib/schedule'
import { cn } from '@/lib/utils'
import { useNotifications } from '@/store/app'
import type { Agent } from '@/types'

/** Where the result goes, as the form holds it. */
type Target = 'none' | 'webhook' | `channel:${string}`

/** "Sales Slack (Slack)", or just "Slack" when the channel is named after its platform. */
function channelLabel(c: PostChannelOption): string {
  const platform = CHANNEL_LABELS[c.type as keyof typeof CHANNEL_LABELS] ?? c.type
  return c.name === platform ? c.name : `${c.name} (${platform})`
}
/** "Enter another" in a destination list. */
const ENTER_OWN = '__enter__'

export interface ScheduleForm {
  kind: ScheduleKind
  time: string
  dayChoice: DayChoice
  days: number[]
  dayOfMonth: number
  timezone: string
  every: number
  unit: 'minutes' | 'hours'
  target: Target
  /** The destination picked from the list, or ENTER_OWN. */
  pick: string
  /** The destination typed. */
  typed: string
  input: string
}

/** The form a stored schedule opens as; a new one starts at weekdays, 9:00, in the person's zone. */
export function formFromSchedule(schedule: AgentSchedule | null | undefined, zone: string): ScheduleForm {
  const kind: ScheduleKind = schedule?.kind ?? (schedule ? 'interval' : 'days')
  const minutes = schedule?.intervalMinutes ?? 60
  const deliverTo = schedule?.deliverTo
  const target: Target = !deliverTo ? 'none' : deliverTo.kind === 'webhook' ? 'webhook' : `channel:${deliverTo.channelId}`
  const days = schedule?.days?.length ? schedule.days : WEEKDAYS
  return {
    kind,
    time: schedule?.time ?? '09:00',
    dayChoice: dayChoiceOf(days),
    days,
    dayOfMonth: schedule?.dayOfMonth ?? 1,
    timezone: schedule?.timezone ?? zone,
    every: minutes % 60 === 0 ? minutes / 60 : minutes,
    unit: minutes % 60 === 0 ? 'hours' : 'minutes',
    target,
    pick: deliverTo?.kind === 'channel' ? (deliverTo.to ?? '') : '',
    typed: deliverTo?.kind === 'channel' ? (deliverTo.to ?? '') : '',
    input: JSON.stringify(schedule?.input ?? {}, null, 2),
  }
}

/** The days a form's choice stands for. */
function daysOf(form: ScheduleForm): number[] {
  if (form.dayChoice === 'every_day') return EVERY_DAY
  if (form.dayChoice === 'weekdays') return WEEKDAYS
  return [...form.days].sort((a, b) => a - b)
}

/** The timing half of a request, which the preview and the save share. */
export function timingFromForm(form: ScheduleForm): ScheduleRequest {
  if (form.kind === 'interval') {
    return { kind: 'interval', intervalMinutes: form.unit === 'hours' ? form.every * 60 : form.every }
  }
  if (form.kind === 'monthly') {
    return { kind: 'monthly', time: form.time, dayOfMonth: form.dayOfMonth, timezone: form.timezone }
  }
  return { kind: 'days', time: form.time, days: daysOf(form), timezone: form.timezone }
}

/** Whether the destination of a channel is typed, given what the channel offers and what was picked. */
function typesDestination(channel: PostChannelOption | undefined, form: ScheduleForm): boolean {
  if (!channel) return false
  if (channel.choose === 'enter') return true
  if (channel.choose === 'pick_or_enter') return channel.destinations.length === 0 || form.pick === ENTER_OWN
  return false
}

/** The whole request, or the sentence that says what is missing. */
export function requestFromForm(
  form: ScheduleForm,
  options: DeliveryOptions | undefined,
): { request?: ScheduleRequest; error?: string } {
  let input: Record<string, any>
  try {
    input = form.input.trim() ? JSON.parse(form.input) : {}
  } catch {
    return { error: 'What the agent is given has to be valid JSON, or {} for nothing.' }
  }
  if (form.kind === 'interval' && !(form.every >= 1)) return { error: 'Choose how often it runs.' }
  if (form.kind === 'days' && daysOf(form).length === 0) return { error: 'Pick at least one day.' }
  const request: ScheduleRequest = { ...timingFromForm(form), input, deliverTo: null }
  if (form.target === 'webhook') request.deliverTo = { kind: 'webhook' }
  if (form.target.startsWith('channel:')) {
    const channelId = form.target.slice('channel:'.length)
    const channel = options?.channels.find((c) => c.channelId === channelId)
    if (!channel) return { error: 'That channel is not available any more. Choose another.' }
    if (channel.choose === 'fixed') {
      request.deliverTo = { kind: 'channel', channelId }
    } else if (typesDestination(channel, form)) {
      if (!form.typed.trim()) return { error: `Enter the ${channel.noun.toLowerCase()}.` }
      request.deliverTo = { kind: 'channel', channelId, to: form.typed.trim() }
    } else {
      const picked = channel.destinations.find((d) => d.to === form.pick)
      if (!picked) return { error: `Choose the ${channel.noun.toLowerCase()}.` }
      request.deliverTo = { kind: 'channel', channelId, to: picked.to, label: picked.label }
    }
  }
  return { request }
}

export function AgentSchedulePage() {
  const { id = '' } = useParams<{ id: string }>()
  return <WithAgent agentId={id}>{(agent) => <Loaded agent={agent} />}</WithAgent>
}

function Loaded({ agent }: { agent: Agent }) {
  const profile = useQuery({ queryKey: ['user-profile'], queryFn: () => authApi.getProfile() })
  if (profile.isLoading) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner />
      </div>
    )
  }
  const zone = (profile.data as any)?.timezone || browserTimeZone() || 'UTC'
  return <SchedulePage agent={agent} zone={zone} />
}

function SchedulePage({ agent, zone }: { agent: Agent; zone: string }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  const back = `/agents/${agent.id}`
  const initial = useMemo(() => formFromSchedule(agent.settings?.schedule, zone), [agent, zone])
  const [form, setForm] = useState<ScheduleForm>(initial)
  const [problem, setProblem] = useState<string | null>(null)
  const dirty = JSON.stringify(form) !== JSON.stringify(initial)
  const guard = useLeaveGuard(dirty)
  const set = (patch: Partial<ScheduleForm>) => {
    setProblem(null)
    setForm((f) => ({ ...f, ...patch }))
  }

  const options = useQuery({
    queryKey: ['agent-schedule-destinations', agent.id],
    queryFn: () => agentsApi.scheduleDestinations(agent.id),
  })

  // What the schedule does, in the server's words, as the person chooses.
  const timing = timingFromForm(form)
  const timingKey = JSON.stringify(timing)
  const [debouncedKey, setDebouncedKey] = useState(timingKey)
  useEffect(() => {
    const t = setTimeout(() => setDebouncedKey(timingKey), 300)
    return () => clearTimeout(t)
  }, [timingKey])
  const preview = useQuery({
    queryKey: ['agent-schedule-preview', agent.id, debouncedKey],
    queryFn: () => agentsApi.previewSchedule(agent.id, JSON.parse(debouncedKey)),
    enabled: form.kind !== 'interval',
    retry: false,
  })

  const save = useMutation({
    mutationFn: (request: ScheduleRequest) => agentsApi.schedule(agent.id, request),
    onSuccess: async () => {
      success('Schedule saved', describeSchedule(timing))
      await queryClient.invalidateQueries({ queryKey: ['agent', agent.id] })
      await queryClient.invalidateQueries({ queryKey: ['agent-schedule', agent.id] })
      guard.leave(back)
    },
    onError: (err: unknown) => errorNotif('Could not save the schedule', getApiErrorMessage(err, 'Please try again.')),
  })

  const submit = () => {
    const { request, error } = requestFromForm(form, options.data)
    if (!request) {
      setProblem(error ?? 'Something is missing.')
      return
    }
    save.mutate(request)
  }

  const channel = form.target.startsWith('channel:')
    ? options.data?.channels.find((c) => `channel:${c.channelId}` === form.target)
    : undefined
  const available = options.data?.channels.filter((c) => c.available) ?? []
  const unavailable = options.data?.channels.filter((c) => !c.available) ?? []

  return (
    <FormPage
      title={agent.settings?.schedule ? 'Edit schedule' : 'Set up a schedule'}
      description={`Run ${agent.name} on its own, and choose where the result goes.`}
      back={{ to: back, label: agent.name }}
      guard={guard}
      onSubmit={submit}
      submitLabel="Save schedule"
      submitting={save.isPending}
    >
      <FormSection title="When it runs">
        <Field id="schedule-kind" label="Repeat">
          <Select value={form.kind} onValueChange={(v) => set({ kind: v as ScheduleKind })}>
            <SelectTrigger id="schedule-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="days">At a time of day</SelectItem>
              <SelectItem value="monthly">Once a month</SelectItem>
              <SelectItem value="interval">Every few minutes or hours</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        {form.kind === 'days' && (
          <Field id="schedule-days" label="Days">
            <div id="schedule-days-group" className="space-y-3">
              <Select value={form.dayChoice} onValueChange={(v) => set({ dayChoice: v as DayChoice, days: v === 'specific' ? form.days : daysOf({ ...form, dayChoice: v as DayChoice }) })}>
                <SelectTrigger id="schedule-days">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="every_day">Every day</SelectItem>
                  <SelectItem value="weekdays">Weekdays (Monday to Friday)</SelectItem>
                  <SelectItem value="specific">Choose days</SelectItem>
                </SelectContent>
              </Select>
              {form.dayChoice === 'specific' && (
                <div className="flex flex-wrap gap-2" role="group" aria-label="Days of the week">
                  {WEEK_ORDER.map((d) => {
                    const on = form.days.includes(d)
                    return (
                      <Button
                        key={d}
                        type="button"
                        size="sm"
                        variant={on ? 'default' : 'outline'}
                        aria-pressed={on}
                        onClick={() => set({ days: on ? form.days.filter((x) => x !== d) : [...form.days, d] })}
                      >
                        {DAY_NAMES[d].slice(0, 3)}
                      </Button>
                    )
                  })}
                </div>
              )}
            </div>
          </Field>
        )}

        {form.kind === 'monthly' && (
          <Field id="schedule-day-of-month" label="Day of the month" hint="Up to the 28th, so it runs every month.">
            <Select value={String(form.dayOfMonth)} onValueChange={(v) => set({ dayOfMonth: Number(v) })}>
              <SelectTrigger id="schedule-day-of-month">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {Array.from({ length: 28 }, (_v, i) => i + 1).map((d) => (
                  <SelectItem key={d} value={String(d)}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}

        {form.kind !== 'interval' ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field id="schedule-time" label="Time">
              <Input id="schedule-time" type="time" value={form.time} onChange={(e) => set({ time: e.target.value })} />
            </Field>
            <Field id="schedule-timezone" label="Time zone" hint="Runs at this time there, summer and winter.">
              <TimeZoneSelect id="schedule-timezone" value={form.timezone} onChange={(z) => set({ timezone: z })} />
            </Field>
          </div>
        ) : (
          <Field id="schedule-every" label="Every">
            <div id="schedule-every-group" className="flex gap-2">
              <Input
                id="schedule-every"
                type="number"
                min={1}
                className="w-28"
                value={form.every}
                onChange={(e) => set({ every: parseInt(e.target.value, 10) || 0 })}
              />
              <Select value={form.unit} onValueChange={(v) => set({ unit: v as 'minutes' | 'hours' })}>
                <SelectTrigger className="w-36" aria-label="Unit">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="minutes">minutes</SelectItem>
                  <SelectItem value="hours">hours</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </Field>
        )}

        <div className="flex items-start gap-3 rounded-md border bg-muted/40 p-3" data-testid="schedule-summary">
          <CalendarClock className="mt-0.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <div className="space-y-1 text-sm">
            <p className="font-medium">{describeSchedule(timing)}</p>
            {form.kind !== 'interval' && preview.data?.nextRuns?.length ? (
              <p className="text-muted-foreground">
                Next runs: {preview.data.nextRuns.map((r) => formatRunTime(r, preview.data?.timezone)).join('; ')}
              </p>
            ) : null}
            {form.kind === 'interval' && (
              <p className="text-muted-foreground">Counted from when you save it.</p>
            )}
          </div>
        </div>
      </FormSection>

      <FormSection title="Send the result to" description="The result is always kept in the run history too.">
        <Field id="schedule-target" label="Where">
          <Select value={form.target} onValueChange={(v) => set({ target: v as Target, pick: '', typed: '' })}>
            <SelectTrigger id="schedule-target">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Only the run history</SelectItem>
              <SelectItem value="webhook" disabled={!options.data?.webhookUrl}>
                The agent's webhook{options.data?.webhookUrl ? '' : ' (add a webhook URL first)'}
              </SelectItem>
              {available.map((c) => (
                <SelectItem key={c.channelId} value={`channel:${c.channelId}`}>
                  {channelLabel(c)}
                </SelectItem>
              ))}
              {unavailable.map((c) => (
                <SelectItem key={c.channelId} value={`channel:${c.channelId}`} disabled>
                  {c.name}: {c.reason}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {options.data && options.data.channels.length === 0 && (
          <p className="text-sm text-muted-foreground">
            To post into Slack, Teams, email or a phone, add that channel on the agent's Channels tab first.
          </p>
        )}

        {channel && channel.choose === 'fixed' && <p className="text-sm text-muted-foreground">{channel.hint}</p>}

        {channel && channel.choose !== 'fixed' && channel.choose !== 'enter' && channel.destinations.length > 0 && (
          <Field id="schedule-destination" label={channel.noun} hint={channel.hint}>
            <Select value={form.pick} onValueChange={(v) => set({ pick: v })}>
              <SelectTrigger id="schedule-destination">
                <SelectValue placeholder={`Choose a ${channel.noun.toLowerCase()}`} />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {channel.destinations.map((d) => (
                  <SelectItem key={d.to} value={d.to}>
                    {d.label}
                  </SelectItem>
                ))}
                {channel.choose === 'pick_or_enter' && <SelectItem value={ENTER_OWN}>Enter another</SelectItem>}
              </SelectContent>
            </Select>
          </Field>
        )}

        {channel && channel.choose === 'pick' && channel.destinations.length === 0 && (
          <p className={cn('text-sm text-muted-foreground')}>{channel.hint}</p>
        )}

        {channel && typesDestination(channel, form) && (
          <Field
            id="schedule-destination-typed"
            label={channel.choose === 'enter' || channel.destinations.length === 0 ? channel.noun : `Other ${channel.noun.toLowerCase()}`}
            hint={channel.hint}
          >
            <Input
              id="schedule-destination-typed"
              placeholder={channel.placeholder}
              value={form.typed}
              onChange={(e) => set({ typed: e.target.value })}
            />
          </Field>
        )}
      </FormSection>

      <FormSection
        title="What the agent is given"
        description="The same input every run, written as JSON. Leave {} if the agent needs nothing."
      >
        <CodeEditor value={form.input} onChange={(value) => set({ input: value })} language="json" height="100px" />
      </FormSection>

      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      {!agent.status || agent.status === 'active' ? null : (
        <p className="text-sm text-muted-foreground">
          This agent is not active yet. Activate it first; a schedule on an inactive agent never runs.{' '}
          <Button type="button" variant="link" className="h-auto p-0" onClick={() => navigate(back)}>
            Back to the agent
          </Button>
        </p>
      )}
    </FormPage>
  )
}

export default AgentSchedulePage
