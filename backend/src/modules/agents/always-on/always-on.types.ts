import { BadRequestException } from '@nestjs/common';

import type { AgentPauseReason } from '../../../entities/agent.entity';
import type { ChannelDelivery } from '../scheduled-result-poster';

/**
 * Always on (docs/always-on.md): an autonomous agent that keeps working in
 * the background. It wakes on a timer and when something happens, and every
 * wake continues the same conversation, its standing thread.
 *
 * Stored on `agents.alwaysOn`. Schedule (agent.settings.schedule) is a
 * different thing and stays: it runs one task at a time of day and posts
 * the result.
 */

/** Connection events an always-on agent can wake on. */
export const CONNECTION_WAKE_EVENTS = ['expiring', 'expired', 'rotation_due'] as const;
export type ConnectionWakeEvent = (typeof CONNECTION_WAKE_EVENTS)[number];

/** What wakes the agent. */
export interface AlwaysOnWakeOn {
  /** Every N minutes. Never shorter than the plan's floor (always-on-capacity.ts). */
  timer?: { everyMinutes: number } | null;
  /**
   * Agent channels whose messages wake it. A Webhook channel's deliveries
   * become wakes instead of conversations of their own; on any other channel
   * visitors keep their own chats and the agent gets a one-line note.
   */
  channelIds?: string[];
  /** Connection events on connections granted to this agent. */
  connectionEvents?: ConnectionWakeEvent[];
}

/**
 * Where the owner talks to the agent themselves: one of its channels and
 * their own address on it (their Slack member id, their email address).
 * Only messages from that address on that channel join the standing thread;
 * the agent's reply goes back there.
 */
export interface AlwaysOnOwnerChannel {
  channelId: string;
  address: string;
  /**
   * On an email channel, treat mail from `address` as the owner. Off by
   * default: an email sender can be faked, while Slack, Teams and the other
   * platforms sign who wrote. Off, the owner's emails count as anyone's.
   */
  trustEmail?: boolean;
}

/**
 * - `propose`: it looks things up on its own and asks first before anything
 *   that changes something (every tool that is not read-only).
 * - `act`: it does things on its own, and asks first only before the tools
 *   on `askFirstToolIds`.
 * Approval rules (amount rules and the rest) apply in both.
 */
export type AlwaysOnActMode = 'propose' | 'act';

/** When it reports to `reportTo`: after every wake, or only when it did something. */
export type AlwaysOnReport = 'every_wake' | 'when_acted';

export interface AlwaysOnConfig {
  enabled: boolean;
  /** Standing instructions, read at every wake. */
  brief: string;
  wakeOn: AlwaysOnWakeOn;
  ownerChannel?: AlwaysOnOwnerChannel | null;
  actMode: AlwaysOnActMode;
  /** The tools it asks first before, in `act` mode. */
  askFirstToolIds: string[];
  /** Where reports go, besides the agent page and the owner's notifications. */
  reportTo?: ChannelDelivery | null;
  report: AlwaysOnReport;
  /** Most wakes an hour before it pauses itself; never above the plan's. */
  maxWakesPerHour?: number | null;
  /** The conversation every wake continues; set on the first wake. */
  standingConversationId?: string | null;
  /** The standing thread's latest run; while it is live, wakes join it instead of starting another. */
  liveRunId?: string | null;
  /** Set when the system paused it on its own; see AgentPauseReason. */
  pausedReason?: AgentPauseReason | null;
}

