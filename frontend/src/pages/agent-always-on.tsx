/**
 * /agents/:id/always-on -- an autonomous agent that keeps working in the
 * background (docs/always-on.md).
 *
 * What it keeps doing, what wakes it (a timer, messages on its channels,
 * connection events), where you talk to it yourself, what it may do on its
 * own and what it asks you first, and where it reports. Every wake continues
 * the same conversation. The plan's limits (the shortest timer) come from
 * the server and are said next to the field they bound.
 */
import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { Field, FormPage, FormSection } from '@/components/layout/form-page'
import { WithAgent } from '@/components/channels/channel-page-loader'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { agentsApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { CHANNEL_LABELS, agentChannelsApi, isMessagingChannel, type AgentChannel } from '@/lib/agent-channels'
import {
  ALWAYS_ON_VS_SCHEDULE,
  CONNECTION_EVENT_LABELS,
  type AlwaysOnActMode,
  type AlwaysOnInput,
  type AlwaysOnReport,
  type AlwaysOnView,
  type ConnectionWakeEvent,
  formatWakeTime,
  wakeSourceLabel,
} from '@/lib/always-on'
import type { DeliveryOptions } from '@/lib/schedule'
import { useNotifications } from '@/store/app'
import { pluralized } from '@/lib/utils'
import type { Agent } from '@/types'

const NO_CHANNEL = '__none__'

export interface AlwaysOnForm {
  enabled: boolean
  brief: string
  timerOn: boolean
  every: number
  unit: 'minutes' | 'hours'
  channelIds: string[]
  connectionEvents: ConnectionWakeEvent[]
  ownerChannelId: string
  ownerAddress: string
  /** On an email channel: mail from the owner's address counts as the owner. Off by default. */
  ownerTrustEmail: boolean
  actMode: AlwaysOnActMode
  askFirstToolIds: string[]
  reportChannelId: string
  reportTo: string
  report: AlwaysOnReport
}

/** The form a stored setting opens as; a new one starts off, every 30 minutes, asking first. */
export function formFromView(view: AlwaysOnView | undefined): AlwaysOnForm {
  const c = view?.alwaysOn
  const minutes = c?.wakeOn?.timer?.everyMinutes ?? Math.max(30, view?.capacity.timerFloorMinutes ?? 30)
  return {
    enabled: !!c?.enabled,
    brief: c?.brief ?? '',
    timerOn: c ? !!c.wakeOn?.timer : true,
    every: minutes % 60 === 0 ? minutes / 60 : minutes,
    unit: minutes % 60 === 0 ? 'hours' : 'minutes',
    channelIds: c?.wakeOn?.channelIds ?? [],
    connectionEvents: c?.wakeOn?.connectionEvents ?? [],
    ownerChannelId: c?.ownerChannel?.channelId ?? NO_CHANNEL,
    ownerAddress: c?.ownerChannel?.address ?? '',
    ownerTrustEmail: c?.ownerChannel?.trustEmail === true,
    actMode: c?.actMode ?? 'propose',
    // Pre-filled with what may change something, for when they choose "act".
    askFirstToolIds: c ? c.askFirstToolIds ?? [] : (view?.tools ?? []).filter((t) => !t.readOnly).map((t) => t.id),
    reportChannelId: c?.reportTo?.channelId ?? NO_CHANNEL,
    reportTo: c?.reportTo?.to ?? '',
    report: c?.report ?? 'when_acted',
  }
}

export function minutesOf(form: Pick<AlwaysOnForm, 'every' | 'unit'>): number {
  return form.unit === 'hours' ? form.every * 60 : form.every
}

/** The request a form saves as, or what is missing in words. */
export function inputFromForm(form: AlwaysOnForm, floorMinutes: number): { input?: AlwaysOnInput; error?: string } {
  if (form.enabled && !form.brief.trim()) return { error: 'Say what it should keep doing.' }
  if (form.timerOn) {
    const minutes = minutesOf(form)
    if (!(minutes >= 1)) return { error: 'Choose how often the timer wakes it.' }
    if (minutes < floorMinutes) return { error: `On your plan the timer can wake it every ${pluralized(floorMinutes, 'minute')} at most.` }
  }
  const owner = form.ownerChannelId !== NO_CHANNEL
  if (owner && !form.ownerAddress.trim()) return { error: 'Enter your own address on the channel you talk to it on.' }
  if (form.enabled && !form.timerOn && !form.channelIds.length && !form.connectionEvents.length && !owner) {
    return { error: 'Choose at least one thing that wakes it.' }
  }
  const reports = form.reportChannelId !== NO_CHANNEL
  return {
    input: {
      enabled: form.enabled,
      brief: form.brief.trim(),
      wakeOn: {
        timer: form.timerOn ? { everyMinutes: minutesOf(form) } : null,
        channelIds: form.channelIds,
        connectionEvents: form.connectionEvents,
      },
      ownerChannel: owner
        ? { channelId: form.ownerChannelId, address: form.ownerAddress.trim(), trustEmail: form.ownerTrustEmail }
        : null,
      actMode: form.actMode,
      askFirstToolIds: form.actMode === 'act' ? form.askFirstToolIds : [],
      reportTo: reports
        ? { kind: 'channel', channelId: form.reportChannelId, ...(form.reportTo.trim() ? { to: form.reportTo.trim() } : {}) }
        : null,
      report: form.report,
    },
  }
}

export function AgentAlwaysOnPage() {
  const { id = '' } = useParams<{ id: string }>()
  return <WithAgent agentId={id}>{(agent) => <Loaded agent={agent} />}</WithAgent>
}

function Loaded({ agent }: { agent: Agent }) {
  const view = useQuery({ queryKey: ['agent-always-on', agent.id], queryFn: () => agentsApi.getAlwaysOn(agent.id) })
  const channels = useQuery({ queryKey: ['agent-channels', agent.id], queryFn: () => agentChannelsApi.list(agent.id) })
  const destinations = useQuery({
    queryKey: ['agent-schedule-destinations', agent.id],
    queryFn: () => agentsApi.scheduleDestinations(agent.id),
  })
  if (view.isLoading || channels.isLoading) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner />
      </div>
    )
  }
  return (
    <AlwaysOnPage
      agent={agent}
      view={view.data}
      channels={(channels.data ?? []).filter((c) => isMessagingChannel(c.type))}
      destinations={destinations.data}
    />
  )
}

