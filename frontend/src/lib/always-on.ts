/**
 * Always on, as the agent page and /agents/:id/always-on see it. Mirrors
 * backend/src/modules/agents/always-on/always-on.types.ts and the view
 * AlwaysOnService returns (GET /agents/:id/always-on).
 */
import type { AgentPauseReason } from '@/types/usage'
import type { ScheduleDelivery } from '@/lib/schedule'
import { pluralized } from '@/lib/utils'
export { formatRunTime as formatWakeTime } from '@/lib/schedule'

export type ConnectionWakeEvent = 'expiring' | 'expired' | 'rotation_due'
export type AlwaysOnActMode = 'propose' | 'act'
export type AlwaysOnReport = 'every_wake' | 'when_acted' | 'daily_digest'

/** The daily summary's time of day ("HH:MM") and IANA time zone. */
export interface DigestTiming {
  time: string
  timezone: string
}

export interface AlwaysOnConfig {
  enabled: boolean
  brief: string
  wakeOn: {
    timer?: { everyMinutes: number } | null
    channelIds?: string[]
    connectionEvents?: ConnectionWakeEvent[]
  }
  ownerChannel?: { channelId: string; address: string; trustEmail?: boolean } | null
  actMode: AlwaysOnActMode
  askFirstToolIds: string[]
  reportTo?: Extract<ScheduleDelivery, { kind: 'channel' }> | null
  report: AlwaysOnReport
  maxWakesPerHour?: number | null
  standingConversationId?: string | null
  liveRunId?: string | null
  pausedReason?: AgentPauseReason | null
  /** With report 'daily_digest': when the summary goes out. Either part may be empty: the defaults apply. */
  digest?: Partial<DigestTiming> | null
  /** When it was last turned on; the hosted-home agents the plan includes are the ones turned on first. */
  enabledAt?: string | null
  /** Its hosted home machine; only agents with one count toward the plan's always-on limit. */
  home?: { environmentId: string } | null
}

export interface AlwaysOnCapacity {
  timerFloorMinutes: number
  maxWakesPerHour: number
  includedAgents: number | null
}

export type WakeSource = 'timer' | 'channel' | 'webhook' | 'connection' | 'manual'

export interface AlwaysOnView {
  alwaysOn: AlwaysOnConfig | null
  capacity: AlwaysOnCapacity
  effectiveTimerMinutes: number | null
  effectiveWakesPerHour: number
  nextWakeAt: string | null
  lastWake: { at: string; source: WakeSource; summary: string; runId: string | null } | null
  queued: number
  liveRunId: string | null
  /** When the daily summary goes out: the agent's own setting, else 09:00 in the owner's time zone. */
  digest: DigestTiming
  /**
   * Whether this agent lives on a hosted machine. Only those count toward
   * capacity.includedAgents; an agent on the owner's own machines, or with
   * no machine, is never limited, so the page names the limit only for these.
   */
  hostedHome: boolean
  /** The organization's always-on agents with a hosted home that are on now. */
  hostedAgentsOn: number
  tools: Array<{ id: string; name: string; readOnly: boolean }>
}

export interface AgentWakeRow {
  id: string
  source: WakeSource
  summary: string
  status: 'queued' | 'consumed' | 'coalesced' | 'dropped'
  runId: string | null
  note: string | null
  createdAt: string
  consumedAt: string | null
}

export type AlwaysOnInput = Partial<
  Pick<AlwaysOnConfig, 'enabled' | 'brief' | 'wakeOn' | 'ownerChannel' | 'actMode' | 'askFirstToolIds' | 'reportTo' | 'report' | 'maxWakesPerHour' | 'digest'>
>

/** The one line on the card that says how Always on differs from a schedule. */
export const ALWAYS_ON_VS_SCHEDULE =
  'Always on keeps working in the background: it wakes on a timer and when something happens, and picks up where it left off. A schedule runs one task at a set time and posts the result.'

export const CONNECTION_EVENT_LABELS: Record<ConnectionWakeEvent, string> = {
  expiring: 'A connection it uses is about to expire',
  expired: 'A connection it uses has expired',
  rotation_due: 'A connection it uses is due for a new key',
}

/** "Every 30 minutes, and when a message arrives" — what wakes it, in words. */
export function describeWakes(config: AlwaysOnConfig | null | undefined, effectiveMinutes?: number | null): string {
  if (!config) return 'Not set up'
  const parts: string[] = []
  const minutes = effectiveMinutes ?? config.wakeOn?.timer?.everyMinutes
  if (minutes) parts.push(minutes % 60 === 0 ? `every ${minutes === 60 ? 'hour' : pluralized(minutes / 60, 'hour')}` : `every ${pluralized(minutes, 'minute')}`)
  if (config.wakeOn?.channelIds?.length || config.ownerChannel) parts.push('when a message arrives')
  if (config.wakeOn?.connectionEvents?.length) parts.push('when a connection needs attention')
  if (!parts.length) return 'Nothing wakes it yet'
  const text = parts.length > 1 ? `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}` : parts[0]
  return `Wakes ${text}`
}

/** "Only looks things up on its own" / "Acts on its own" — what it may do. */
export function describeActMode(config: AlwaysOnConfig | null | undefined): string {
  if (!config) return ''
  if (config.actMode === 'act') {
    const n = config.askFirstToolIds?.length ?? 0
    return n ? `Acts on its own, and asks you first before ${pluralized(n, 'tool')}` : 'Acts on its own'
  }
  return 'Looks things up on its own, and asks you before it changes anything'
}

const SOURCE_WORDS: Record<WakeSource, string> = {
  timer: 'Timer',
  channel: 'Message',
  webhook: 'Webhook',
  connection: 'Connection',
  manual: 'You',
}

export function wakeSourceLabel(source: WakeSource): string {
  return SOURCE_WORDS[source] ?? source
}

/** What the report picker says for each choice. */
export const REPORT_LABELS: Record<AlwaysOnReport, string> = {
  when_acted: 'Only when it did something',
  every_wake: 'After every wake',
  daily_digest: 'Once a day, a short summary of what it did',
}

/** "09:00" as the person's clock reads it: 9:00. */
function clockTime(time: string): string {
  const [h, m] = time.split(':')
  return `${Number(h)}:${m}`
}

/** "Reports once a day at 9:00, Europe/Berlin" — when it reports, in words. */
export function describeReport(config: AlwaysOnConfig | null | undefined, digest?: DigestTiming | null): string {
  if (!config) return ''
  if (config.report === 'daily_digest') {
    const at = digest ? ` at ${clockTime(digest.time)}, ${digest.timezone.replace(/_/g, ' ')}` : ''
    return `Sends a short summary once a day${at}`
  }
  return config.report === 'every_wake' ? 'Reports after every wake' : 'Reports when it did something'
}