/** A new agent's always-on settings. */
export function defaultAlwaysOn(): AlwaysOnConfig {
  return {
    enabled: false,
    brief: '',
    wakeOn: { timer: { everyMinutes: 30 }, channelIds: [], connectionEvents: [] },
    ownerChannel: null,
    actMode: 'propose',
    askFirstToolIds: [],
    reportTo: null,
    report: 'when_acted',
    maxWakesPerHour: null,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuids(value: unknown, what: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new BadRequestException(`${what} must be a list.`);
  const out = [...new Set(value.filter((v) => typeof v === 'string' && UUID_RE.test(v)))];
  if (out.length !== value.length) throw new BadRequestException(`${what} has something in it that is not an id.`);
  return out;
}

/**
 * A stored or legacy value read as AlwaysOnConfig. The old heartbeat
 * shape (`intervalMinutes`, `prompt`) is read too, so a row the migration
 * has not touched still works.
 */
export function readAlwaysOn(raw: unknown): AlwaysOnConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, any>;
  if (!r.wakeOn && ('intervalMinutes' in r || 'prompt' in r)) {
    return {
      ...defaultAlwaysOn(),
      enabled: r.enabled === true,
      brief: typeof r.prompt === 'string' ? r.prompt : '',
      wakeOn: { timer: { everyMinutes: Number(r.intervalMinutes) || 60 }, channelIds: [], connectionEvents: [] },
      actMode: 'act',
      ...(r.pausedReason ? { pausedReason: r.pausedReason } : {}),
    };
  }
  const base = defaultAlwaysOn();
  return {
    ...base,
    ...r,
    enabled: r.enabled === true,
    brief: typeof r.brief === 'string' ? r.brief : '',
    wakeOn: {
      timer: r.wakeOn?.timer?.everyMinutes ? { everyMinutes: Number(r.wakeOn.timer.everyMinutes) } : null,
      channelIds: Array.isArray(r.wakeOn?.channelIds) ? r.wakeOn.channelIds : [],
      connectionEvents: Array.isArray(r.wakeOn?.connectionEvents) ? r.wakeOn.connectionEvents : [],
    },
    actMode: r.actMode === 'act' ? 'act' : 'propose',
    askFirstToolIds: Array.isArray(r.askFirstToolIds) ? r.askFirstToolIds : [],
    report: r.report === 'every_wake' ? 'every_wake' : 'when_acted',
  } as AlwaysOnConfig;
}

/** What a person may set (the rest is the system's: the standing thread, the pause). */
export interface AlwaysOnInput {
  enabled?: boolean;
  brief?: string;
  wakeOn?: AlwaysOnWakeOn;
  ownerChannel?: AlwaysOnOwnerChannel | null;
  actMode?: AlwaysOnActMode;
  askFirstToolIds?: string[];
  reportTo?: ChannelDelivery | null;
  report?: AlwaysOnReport;
  maxWakesPerHour?: number | null;
}

export const MAX_BRIEF_CHARS = 8000;

/**
 * Merge a request over the stored settings and check it. Plan limits (the
 * timer floor, wakes an hour) are checked by the service, which knows the
 * plan; channels and tools are checked against the agent there too.
 */
export function mergeAlwaysOn(current: AlwaysOnConfig | null, input: AlwaysOnInput): AlwaysOnConfig {
  const base = current ?? defaultAlwaysOn();
  const next: AlwaysOnConfig = { ...base };
  if (input.enabled !== undefined) next.enabled = input.enabled === true;
  if (input.brief !== undefined) {
    if (typeof input.brief !== 'string') throw new BadRequestException('Say what it should keep doing, in words.');
    if (input.brief.length > MAX_BRIEF_CHARS) {
      throw new BadRequestException(`Keep what it should keep doing under ${MAX_BRIEF_CHARS} characters.`);
    }
    next.brief = input.brief.trim();
  }
  if (input.wakeOn !== undefined) {
    const w = input.wakeOn ?? {};
    let timer: AlwaysOnWakeOn['timer'] = null;
    if (w.timer && w.timer.everyMinutes !== undefined && w.timer.everyMinutes !== null) {
      const minutes = Number(w.timer.everyMinutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 7 * 24 * 60) {
        throw new BadRequestException('How often it wakes has to be a whole number of minutes, at most a week.');
      }
      timer = { everyMinutes: minutes };
    }
    const events = Array.isArray(w.connectionEvents) ? [...new Set(w.connectionEvents)] : [];
    const unknown = events.filter((e) => !(CONNECTION_WAKE_EVENTS as readonly string[]).includes(e));
    if (unknown.length) throw new BadRequestException(`Unknown connection event: ${unknown.join(', ')}.`);
    next.wakeOn = { timer, channelIds: uuids(w.channelIds, 'The channels it wakes on'), connectionEvents: events };
  }
  if (input.ownerChannel !== undefined) {
    if (input.ownerChannel === null) {
      next.ownerChannel = null;
    } else {
      const { channelId, address } = input.ownerChannel ?? ({} as AlwaysOnOwnerChannel);
      if (typeof channelId !== 'string' || !UUID_RE.test(channelId)) {
        throw new BadRequestException('Choose the channel you talk to it on.');
      }
      if (typeof address !== 'string' || !address.trim() || address.length > 255) {
        throw new BadRequestException('Enter your own address on that channel.');
      }
      next.ownerChannel = { channelId, address: address.trim(), trustEmail: input.ownerChannel.trustEmail === true };
    }
  }
  if (input.actMode !== undefined) {
    if (input.actMode !== 'propose' && input.actMode !== 'act') {
      throw new BadRequestException('Choose whether it asks first or acts on its own.');
    }
    next.actMode = input.actMode;
  }
  if (input.askFirstToolIds !== undefined) next.askFirstToolIds = uuids(input.askFirstToolIds, 'The ask-first list');
  if (input.reportTo !== undefined) next.reportTo = input.reportTo ?? null;
  if (input.report !== undefined) {
    if (input.report !== 'every_wake' && input.report !== 'when_acted') {
      throw new BadRequestException('Choose when it reports: after every wake, or only when it did something.');
    }
    next.report = input.report;
  }
  if (input.maxWakesPerHour !== undefined) {
    if (input.maxWakesPerHour === null) {
      next.maxWakesPerHour = null;
    } else {
      const n = Number(input.maxWakesPerHour);
      if (!Number.isInteger(n) || n < 1) throw new BadRequestException('Wakes an hour has to be a whole number, 1 or more.');
      next.maxWakesPerHour = n;
    }
  }
  // Turning it on, or changing it, is the acknowledgement of a pause.
  if (input.enabled === true) next.pausedReason = null;
  if (next.enabled && !next.brief) {
    throw new BadRequestException('Say what it should keep doing before turning it on.');
  }
  if (next.enabled && !next.wakeOn.timer && !(next.wakeOn.channelIds?.length) && !(next.wakeOn.connectionEvents?.length) && !next.ownerChannel) {
    throw new BadRequestException('Choose at least one thing that wakes it: a timer, a channel or a connection event.');
  }
  return next;
}

/**
 * Tools that only read, by their side-effect class (tools/tool-side-effect.ts:
 * an HTTP GET or HEAD, a GraphQL query, an annotation or an override saying
 * so). Everything else may change something, so `propose` asks first.
 */
export function isReadOnlyTool(tool: { sideEffect?: string | null }): boolean {
  return tool.sideEffect === 'read';
}