function channelName(c: AgentChannel): string {
  const platform = CHANNEL_LABELS[c.type] ?? c.type
  return c.name === platform ? c.name : `${c.name} (${platform})`
}

function AlwaysOnPage({
  agent,
  view,
  channels,
  destinations,
}: {
  agent: Agent
  view: AlwaysOnView | undefined
  channels: AgentChannel[]
  destinations: DeliveryOptions | undefined
}) {
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  const back = `/agents/${agent.id}`
  const initial = useMemo(() => formFromView(view), [view])
  const [form, setForm] = useState<AlwaysOnForm>(initial)
  const [problem, setProblem] = useState<string | null>(null)
  const dirty = JSON.stringify(form) !== JSON.stringify(initial)
  const guard = useLeaveGuard(dirty)
  const set = (patch: Partial<AlwaysOnForm>) => {
    setProblem(null)
    setForm((f) => ({ ...f, ...patch }))
  }
  const toggleIn = <T,>(list: T[], value: T, on: boolean) => (on ? [...new Set([...list, value])] : list.filter((v) => v !== value))

  const floor = view?.capacity.timerFloorMinutes ?? 15
  const tools = view?.tools ?? []
  const writeChannels = channels.filter((c) => c.type !== 'webhook')
  const ownerChannel = channels.find((c) => c.id === form.ownerChannelId)
  const reportChannel = destinations?.channels.find((c) => c.channelId === form.reportChannelId)

  const wakes = useQuery({
    queryKey: ['agent-always-on-wakes', agent.id],
    queryFn: () => agentsApi.listWakes(agent.id, 10),
    enabled: !!view?.alwaysOn,
  })

  const save = useMutation({
    mutationFn: (input: AlwaysOnInput) => agentsApi.setAlwaysOn(agent.id, input),
    onSuccess: async (saved: AlwaysOnView) => {
      success('Always on saved', saved?.alwaysOn?.enabled ? 'It is on.' : 'It is off; it keeps these settings for when you turn it on.')
      await queryClient.invalidateQueries({ queryKey: ['agent', agent.id] })
      await queryClient.invalidateQueries({ queryKey: ['agent-always-on', agent.id] })
      guard.leave(back)
    },
    onError: (err: unknown) => errorNotif('Could not save Always on', getApiErrorMessage(err, 'Please try again.')),
  })

  const submit = () => {
    const { input, error } = inputFromForm(form, floor)
    if (!input) {
      setProblem(error ?? 'Something is missing.')
      return
    }
    save.mutate(input)
  }

  return (
    <FormPage
      title={view?.alwaysOn?.brief ? 'Edit always on' : 'Set up always on'}
      description={ALWAYS_ON_VS_SCHEDULE}
      back={{ to: back, label: agent.name }}
      guard={guard}
      onSubmit={submit}
      submitLabel="Save"
      submitting={save.isPending}
    >
      <FormSection title="What it keeps doing" description="Read at every wake. Write it the way you would brief a colleague.">
        <div className="flex items-center justify-between gap-4 rounded-md border p-3">
          <div>
            <Label htmlFor="always-on-enabled" className="block text-sm font-medium">
              Always on
            </Label>
            <p className="text-xs text-muted-foreground">
              {agent.status === 'active' ? 'Turn it on when the rest is set.' : 'Activate the agent first; an inactive agent never wakes.'}
            </p>
          </div>
          <Switch id="always-on-enabled" checked={form.enabled} onCheckedChange={(enabled) => set({ enabled })} />
        </div>
        <Field id="always-on-brief" label="Standing instructions">
          <Textarea
            id="always-on-brief"
            rows={4}
            placeholder="Keep the refund queue moving. Answer what you can, and tell me about anything over $500."
            value={form.brief}
            onChange={(e) => set({ brief: e.target.value })}
          />
        </Field>
      </FormSection>

      <FormSection title="What wakes it" description="Everything that wakes it goes into the same conversation, so it picks up where it left off.">
        <div className="flex items-start gap-3">
          <Checkbox id="always-on-timer" checked={form.timerOn} onCheckedChange={(v) => set({ timerOn: v === true })} />
          <div className="flex-1 space-y-2">
            <Label htmlFor="always-on-timer" className="text-sm font-medium">On a timer</Label>
            {form.timerOn && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-muted-foreground">Every</span>
                <Input
                  id="always-on-every"
                  aria-label="Every"
                  type="number"
                  min={1}
                  className="w-24"
                  value={form.every}
                  onChange={(e) => set({ every: parseInt(e.target.value, 10) || 0 })}
                />
                <Select value={form.unit} onValueChange={(v) => set({ unit: v as 'minutes' | 'hours' })}>
                  <SelectTrigger className="w-32" aria-label="Unit">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="minutes">minutes</SelectItem>
                    <SelectItem value="hours">hours</SelectItem>
                  </SelectContent>
                </Select>
                <span className="text-xs text-muted-foreground" data-testid="always-on-floor">
                  On your plan, every {pluralized(floor, 'minute')} at most.
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">When a message arrives on</p>
          {channels.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              It has no messaging channels yet. Add Slack, email or a webhook on its{' '}
              <Link className="underline" to={`/agents/${agent.id}?tab=channels`}>Channels</Link> tab.
            </p>
          ) : (
            channels.map((c) => (
              <div key={c.id} className="flex items-start gap-3">
                <Checkbox
                  id={`always-on-channel-${c.id}`}
                  checked={form.channelIds.includes(c.id)}
                  onCheckedChange={(v) => set({ channelIds: toggleIn(form.channelIds, c.id, v === true) })}
                />
                <div>
                  <Label htmlFor={`always-on-channel-${c.id}`} className="block text-sm font-normal">
                    {channelName(c)}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {c.type === 'webhook'
                      ? 'Each delivery wakes it, with what was sent.'
                      : 'People keep their own chats. It is told someone wrote, never what they said.'}
                  </p>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">When a connection it was given needs attention</p>
          {(Object.keys(CONNECTION_EVENT_LABELS) as ConnectionWakeEvent[]).map((event) => (
            <div key={event} className="flex items-center gap-3">
              <Checkbox
                id={`always-on-event-${event}`}
                checked={form.connectionEvents.includes(event)}
                onCheckedChange={(v) => set({ connectionEvents: toggleIn(form.connectionEvents, event, v === true) })}
              />
              <Label htmlFor={`always-on-event-${event}`} className="font-normal text-sm">
                {CONNECTION_EVENT_LABELS[event]}
              </Label>
            </div>
          ))}
        </div>
      </FormSection>

      <FormSection
        title="Talk to it yourself"
        description="Your messages on this channel join its conversation, and it answers you there. Nobody else's do."
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field id="always-on-owner-channel" label="Channel">
            <Select value={form.ownerChannelId} onValueChange={(v) => set({ ownerChannelId: v })}>
              <SelectTrigger id="always-on-owner-channel">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CHANNEL}>Only on the agent page</SelectItem>
                {writeChannels.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {channelName(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {form.ownerChannelId !== NO_CHANNEL && (
            <Field id="always-on-owner-address" label="Your address there" hint="Your Slack member ID, your email address, your phone number.">
              <Input
                id="always-on-owner-address"
                placeholder="U012ABCDEF or you@example.com"
                value={form.ownerAddress}
                onChange={(e) => set({ ownerAddress: e.target.value })}
              />
            </Field>
          )}
        </div>
        {ownerChannel?.type === 'email' && (
          <div className="flex items-start gap-3" data-testid="always-on-trust-email">
            <Checkbox
              id="always-on-trust-email"
              checked={form.ownerTrustEmail}
              onCheckedChange={(v) => set({ ownerTrustEmail: v === true })}
            />
            <div>
              <Label htmlFor="always-on-trust-email" className="block text-sm font-normal">
                Treat email from my address as me
              </Label>
              <p className="text-xs text-muted-foreground">
                Anyone can put your address on an email, so turn this on only if you accept that. Slack and Teams
                messages can't be faked this way. Off, your emails reach it like anyone else's.
              </p>
            </div>
          </div>
        )}
      </FormSection>

      <FormSection title="What it may do on its own" description="Your approval rules, like amounts over a limit, apply either way.">
        <Field id="always-on-act-mode" label="On its own, it">
          <Select
            value={form.actMode}
            onValueChange={(v) =>
              set({
                actMode: v as AlwaysOnActMode,
                // Switching to "act" with nothing on the list starts it with what may change something.
                ...(v === 'act' && form.askFirstToolIds.length === 0
                  ? { askFirstToolIds: tools.filter((t) => !t.readOnly).map((t) => t.id) }
                  : {}),
              })
            }
          >
            <SelectTrigger id="always-on-act-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="propose">Looks things up, and asks you before it changes anything</SelectItem>
              <SelectItem value="act">Does things, and asks you first only before what you pick below</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {form.actMode === 'act' && (
          <div className="space-y-2" data-testid="always-on-ask-first">
            <p className="text-sm font-medium">Ask me first before</p>
            {tools.length === 0 ? (
              <p className="text-sm text-muted-foreground">It has no tools yet.</p>
            ) : (
              tools.map((t) => (
                <div key={t.id} className="flex items-center gap-3">
                  <Checkbox
                    id={`always-on-tool-${t.id}`}
                    checked={form.askFirstToolIds.includes(t.id)}
                    onCheckedChange={(v) => set({ askFirstToolIds: toggleIn(form.askFirstToolIds, t.id, v === true) })}
                  />
                  <Label htmlFor={`always-on-tool-${t.id}`} className="font-normal text-sm">
                    {t.name}
                    {t.readOnly && <span className="ml-2 text-xs text-muted-foreground">only reads</span>}
                  </Label>
                </div>
              ))
            )}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          What it asks about waits in <Link className="underline" to="/approvals">Approvals</Link> until you decide.
        </p>
      </FormSection>

      <FormSection title="Reports" description="Reports also show on the agent page and in your notifications.">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field id="always-on-report-channel" label="Post reports to">
            <Select value={form.reportChannelId} onValueChange={(v) => set({ reportChannelId: v, reportTo: '' })}>
              <SelectTrigger id="always-on-report-channel">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CHANNEL}>Only notifications</SelectItem>
                {(destinations?.channels ?? []).map((c) => (
                  <SelectItem key={c.channelId} value={c.channelId} disabled={!c.available}>
                    {c.name}
                    {c.available ? '' : `: ${c.reason}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="always-on-report-when" label="When">
            <Select value={form.report} onValueChange={(v) => set({ report: v as AlwaysOnReport })}>
              <SelectTrigger id="always-on-report-when">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="when_acted">Only when it did something</SelectItem>
                <SelectItem value="every_wake">After every wake</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
        {reportChannel && reportChannel.choose !== 'fixed' && (
          <Field id="always-on-report-to" label={reportChannel.noun} hint={reportChannel.hint}>
            {reportChannel.destinations.length > 0 && reportChannel.choose === 'pick' ? (
              <Select value={form.reportTo} onValueChange={(v) => set({ reportTo: v })}>
                <SelectTrigger id="always-on-report-to">
                  <SelectValue placeholder={`Choose a ${reportChannel.noun.toLowerCase()}`} />
                </SelectTrigger>
                <SelectContent>
                  {reportChannel.destinations.map((d) => (
                    <SelectItem key={d.to} value={d.to}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                id="always-on-report-to"
                placeholder={reportChannel.placeholder}
                value={form.reportTo}
                onChange={(e) => set({ reportTo: e.target.value })}
              />
            )}
          </Field>
        )}
      </FormSection>

      {view?.alwaysOn && (
        <FormSection title="What woke it lately">
          {wakes.data && wakes.data.length > 0 ? (
            <ul className="space-y-1 text-sm" data-testid="always-on-wakes">
              {wakes.data.map((w) => (
                <li key={w.id} className="flex flex-wrap gap-x-2">
                  <span className="text-muted-foreground">{formatWakeTime(w.createdAt)}</span>
                  <span className="font-medium">{wakeSourceLabel(w.source)}</span>
                  <span>{w.summary}</span>
                  {w.runId && (
                    <Link className="underline" to={`/agents/${agent.id}/runs/${w.runId}`}>
                      run
                    </Link>
                  )}
                  {w.status === 'dropped' && <span className="text-muted-foreground">(not acted on{w.note ? `: ${w.note}` : ''})</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing yet.</p>
          )}
        </FormSection>
      )}

      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
    </FormPage>
  )
}

export default AgentAlwaysOnPage
