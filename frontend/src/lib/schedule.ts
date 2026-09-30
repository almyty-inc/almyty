/**
 * Agent schedules as the schedule page and card read them. Mirrors
 * backend/src/modules/agents/agent-schedule-spec.ts (the timing shapes and
 * the plain words) and scheduled-result-poster.ts (where a result goes), so
 * the page and the API describe a schedule the same way.
 */
import { pluralized } from '@/lib/utils'

export type ScheduleKind = 'interval' | 'days' | 'monthly'

export interface ScheduleTiming {
  kind?: ScheduleKind
  intervalMinutes?: number
  /** "HH:MM", 24-hour, in `timezone`. */
  time?: string
  /** 0 = Sunday ... 6 = Saturday. */
  days?: number[]
  /** 1-28, or 'last' for the month's last day. */
  dayOfMonth?: number | 'last'
  timezone?: string
}

export interface ChannelDelivery {
  kind: 'channel'
  channelId: string
  to?: string
  label?: string
  context?: Record<string, string>
}

export type ScheduleDelivery = { kind: 'webhook' } | ChannelDelivery

export interface AgentSchedule extends ScheduleTiming {
  enabled: boolean
  input: Record<string, any>
  deliverTo?: ScheduleDelivery | null
  pausedReason?: any
}

export interface ScheduleRequest extends ScheduleTiming {
  input?: Record<string, any>
  deliverTo?: ScheduleDelivery | null
}

/** GET /agents/:id/schedule */
export interface ScheduleView {
  schedule: AgentSchedule | null
  summary: string | null
  nextRunAt: string | null
}

/** POST /agents/:id/schedule/preview */
export interface SchedulePreview {
  summary: string
  nextRuns: string[]
  timezone: string | null
}

export interface PostDestination {
  to: string
  label: string
  context?: Record<string, string>
}

/** One of the agent's channels, as "Send the result to" offers it. */
export interface PostChannelOption {
  channelId: string
  name: string
  type: string
  available: boolean
  reason?: string
  noun: string
  choose: 'fixed' | 'pick' | 'pick_or_enter' | 'enter'
  placeholder?: string
  hint?: string
  destinations: PostDestination[]
}

/** GET /agents/:id/schedule/destinations */
export interface DeliveryOptions {
  webhookUrl: string | null
  channels: PostChannelOption[]
}

/** What became of posting a scheduled result, on the run (metadata.channelDelivery). */
export interface ChannelDeliveryOutcome {
  status: 'delivered' | 'failed' | 'skipped'
  channelId: string
  channelName?: string
  channelType?: string
  destination?: string
  parts?: number
  truncated?: boolean
  error?: string
  at: string
}

/**
 * A stored schedule as the request that turns it back on: its timing,
 * input and destination, without what the server records about it
 * (enabled, pausedReason). A schedule saved before kinds existed is an
 * interval.
 */
export function requestFromStored(schedule: AgentSchedule): ScheduleRequest {
  const { enabled: _enabled, pausedReason: _paused, ...rest } = schedule
  return { ...rest, kind: rest.kind ?? 'interval', input: rest.input ?? {} }
}
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
/** Monday first, the way a week reads. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]
export const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6]
export const WEEKDAYS = [1, 2, 3, 4, 5]

export type DayChoice = 'every_day' | 'weekdays' | 'specific'

/** Which of the three day choices a set of days is. */
export function dayChoiceOf(days: number[] | undefined): DayChoice {
  const set = [...new Set(days ?? [])].sort((a, b) => a - b)
  if (set.length === 7) return 'every_day'
  if (set.length === 5 && WEEKDAYS.every((d) => set.includes(d))) return 'weekdays'
  return 'specific'
}

function ordinal(n: number): string {
  const rem = n % 100
  if (rem >= 11 && rem <= 13) return `${n}th`
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`
}

function listOf(words: string[]): string {
  if (words.length <= 1) return words.join('')
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

function intervalWords(minutes: number): string {
  if (minutes === 1) return 'Every minute'
  if (minutes % (60 * 24) === 0) {
    const d = minutes / (60 * 24)
    return d === 1 ? 'Every 24 hours' : `Every ${pluralized(d, 'day')}`
  }
  if (minutes % 60 === 0) {
    const h = minutes / 60
    return h === 1 ? 'Every hour' : `Every ${pluralized(h, 'hour')}`
  }
  return `Every ${pluralized(minutes, 'minute')}`
}

function clock(time: string | undefined): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time ?? '')
  if (!match) return null
  return `${Number(match[1])}:${match[2]}`
}

/**
 * "Every weekday at 8:00, Europe/Berlin", "Every Monday and Thursday at
 * 17:30, UTC", "On the 1st of every month at 9:00, America/New_York",
 * "Every 15 minutes". The same words the backend's describeTiming writes.
 */
export function describeSchedule(timing: ScheduleTiming | null | undefined): string {
  if (!timing) return ''
  const kind = timing.kind ?? 'interval'
  if (kind === 'interval') {
    const minutes = Math.floor(Number(timing.intervalMinutes))
    return Number.isFinite(minutes) && minutes >= 1 ? intervalWords(minutes) : 'Every few minutes'
  }
  const at = clock(timing.time)
  const zone = timing.timezone || 'UTC'
  const when = at ? ` at ${at}, ${zone}` : ''
  if (kind === 'monthly') {
    if (timing.dayOfMonth === 'last') return `On the last day of every month${when}`
    return timing.dayOfMonth ? `On the ${ordinal(timing.dayOfMonth)} of every month${when}` : `Once a month${when}`
  }
  const days = [...new Set(timing.days ?? [])].sort((a, b) => a - b)
  if (days.length === 0) return `On the days you choose${when}`
  const choice = dayChoiceOf(days)
  if (choice === 'every_day') return `Every day${when}`
  if (choice === 'weekdays') return `Every weekday${when}`
  if (days.length === 2 && days[0] === 0 && days[1] === 6) return `Every Saturday and Sunday${when}`
  const ordered = WEEK_ORDER.filter((d) => days.includes(d))
  return `Every ${listOf(ordered.map((d) => DAY_NAMES[d]))}${when}`
}

/** A run time in the schedule's own zone, with the zone named: "Thu 1 Oct, 08:00 (Europe/Berlin)". */
export function formatRunTime(iso: string | null | undefined, zone?: string | null): string {
  if (!iso) return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const tz = zone || undefined
  try {
    const text = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(at)
    return zone ? `${text} (${zone})` : text
  } catch {
    return at.toLocaleString()
  }
}

/** "Posted to My Slack, #sales" / "Not posted to My Slack: not_in_channel". */
export function describeDelivery(outcome: ChannelDeliveryOutcome | null | undefined): { text: string; failed: boolean } | null {
  if (!outcome) return null
  const where = [outcome.channelName, outcome.destination].filter(Boolean).join(', ')
  if (outcome.status === 'delivered') {
    const split = outcome.parts && outcome.parts > 1 ? ` in ${pluralized(outcome.parts, 'message')}` : ''
    return { text: `Posted to ${where || 'the channel'}${split}`, failed: false }
  }
  const verb = outcome.status === 'skipped' ? 'Not posted' : 'Posting failed'
  return { text: `${verb}${where ? ` to ${where}` : ''}: ${outcome.error ?? 'unknown reason'}`, failed: true }
}
