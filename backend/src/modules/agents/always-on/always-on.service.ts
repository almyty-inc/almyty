import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
  forwardRef,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, MoreThan, Not, Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';

import { Agent, AgentPauseReason, AgentStatus } from '../../../entities/agent.entity';
import { AgentRun, AgentRunStatus } from '../../../entities/agent-run.entity';
import { AgentWake, WakeSource } from '../../../entities/agent-wake.entity';
import { AgentChannel, ChannelType } from '../../../entities/agent-channel.entity';
import { Organization } from '../../../entities/organization.entity';
import { Tool } from '../../../entities/tool.entity';
import { User } from '../../../entities/user.entity';
import { Message } from '../../../entities/message.entity';
import { AuditAction, AuditResource } from '../../../entities/audit-log.entity';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { userPrincipal } from '../../../common/authorization/execution-access.service';
import { AgentIdentityService, isLapsed, runUserOf } from '../agent-identity';
import { AgentRuntimeService } from '../agent-runtime.service';
import { agentOwnerUserId } from '../agent-owner';
import {
  ChannelDelivery,
  SCHEDULED_RESULT_POSTER,
  ScheduledResult,
  ScheduledResultPoster,
} from '../scheduled-result-poster';
import { ConnectionGrant } from '../../../entities/connection-grant.entity';
import { ConnectionEvent, onConnectionEvent } from '../../connections/connection-events';
import { AlwaysOnCapacity, alwaysOnCapacity, effectiveTimerMinutes, effectiveWakesPerHour } from './always-on-capacity';
import { DIGEST_WINDOW_MS, DigestTiming, digestCron, digestText, digestTiming, localDay } from './always-on-digest';
import {
  AlwaysOnConfig,
  AlwaysOnInput,
  ConnectionWakeEvent,
  hasHostedHome,
  isReadOnlyTool,
  mergeAlwaysOn,
  readAlwaysOn,
} from './always-on.types';

/** Job names on the agent-runtime queue. */
export const ALWAYS_ON_TICK_JOB = 'always-on-tick';
export const ALWAYS_ON_WAKE_JOB = 'always-on-wake';
/** The job name heartbeats were enqueued under before Always on; removed at boot. */
export const LEGACY_HEARTBEAT_JOB = 'heartbeat';
/** The daily summary of an agent with `report: 'daily_digest'` (always-on-digest.ts). */
export const ALWAYS_ON_DIGEST_JOB = 'always-on-digest';
/** The check that turns agents paused for capacity back on once the plan has room. */
export const ALWAYS_ON_CAPACITY_JOB = 'always-on-capacity';

/** How often the capacity check runs, in minutes: ALWAYS_ON_CAPACITY_CHECK_MINUTES, else 15. */
export function capacityCheckMinutes(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.ALWAYS_ON_CAPACITY_CHECK_MINUTES);
  return Number.isInteger(n) && n > 0 ? n : 15;
}

/** Why its waiting wakes were not acted on, in the words the wake list shows. */
const PAUSE_WORDS: Record<AgentPauseReason['code'], string> = {
  MODEL_NOT_FOUND: 'its model is gone',
  OWNER_CANNOT_RUN: 'its owner can no longer run it',
  OWNER_NOT_MEMBER: 'its owner is no longer a member',
  RESTORE_FAILED: 'its timer could not be restored',
  WAKE_LOOP: 'it woke too often',
  CAPACITY_EXHAUSTED: 'the plan has no room for it',
  IDENTITY_LAPSED: 'the plan no longer lets it act as itself',
};
const agentsWord = (n: number) => `${n} always-on ${n === 1 ? 'agent' : 'agents'} on hosted machines`;

/** The pause of an agent beyond what the plan includes, in words the owner can act on. */
export function capacityPause(included: number, on: number, at = new Date()): AgentPauseReason {
  return {
    code: 'CAPACITY_EXHAUSTED',
    message:
      `Your plan includes ${agentsWord(included)}, and ${on} were on. This one was turned on last, so it was paused. ` +
      'It turns back on by itself when there is room: turn Always on off for another agent on a hosted machine, move this one to your own machine, or move to a plan that includes more.',
    detectedAt: at.toISOString(),
  };
}

/** Why turning one more on is refused, naming the ones that are on. */
export function capacityRefusal(included: number, onNames: string[]): string {
  const shown = onNames.slice(0, 5).map((n) => `"${n}"`);
  const rest = onNames.length - shown.length;
  const names = rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
  return (
    `Your plan includes ${agentsWord(included)}, and ${onNames.length === 1 ? 'one is' : `${onNames.length} are`} on already: ${names}. ` +
    'Turn Always on off for one of them first, run this one on your own machine, or move to a plan that includes more.'
  );
}

/** The most wakes that wait in an agent's inbox; older ones are folded away. */
export const MAX_QUEUED_WAKES = 100;
/** The most wakes one run is handed at once. */
export const MAX_WAKES_PER_RUN = 50;
/** Bytes of payload a wake may carry. */
export const MAX_WAKE_PAYLOAD_BYTES = 16 * 1024;
/** How long the per-agent single-flight lock is held while a wake is turned into a run. */
const LOCK_TTL_MS = 30_000;

/** Run statuses that mean the standing thread has a live run. */
const LIVE_STATUSES: AgentRunStatus[] = [
  AgentRunStatus.RUNNING,
  AgentRunStatus.SLEEPING,
  AgentRunStatus.WAITING_INPUT,
  AgentRunStatus.WAITING_APPROVAL,
];

export interface WakeInput {
  summary: string;
  dedupeKey: string;
  sourceRef?: string | null;
  payload?: Record<string, any> | null;
  /** A message from the owner on their own channel: its text, and where the reply goes. */
  ownerMessage?: { text: string; replyTo: ChannelDelivery } | null;
  /** Keep the wake for the next run without starting one for it. */
  passive?: boolean;
}

/** What the agent page shows about Always on. */
export interface AlwaysOnView {
  alwaysOn: AlwaysOnConfig | null;
  capacity: AlwaysOnCapacity;
  /** The timer it actually runs on, after the plan's floor. */
  effectiveTimerMinutes: number | null;
  effectiveWakesPerHour: number;
  nextWakeAt: string | null;
  lastWake: { at: string; source: WakeSource; summary: string; runId: string | null } | null;
  queued: number;
  liveRunId: string | null;
  /** When the daily summary goes out: the agent's own setting, else 09:00 in the owner's time zone. */
  digest: DigestTiming;
  /**
   * Whether this agent lives on a hosted machine. Only those count toward
   * capacity.includedAgents; the page names the limit only for them.
   */
  hostedHome: boolean;
  /** The organization's always-on agents with a hosted home that are on now. */
  hostedAgentsOn: number;
}

function bounded(text: string, max: number): string {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function boundedPayload(payload: Record<string, any> | null | undefined): Record<string, any> | null {
  if (!payload) return null;
  try {
    const json = JSON.stringify(payload);
    if (json.length <= MAX_WAKE_PAYLOAD_BYTES) return payload;
    return { truncated: true, preview: json.slice(0, MAX_WAKE_PAYLOAD_BYTES - 64) };
  } catch {
    return null;
  }
}

/** An inbound channel message, as Always on needs to see it. */
export interface InboundForAlwaysOn {
  organizationId: string;
  agentId: string | null;
  gatewayId: string;
  senderId: string | null;
  senderName?: string | null;
  text: string;
  deliveryId?: string | null;
  /** The platform says the agent's own bot sent it. */
  fromBot?: boolean;
}

/**
 * Whether a sender is the owner's address: the same id, ignoring case, or
 * for email the same address inside "Name <address>".
 */
export function sameAddress(sender: string | null | undefined, address: string | null | undefined): boolean {
  if (!sender || !address) return false;
  const norm = (v: string) => {
    const open = v.lastIndexOf('<');
    const close = v.lastIndexOf('>');
    const inner = open >= 0 && close > open ? v.slice(open + 1, close) : v;
    return inner.trim().toLowerCase();
  };
  return norm(sender) === norm(address);
}

/**
 * A webhook delivery as one plain line for people: `Webhook "GitHub":
 * opened, "Refund NW-7 never arrived"`. The words come from the fields
 * deliveries usually carry (an action or event, a title or subject, a
 * message or body), never the raw JSON; the agent gets what was sent in
 * full (wakeMessage).
 */
export function describeWebhook(channelName: string, text: string): string {
  const name = `Webhook "${bounded(channelName, 60)}"`;
  const raw = String(text ?? '').trim();
  if (!raw) return `${name} received a delivery`;
  let body: any = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  if (!body || typeof body !== 'object') {
    const firstLine = raw.split('\n')[0];
    return `${name}: ${bounded(firstLine, 140)}`;
  }
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const pick = (o: any, keys: string[]): string | null => {
    if (!o || typeof o !== 'object') return null;
    for (const k of keys) {
      const v = str(o[k]);
      if (v) return v;
    }
    return null;
  };
  const nested = [body, ...Object.values(body).filter((v) => v && typeof v === 'object' && !Array.isArray(v))];
  const what = pick(body, ['action', 'event', 'type', 'status', 'state']);
  let detail: string | null = null;
  for (const o of nested) {
    detail = pick(o, ['title', 'subject', 'name', 'summary', 'message', 'text', 'body', 'description']);
    if (detail) break;
  }
  const words = [what?.replace(/[_.]+/g, ' '), detail ? `"${bounded(detail, 100)}"` : null].filter(Boolean).join(', ');
  return words ? `${name}: ${words}` : `${name} received a delivery`;
}

function clock(at: Date): string {
  return at.toISOString().slice(11, 16) + ' UTC';
}

/**
 * The message a wake hands the agent: its standing instructions, then what
 * happened since it last worked, oldest first. The owner's own words are
 * quoted in full; everything else is the one line the wake carries.
 */
export function wakeMessage(brief: string, wakes: Array<Pick<AgentWake, 'source' | 'summary' | 'payload' | 'createdAt'>>): string {
  return [
    'You are always on, and something woke you.',
    '',
    'What to keep doing:',
    brief || '(no standing instructions)',
    '',
    'What happened since you last worked (oldest first):',
    ...(wakes.length ? wakes.map(wakeLine) : ['- nothing new']),
    '',
    'Do what needs doing now. If nothing does, say so in one line.',
  ].join('\n');
}

/**
 * One wake as the agent reads it: the owner's words in full; any other
 * wake's line, and for a webhook what was sent (the line is for people).
 */
function wakeLine(w: Pick<AgentWake, 'source' | 'summary' | 'payload' | 'createdAt'>): string {
  const owner = w.payload?.ownerMessage?.text;
  if (owner) return `- ${clock(w.createdAt)}, your owner wrote: ${owner}`;
  const sent = w.source === 'webhook' && typeof w.payload?.text === 'string' ? `\n  What was sent: ${w.payload.text}` : '';
  return `- ${clock(w.createdAt)}, ${w.summary}${sent}`;
}

/** The note a live run gets when wakes arrive while it works. */
export function whileYouWereWorking(wakes: Array<Pick<AgentWake, 'source' | 'summary' | 'payload' | 'createdAt'>>): string {
  return ['While you were working:', ...wakes.map(wakeLine)].join('\n');
}

/**
 * Always on (docs/always-on.md): one agent, one standing thread, woken by a
 * timer and by events.
 *
 * Every wake source calls `wake`, which writes an `agent_wakes` row and asks
 * the queue to look at the agent. `process` turns queued wakes into one run
 * on the standing thread, single flight per agent: while a run of the thread
 * is live, new wakes wait and are handed to it at its next step
 * (`drainInto`, called by the step processor). Nothing else starts an
 * always-on run, and a wake never changes the engine: the run is an
 * ordinary autonomous run with the agent's own limits.
 */
@Injectable()
export class AlwaysOnService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AlwaysOnService.name);
  private stopConnectionEvents?: () => void;

  onModuleDestroy(): void {
    this.stopConnectionEvents?.();
  }

  constructor(
    @InjectRepository(Agent) private readonly agents: Repository<Agent>,
    @InjectRepository(AgentWake) private readonly wakes: Repository<AgentWake>,
    @InjectRepository(AgentRun) private readonly runs: Repository<AgentRun>,
    @InjectRepository(AgentChannel) private readonly channels: Repository<AgentChannel>,
    @InjectRepository(Organization) private readonly organizations: Repository<Organization>,
    @InjectRepository(Tool) private readonly tools: Repository<Tool>,
    @InjectRepository(Message) private readonly messages: Repository<Message>,
    @InjectRepository(ConnectionGrant) private readonly grants: Repository<ConnectionGrant>,
    @InjectQueue('agent-runtime') private readonly queue: Queue,
    @InjectRedis() private readonly redis: Redis,
    @Inject(forwardRef(() => AgentRuntimeService)) private readonly runtime: AgentRuntimeService,
    @Optional() private readonly moduleRef?: ModuleRef,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly audit?: AuditLogService,
    // Who an unattended run acts as (agent-identity.ts).
    @Optional() private readonly identity?: AgentIdentityService,
    // The owner's time zone, for a daily summary that names none.
    @Optional() @InjectRepository(User) private readonly users?: Repository<User>,
  ) {}

  async onModuleInit(): Promise<void> {
    // A proposal waiting for the owner is reported where its reports go.
    // Connection events wake the agents granted the connection.
    this.stopConnectionEvents = onConnectionEvent((event) => {
      this.onConnectionEvent(event).catch((err: any) =>
        this.logger.warn(`Could not wake agents for connection ${event.connectionId}: ${err?.message ?? err}`),
      );
    });
    try {
      this.runtime.approvals?.on?.('approval.requested', (row: any) => {
        this.onApprovalRequested(row).catch((err: any) =>
          this.logger.warn(`Could not report an approval request: ${err?.message ?? err}`),
        );
      });
      // A rejected or expired proposal ends its run (the runtime cancels it):
      // report that, and look at the wakes that queued behind it.
      this.runtime.approvals?.on?.('approval.decided', (row: any) => {
        if (!row?.runId || row.status === 'approved') return;
        this.afterRunEnds(row.runId).catch((err: any) =>
          this.logger.warn(`Could not finish run ${row.runId} after its approval: ${err?.message ?? err}`),
        );
      });
    } catch {
      /* no approvals on this install */
    }
    if (process.env.DISABLE_ALWAYS_ON === 'true') {
      this.logger.warn('[ALWAYS_ON] DISABLE_ALWAYS_ON=true: timers not restored');
      return;
    }
    await this.restoreTimers();
  }

  // ---------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------

  private poster(): ScheduledResultPoster | null {
    try {
      return (this.moduleRef?.get(SCHEDULED_RESULT_POSTER, { strict: false }) as ScheduledResultPoster) ?? null;
    } catch {
      return null;
    }
  }

  async capacityFor(organizationId: string): Promise<AlwaysOnCapacity> {
    const org = await this.organizations
      .findOne({ where: { id: organizationId }, select: { id: true, plan: true, settings: true } as any })
      .catch(() => null);
    return alwaysOnCapacity(org);
  }

  private async loadAgent(agentId: string, organizationId: string): Promise<Agent> {
    const agent = await this.agents.findOne({ where: { id: agentId, organizationId } });
    if (!agent) throw new NotFoundException('Agent not found');
    return agent;
  }

  /** The agent's always-on settings, what the plan allows, and how it is doing. */
  async view(agentId: string, organizationId: string): Promise<AlwaysOnView> {
    const agent = await this.loadAgent(agentId, organizationId);
    const config = readAlwaysOn(agent.alwaysOn);
    const capacity = await this.capacityFor(organizationId);
    const timer = config?.wakeOn.timer?.everyMinutes;
    let nextWakeAt: string | null = null;
    if (config?.enabled && timer) {
      try {
        const jobs = await this.queue.getRepeatableJobs();
        const job = jobs.find((j) => j.name === ALWAYS_ON_TICK_JOB && j.id === `always-on-${agentId}`);
        nextWakeAt = job?.next ? new Date(job.next).toISOString() : null;
      } catch {
        nextWakeAt = null;
      }
    }
    const last = await this.wakes.findOne({
      where: { agentId, status: In(['consumed', 'queued']) as any },
      order: { createdAt: 'DESC' },
    });
    const queued = await this.wakes.count({ where: { agentId, status: 'queued' } });
    const live = await this.liveRun(agent);
    return {
      alwaysOn: config,
      capacity,
      effectiveTimerMinutes: timer ? effectiveTimerMinutes(timer, capacity) : null,
      effectiveWakesPerHour: effectiveWakesPerHour(config?.maxWakesPerHour, capacity),
      nextWakeAt,
      lastWake: last
        ? { at: last.createdAt.toISOString(), source: last.source, summary: last.summary, runId: last.runId }
        : null,
      queued,
      liveRunId: live?.id ?? null,
      digest: await this.digestTimingFor(agent, config),
      hostedHome: hasHostedHome(config),
      hostedAgentsOn: (await this.hostedAgentsOn(organizationId)).length,
    };
  }

  /** The wakes the agent page lists, newest first. */
  async recentWakes(agentId: string, organizationId: string, limit = 20): Promise<AgentWake[]> {
    await this.loadAgent(agentId, organizationId);
    return this.wakes.find({ where: { agentId }, order: { createdAt: 'DESC' }, take: Math.min(Math.max(limit, 1), 100) });
  }

  /**
   * Change an agent's Always on settings and make the timer agree. Refuses
   * what the plan does not allow (a timer under the floor, more wakes an
   * hour than the plan's), channels and tools that are not the agent's, and
   * a report destination its channel cannot reach.
   */
  async configure(agentId: string, organizationId: string, input: AlwaysOnInput, actorUserId?: string | null): Promise<AlwaysOnView> {
    const agent = await this.loadAgent(agentId, organizationId);
    if (agent.mode !== 'autonomous') {
      throw new BadRequestException('Always on is for autonomous agents. Use a schedule or a webhook for a workflow.');
    }
    const before = readAlwaysOn(agent.alwaysOn);
    const next = mergeAlwaysOn(before, input ?? {});
    const capacity = await this.capacityFor(organizationId);

    if (next.enabled && agent.status !== AgentStatus.ACTIVE) {
      throw new BadRequestException('Activate this agent before turning Always on on. An inactive agent never wakes.');
    }
    const timer = next.wakeOn.timer?.everyMinutes;
    if (timer && timer < capacity.timerFloorMinutes) {
      throw new BadRequestException(
        `On your plan it can wake every ${capacity.timerFloorMinutes} minutes at most. Choose ${capacity.timerFloorMinutes} or more.`,
      );
    }
    if (next.maxWakesPerHour && next.maxWakesPerHour > capacity.maxWakesPerHour) {
      throw new BadRequestException(`On your plan it can wake up to ${capacity.maxWakesPerHour} times an hour.`);
    }
    // Turning one more hosted-home agent on than the plan includes is
    // refused here, with the ones that are on named; one beyond it after the
    // plan changed pauses at its next wake instead (process). An agent on
    // the owner's own machines, or with no machine, is never limited.
    if (next.enabled && !before?.enabled && hasHostedHome(next) && capacity.includedAgents !== null) {
      const others = (await this.hostedAgentsOn(organizationId)).filter((a) => a.id !== agentId);
      if (others.length >= capacity.includedAgents) {
        throw new BadRequestException(capacityRefusal(capacity.includedAgents, others.map((a) => a.name)));
      }
    }

    const ownChannels = await this.channels.find({ where: { agentId, organizationId } });
    const ownIds = new Set(ownChannels.map((c) => c.id));
    const foreign = (next.wakeOn.channelIds ?? []).filter((id) => !ownIds.has(id));
    if (foreign.length) throw new BadRequestException('It can only wake on its own channels.');
    if (next.ownerChannel) {
      const channel = ownChannels.find((c) => c.id === next.ownerChannel!.channelId);
      if (!channel) throw new BadRequestException('Choose one of its own channels to talk to it on.');
      if (channel.type === ChannelType.WEBHOOK) {
        throw new BadRequestException('A webhook has no person behind it. Choose a channel you write on, like Slack or email.');
      }
    }
    const toolIds = new Set(agent.toolIds ?? []);
    const strayTools = next.askFirstToolIds.filter((id) => !toolIds.has(id));
    if (strayTools.length) throw new BadRequestException('The ask-first list can only name tools this agent has.');
    if (next.reportTo) {
      const poster = this.poster();
      if (!poster) throw new BadRequestException('Posting to a channel is not available on this install.');
      next.reportTo = await poster.checkDestination(agent, { ...next.reportTo, kind: 'channel' });
    }

    agent.alwaysOn = next as any;
    await this.agents.save(agent);
    await this.reconcileTimer(agent, capacity);

    if (!before?.enabled && next.enabled) await this.recordAudit(agent, AuditAction.ALWAYS_ON_ENABLE, actorUserId, {});
    else if (before?.enabled && !next.enabled) {
      await this.recordAudit(agent, AuditAction.ALWAYS_ON_DISABLE, actorUserId, {});
      await this.dropQueued(agent.id, 'Always on was turned off');
      // Its place on the plan is free: an agent waiting for room may take it.
      await this.resumeWithinCapacity(organizationId);
    }
    return this.view(agentId, organizationId);
  }

  /**
   * The tools Always on would put on the ask-first list: every tool of the
   * agent that is not read-only. The page pre-fills the list with these.
   */
  async suggestedAskFirst(agentId: string, organizationId: string): Promise<Array<{ id: string; name: string; readOnly: boolean }>> {
    const agent = await this.loadAgent(agentId, organizationId);
    const ids = agent.toolIds ?? [];
    if (!ids.length) return [];
    const tools = await this.tools.find({ where: { id: In(ids), organizationId } as any });
    return tools.map((t) => ({ id: t.id, name: t.name, readOnly: isReadOnlyTool(t as any) }));
  }

  // ---------------------------------------------------------------------
  // The timer
  // ---------------------------------------------------------------------

  private timerJobId(agentId: string): string {
    return `always-on-${agentId}`;
  }

  /** Make the repeatable jobs (the timer, the daily summary) agree with the agent's settings. */
  async reconcileTimer(agent: Agent, capacity?: AlwaysOnCapacity): Promise<void> {
    await this.removeTimer(agent.id);
    const config = readAlwaysOn(agent.alwaysOn);
    if (!config?.enabled || agent.status !== AgentStatus.ACTIVE || agent.mode !== 'autonomous') return;
    const cap = capacity ?? (await this.capacityFor(agent.organizationId));
    await this.scheduleJobs(agent, config, cap);
  }

  /** Add an agent's repeatable jobs: its timer, and its daily summary. Returns how many. */
  private async scheduleJobs(agent: Agent, config: AlwaysOnConfig, capacity: AlwaysOnCapacity): Promise<number> {
    let added = 0;
    const minutes = config.wakeOn.timer?.everyMinutes;
    if (minutes) {
      await this.queue.add(
        ALWAYS_ON_TICK_JOB,
        { agentId: agent.id, organizationId: agent.organizationId },
        {
          repeat: { every: effectiveTimerMinutes(minutes, capacity) * 60_000 },
          jobId: this.timerJobId(agent.id),
          removeOnComplete: 50,
          removeOnFail: 20,
        },
      );
      added++;
    }
    if (config.report === 'daily_digest') {
      // Every day at its time of day in its zone, the way a schedule's time of day runs.
      const timing = await this.digestTimingFor(agent, config);
      await this.queue.add(
        ALWAYS_ON_DIGEST_JOB,
        { agentId: agent.id, organizationId: agent.organizationId },
        {
          repeat: { cron: digestCron(timing.time), tz: timing.timezone },
          jobId: this.digestJobId(agent.id),
          removeOnComplete: 20,
          removeOnFail: 20,
        },
      );
      added++;
    }
    return added;
  }

  async removeTimer(agentId: string): Promise<void> {
    try {
      const jobs = await this.queue.getRepeatableJobs();
      for (const job of jobs) {
        const ours = job.name === ALWAYS_ON_TICK_JOB && job.id === this.timerJobId(agentId);
        const legacy = job.name === LEGACY_HEARTBEAT_JOB && job.id === `heartbeat-${agentId}`;
        const digest = job.name === ALWAYS_ON_DIGEST_JOB && job.id === this.digestJobId(agentId);
        if (ours || legacy || digest) await this.queue.removeRepeatableByKey(job.key);
      }
    } catch (err: any) {
      this.logger.warn(`Could not remove the always-on timer of agent ${agentId}: ${err?.message ?? err}`);
    }
  }

  /**
   * Put every timer and daily summary back at boot. The repeatable jobs
   * live in Redis, and a Redis that lost them (a flush, a failover) used to
   * leave heartbeats switched on in the UI and never firing. One failure
   * does not stop the rest; an agent whose timer cannot be restored is
   * paused and says why. The capacity check is put back too.
   */
  async restoreTimers(): Promise<{ restored: number; failed: number }> {
    let restored = 0;
    let failed = 0;
    try {
      const existing = await this.queue.getRepeatableJobs();
      for (const job of existing) {
        if ([ALWAYS_ON_TICK_JOB, LEGACY_HEARTBEAT_JOB, ALWAYS_ON_DIGEST_JOB, ALWAYS_ON_CAPACITY_JOB].includes(job.name)) {
          await this.queue.removeRepeatableByKey(job.key);
        }
      }
      const agents = await this.agents.find({ where: { status: AgentStatus.ACTIVE, mode: 'autonomous' as any } });
      const capacities = new Map<string, AlwaysOnCapacity>();
      for (const agent of agents) {
        const config = readAlwaysOn(agent.alwaysOn);
        if (!config?.enabled) continue;
        try {
          let cap = capacities.get(agent.organizationId);
          if (!cap) {
            cap = await this.capacityFor(agent.organizationId);
            capacities.set(agent.organizationId, cap);
          }
          if (await this.scheduleJobs(agent, config, cap)) restored++;
        } catch (err: any) {
          failed++;
          this.logger.error(`[ALWAYS_ON] Could not restore the timer of agent ${agent.id}: ${err?.message ?? err}`);
          await this.pause(agent, {
            code: 'RESTORE_FAILED',
            message: 'Its timer could not be restored when the service restarted. Turn Always on back on to start it again.',
            detectedAt: new Date().toISOString(),
          }).catch(() => undefined);
        }
      }
      if (restored) this.logger.log(`[ALWAYS_ON] Restored ${restored} timer(s)`);
      await this.scheduleCapacityCheck();
    } catch (err: any) {
      this.logger.error(`[ALWAYS_ON] Could not restore timers: ${err?.message ?? err}`);
    }
    return { restored, failed };
  }

  /** A timer tick: one wake per tick, whatever the queue redelivers. */
  async tick(agentId: string, organizationId: string, firedAt = new Date()): Promise<AgentWake | null> {
    const agent = await this.agents.findOne({ where: { id: agentId, organizationId } });
    const config = readAlwaysOn(agent?.alwaysOn);
    const minutes = config?.wakeOn.timer?.everyMinutes;
    if (!agent || !config?.enabled || !minutes) {
      await this.removeTimer(agentId);
      return null;
    }
    const bucket = Math.floor(firedAt.getTime() / 60_000);
    return this.wake(agentId, organizationId, 'timer', {
      summary: minutes === 1 ? 'the timer (every minute)' : `the timer (every ${minutes} minutes)`,
      dedupeKey: `timer:${bucket}`,
      sourceRef: null,
    });
  }

  // ---------------------------------------------------------------------
  // Wakes
  // ---------------------------------------------------------------------

  /**
   * The one way into an always-on agent. Writes the wake (once per dedupe
   * key) and asks the queue to look at the agent. A wake for an agent that
   * is not always on is not kept.
   */
  async wake(agentId: string, organizationId: string, source: WakeSource, input: WakeInput): Promise<AgentWake | null> {
    const agent = await this.agents.findOne({ where: { id: agentId, organizationId } });
    const config = readAlwaysOn(agent?.alwaysOn);
    if (!agent || !config?.enabled) return null;

    const payload = boundedPayload({
      ...(input.payload ?? {}),
      ...(input.ownerMessage ? { ownerMessage: { text: bounded(input.ownerMessage.text, 4000), replyTo: input.ownerMessage.replyTo } } : {}),
    });
    const dedupeKey = bounded(input.dedupeKey, 255);
    // The same wake again (a redelivery, a second tick in the same minute).
    if (await this.wakes.findOne({ where: { agentId, dedupeKey } })) return null;
    const row = this.wakes.create({
      organizationId,
      agentId,
      source,
      sourceRef: input.sourceRef ?? null,
      summary: bounded(input.summary, 500),
      payload: payload && Object.keys(payload).length ? payload : null,
      dedupeKey,
      status: 'queued',
      runId: null,
      note: null,
      consumedAt: null,
      createdAt: new Date(),
    });
    try {
      await this.wakes.insert(row);
    } catch (err: any) {
      // Lost the race to the unique index: someone wrote the same wake.
      if (String(err?.code) === '23505' || /duplicate key/i.test(String(err?.message))) return null;
      throw err;
    }

    await this.coalesceOverflow(agentId);
    if (!input.passive) await this.enqueueProcess(agentId, organizationId);
    return row;
  }

  /** Fold away the oldest queued wakes beyond MAX_QUEUED_WAKES. */
  private async coalesceOverflow(agentId: string): Promise<void> {
    const queued = await this.wakes.count({ where: { agentId, status: 'queued' } });
    if (queued <= MAX_QUEUED_WAKES) return;
    const oldest = await this.wakes.find({
      where: { agentId, status: 'queued' },
      order: { createdAt: 'ASC' },
      take: queued - MAX_QUEUED_WAKES,
      select: { id: true } as any,
    });
    if (oldest.length) {
      await this.wakes.update({ id: In(oldest.map((w) => w.id)) }, { status: 'coalesced', note: 'too many wakes waiting' });
    }
  }

  /**
   * Ask the queue to look at an agent. Jobs in the same two seconds share an
   * id and collapse; `process` is safe to run more than once.
   */
  async enqueueProcess(agentId: string, organizationId: string, delayMs = 0): Promise<void> {
    const bucket = Math.floor((Date.now() + delayMs) / 2000);
    await this.queue.add(
      ALWAYS_ON_WAKE_JOB,
      { agentId, organizationId },
      { jobId: `wake:${agentId}:${bucket}`, delay: delayMs, removeOnComplete: true, removeOnFail: 50, attempts: 3, backoff: { type: 'exponential', delay: 2000 } },
    );
  }

  /**
   * The standing thread's run that is still going, if any. The latest run
   * is recorded on the agent when it starts (`alwaysOn.liveRunId`), so this
   * is one lookup however many visitor chats the agent has open.
   */
  private async liveRun(agent: Pick<Agent, 'id' | 'organizationId' | 'alwaysOn'>): Promise<AgentRun | null> {
    const runId = readAlwaysOn(agent.alwaysOn)?.liveRunId;
    if (!runId) return null;
    const run = await this.runs.findOne({ where: { id: runId, agentId: agent.id, organizationId: agent.organizationId } });
    return run && LIVE_STATUSES.includes(run.status) ? run : null;
  }

  private async lock(agentId: string): Promise<string | null> {
    const token = randomUUID();
    const ok = await this.redis.set(`always-on:lock:${agentId}`, token, 'PX', LOCK_TTL_MS, 'NX');
    return ok === 'OK' ? token : null;
  }

  private async unlock(agentId: string, token: string): Promise<void> {
    const key = `always-on:lock:${agentId}`;
    try {
      const held = await this.redis.get(key);
      if (held === token) await this.redis.del(key);
    } catch {
      /* the lock expires on its own */
    }
  }

  /**
   * Turn an agent's queued wakes into a run on its standing thread.
   *
   * Single flight: one worker at a time per agent (a Redis lock), and no new
   * run while one of the thread's runs is live; its next step picks the wakes
   * up (drainInto). A run waiting for the owner's answer gets the owner's own
   * message as that answer.
   */
  async process(agentId: string, organizationId: string): Promise<'started' | 'live' | 'idle' | 'busy' | 'off' | 'paused'> {
    const token = await this.lock(agentId);
    if (!token) {
      await this.enqueueProcess(agentId, organizationId, 3000);
      return 'busy';
    }
    try {
      const agent = await this.agents.findOne({ where: { id: agentId, organizationId } });
      const config = readAlwaysOn(agent?.alwaysOn);
      if (!agent || !config?.enabled || agent.status !== AgentStatus.ACTIVE) {
        await this.dropQueued(agentId, 'Always on is off');
        return 'off';
      }
      // The plan has room for fewer hosted-home agents than are on (it changed,
      // or lapsed): the last turned on pause, and turn back on when there is
      // room. An agent without a hosted home is never beyond it.
      const beyond = await this.beyondIncluded(agent);
      if (beyond) {
        await this.pause(agent, capacityPause(beyond.included, beyond.on));
        return 'paused';
      }
      const queued = await this.wakes.find({
        where: { agentId, status: 'queued' },
        order: { createdAt: 'ASC' },
        take: MAX_WAKES_PER_RUN,
      });
      if (!queued.length) return 'idle';

      const live = await this.liveRun(agent);
      if (live) {
        if (live.status === AgentRunStatus.WAITING_INPUT) {
          const owner = queued.filter((w) => w.payload?.ownerMessage?.text);
          if (owner.length) {
            await this.claim(owner, live.id);
            await this.rememberReplies(live, owner);
            await this.runtime.sendInput(live.id, organizationId, owner.map((w) => w.payload!.ownerMessage.text).join('\n\n'));
          }
        }
        return 'live';
      }
      // Too many wakes in the last hour: something is looping. Pause and say so.
      // Wake now is a person, not a loop: a wake made only of those goes ahead.
      const capacity = await this.capacityFor(organizationId);
      const perHour = effectiveWakesPerHour(config.maxWakesPerHour, capacity);
      const lastHour = queued.every((w) => w.source === 'manual') ? 0 : await this.runsInLastHour(agentId);
      if (lastHour >= perHour) {
        await this.pause(agent, {
          code: 'WAKE_LOOP',
          message: `It woke ${lastHour} times in the last hour, the most it may (${perHour}). It was paused so it does not loop. Look at what woke it, then turn Always on back on.`,
          detectedAt: new Date().toISOString(),
        });
        return 'paused';
      }

      // Judged now, as the owner is now (as a heartbeat was): the owner is
      // who answers for the agent, whoever it runs as.
      const owner = userPrincipal(agentOwnerUserId(agent), 'always_on');
      const access = await this.runtime.executionAccess.canExecute(owner, agent);
      if (!access.allowed) {
        const message = owner.userId
          ? `Its owner can no longer run this agent (${access.reason}), so Always on was paused.`
          : `This agent has no owner who can run it (${access.reason}), so Always on was paused.`;
        await this.pause(agent, { code: 'OWNER_CANNOT_RUN', message, detectedAt: new Date().toISOString() });
        return 'paused';
      }
      // Who the run acts as: the owner, or the agent itself when it acts as
      // itself and the plan still includes that. When the plan lapsed it
      // pauses; it never quietly runs as the owner instead.
      const resolved = this.identity ? await this.identity.resolve(agent, 'always_on') : { principal: owner };
      if (isLapsed(resolved)) {
        await this.pause(agent, resolved.reason);
        return 'paused';
      }
      const principal = resolved.principal;

      // Claim before starting, so a second worker cannot hand the same wakes to another run.
      const claimed = await this.claim(queued, null);
      if (!claimed.length) return 'idle';
      let run: AgentRun;
      try {
        run = await this.runtime.startRun(agentId, organizationId, runUserOf(principal), wakeMessage(config.brief, claimed), {
          principal,
          agentLimits: true,
          ...(config.standingConversationId ? { conversationId: config.standingConversationId } : {}),
          metadata: {
            triggerType: 'always_on',
            wakeIds: claimed.map((w) => w.id),
            replyTo: this.repliesOf(claimed),
          },
        });
      } catch (err: any) {
        // The standing conversation is gone (erased, swept): start a new one.
        if (config.standingConversationId && /Conversation not found/i.test(String(err?.message))) {
          config.standingConversationId = null;
          agent.alwaysOn = config as any;
          await this.agents.save(agent);
          await this.unclaim(claimed);
          await this.enqueueProcess(agentId, organizationId);
          return 'idle';
        }
        await this.wakes.update(
          { id: In(claimed.map((w) => w.id)) },
          { status: 'dropped', note: bounded(`not started: ${err?.message ?? err}`, 255) },
        );
        await this.recordAudit(agent, AuditAction.WAKE_DROPPED, null, { reason: String(err?.message ?? err), wakeIds: claimed.map((w) => w.id) });
        await this.notifyOwner(agent, 'run.failed', `${agent.name} did not wake`, `Its run could not start: ${err?.message ?? err}`);
        return 'idle';
      }
      await this.wakes.update({ id: In(claimed.map((w) => w.id)) }, { runId: run.id });
      // Read again: the settings may have changed while the run started.
      const fresh = await this.agents.findOne({ where: { id: agentId, organizationId } });
      const current = readAlwaysOn(fresh?.alwaysOn);
      if (fresh && current) {
        current.liveRunId = run.id;
        if (!current.standingConversationId && run.conversationId) current.standingConversationId = run.conversationId;
        fresh.alwaysOn = current as any;
        await this.agents.save(fresh);
      }
      return 'started';
    } finally {
      await this.unlock(agentId, token);
    }
  }

  /** Mark wakes consumed (by `runId`, or by a run about to start). Returns the ones this call won. */
  private async claim(wakes: AgentWake[], runId: string | null): Promise<AgentWake[]> {
    const won: AgentWake[] = [];
    const at = new Date();
    for (const wake of wakes) {
      // Compare-and-set on `queued`: a wake two workers both read goes to one.
      const result = await this.wakes.update(
        { id: wake.id, status: 'queued' },
        { status: 'consumed', consumedAt: at, ...(runId ? { runId } : {}) },
      );
      if (result.affected) won.push(Object.assign(wake, { status: 'consumed' as const, consumedAt: at, runId: runId ?? wake.runId }));
    }
    return won;
  }

  /** Runs of the standing thread started in the last hour: the wakes it acted on, by run. */
  /**
   * Runs in the last hour that something other than a person woke. Wake now
   * is a person asking; it never counts toward the loop guard.
   */
  private async runsInLastHour(agentId: string): Promise<number> {
    const rows = await this.wakes.find({
      where: { agentId, status: 'consumed', consumedAt: MoreThan(new Date(Date.now() - 3_600_000)), source: Not('manual') },
      select: { id: true, runId: true } as any,
    });
    return new Set(rows.map((w) => w.runId).filter(Boolean)).size;
  }

  private async unclaim(wakes: AgentWake[]): Promise<void> {
    if (!wakes.length) return;
    await this.wakes.update({ id: In(wakes.map((w) => w.id)) }, { status: 'queued', consumedAt: null, runId: null });
  }

  private repliesOf(wakes: AgentWake[]): ChannelDelivery[] {
    const out: ChannelDelivery[] = [];
    for (const w of wakes) {
      const to = w.payload?.ownerMessage?.replyTo as ChannelDelivery | undefined;
      if (to && !out.some((d) => d.channelId === to.channelId && d.to === to.to)) out.push(to);
    }
    return out;
  }

  private async rememberReplies(run: AgentRun, wakes: AgentWake[]): Promise<void> {
    const replies = this.repliesOf(wakes);
    if (!replies.length) return;
    const existing: ChannelDelivery[] = Array.isArray(run.metadata?.replyTo) ? run.metadata.replyTo : [];
    const merged = [...existing];
    for (const r of replies) if (!merged.some((d) => d.channelId === r.channelId && d.to === r.to)) merged.push(r);
    run.metadata = { ...(run.metadata ?? {}), replyTo: merged };
    await this.runs.update({ id: run.id }, { metadata: run.metadata });
  }

  /**
   * Hand wakes that arrived while a run of the standing thread was working
   * to that run, as one message, before its next model call. Called by the
   * step processor; a no-op for any other run.
   */
  async drainInto(run: AgentRun): Promise<number> {
    if (run.metadata?.triggerType !== 'always_on' || !run.conversationId) return 0;
    const queued = await this.wakes.find({
      where: { agentId: run.agentId, status: 'queued' },
      order: { createdAt: 'ASC' },
      take: MAX_WAKES_PER_RUN,
    });
    if (!queued.length) return 0;
    const claimed = await this.claim(queued, run.id);
    if (!claimed.length) return 0;
    const note = Message.createUserMessage(run.conversationId, whileYouWereWorking(claimed));
    note.runId = run.id;
    await this.messages.save(note);
    await this.rememberReplies(run, claimed);
    run.metadata = {
      ...(run.metadata ?? {}),
      wakeIds: [...(Array.isArray(run.metadata?.wakeIds) ? run.metadata.wakeIds : []), ...claimed.map((w) => w.id)],
    };
    return claimed.length;
  }

  private async dropQueued(agentId: string, note: string): Promise<void> {
    await this.wakes.update({ agentId, status: 'queued' }, { status: 'dropped', note: bounded(note, 255) });
  }

  // ---------------------------------------------------------------------
  // Pausing
  // ---------------------------------------------------------------------

  /** Switch Always on off on the system's own account, say why on the agent, and tell the owner. */
  async pause(agent: Agent, reason: AgentPauseReason): Promise<void> {
    const config = readAlwaysOn(agent.alwaysOn);
    if (!config) return;
    config.enabled = false;
    config.pausedReason = reason;
    agent.alwaysOn = config as any;
    await this.agents.save(agent);
    await this.removeTimer(agent.id);
    await this.dropQueued(agent.id, `paused: ${PAUSE_WORDS[reason.code] ?? reason.code}`);
    await this.recordAudit(agent, AuditAction.ALWAYS_ON_PAUSE, null, { reason });
    await this.notifyOwner(agent, 'agent.paused', `${agent.name} was paused`, reason.message, undefined, {
      resumesItself: reason.code === 'CAPACITY_EXHAUSTED',
    });
    this.logger.warn(`[ALWAYS_ON] Paused agent ${agent.id}: ${reason.code}`);
    // Its place on the plan is free now: an agent waiting for room may take it.
    if (reason.code !== 'CAPACITY_EXHAUSTED') await this.resumeWithinCapacity(agent.organizationId).catch(() => 0);
  }

  // ---------------------------------------------------------------------
  // Plan capacity: how many always-on agents with a hosted home may be on
  // at once. Agents on the owner's own machines, or with no machine, are
  // never counted and never limited, on any plan.
  // ---------------------------------------------------------------------

  /**
   * The organization's always-on agents with a hosted home that are on, in
   * the order the plan counts them: the first turned on first. An agent
   * turned on before `enabledAt` was recorded counts from when it was made.
   */
  async hostedAgentsOn(organizationId: string): Promise<Agent[]> {
    const rows = await this.agents.find({ where: { organizationId, status: AgentStatus.ACTIVE, mode: 'autonomous' as any } });
    const since = (a: Agent) => readAlwaysOn(a.alwaysOn)?.enabledAt ?? (a.createdAt ? new Date(a.createdAt).toISOString() : '');
    return rows
      .filter((a) => {
        const c = readAlwaysOn(a.alwaysOn);
        return !!c?.enabled && hasHostedHome(c);
      })
      .sort((a, b) => since(a).localeCompare(since(b)) || a.id.localeCompare(b.id));
  }

  /**
   * Whether this agent is beyond the hosted-home agents the plan includes:
   * null when it is within them, the plan has no limit, or the agent has no
   * hosted home (then it is never limited), else the numbers the pause names.
   */
  async beyondIncluded(agent: Agent, capacity?: AlwaysOnCapacity): Promise<{ included: number; on: number } | null> {
    if (!hasHostedHome(readAlwaysOn(agent.alwaysOn))) return null;
    const cap = capacity ?? (await this.capacityFor(agent.organizationId));
    if (cap.includedAgents === null) return null;
    const on = await this.hostedAgentsOn(agent.organizationId);
    const rank = on.findIndex((a) => a.id === agent.id);
    return rank >= cap.includedAgents ? { included: cap.includedAgents, on: on.length } : null;
  }

  /**
   * Turn back on the agents paused because the plan had no room, oldest
   * pause first, as far as the plan has room for hosted-home agents now. One
   * without a hosted home takes no room, so it always comes back. Called
   * when an agent is turned off or paused for another reason, and by the
   * capacity check (ALWAYS_ON_CAPACITY_JOB), which notices a plan that changed.
   */
  async resumeWithinCapacity(organizationId: string): Promise<number> {
    const all = await this.agents.find({ where: { organizationId, status: AgentStatus.ACTIVE, mode: 'autonomous' as any } });
    const waiting = all
      .filter((a) => {
        const c = readAlwaysOn(a.alwaysOn);
        return !!c && !c.enabled && c.pausedReason?.code === 'CAPACITY_EXHAUSTED';
      })
      .sort((a, b) =>
        String(readAlwaysOn(a.alwaysOn)?.pausedReason?.detectedAt ?? '').localeCompare(String(readAlwaysOn(b.alwaysOn)?.pausedReason?.detectedAt ?? '')),
      );
    if (!waiting.length) return 0;
    const capacity = await this.capacityFor(organizationId);
    const on = all.filter((a) => {
      const c = readAlwaysOn(a.alwaysOn);
      return !!c?.enabled && hasHostedHome(c);
    }).length;
    let room = capacity.includedAgents === null ? Infinity : Math.max(0, capacity.includedAgents - on);
    const back: Agent[] = [];
    for (const agent of waiting) {
      if (!hasHostedHome(readAlwaysOn(agent.alwaysOn))) back.push(agent);
      else if (room > 0) {
        back.push(agent);
        room--;
      }
    }
    let resumed = 0;
    for (const agent of back) {
      const config = readAlwaysOn(agent.alwaysOn)!;
      config.enabled = true;
      config.pausedReason = null;
      config.enabledAt = new Date().toISOString();
      agent.alwaysOn = config as any;
      await this.agents.save(agent);
      await this.reconcileTimer(agent, capacity);
      await this.recordAudit(agent, AuditAction.ALWAYS_ON_ENABLE, null, { resumed: 'capacity' });
      await this.notifyOwner(
        agent,
        'agent.report',
        `${agent.name} is back on`,
        'Your plan has room for it again, so Always on was turned back on. It picks up where it left off.',
      );
      this.logger.log(`[ALWAYS_ON] Resumed agent ${agent.id}: the plan has room again`);
      resumed++;
    }
    return resumed;
  }

  /** The capacity check: every organization with an agent waiting for room. */
  async resumeAllWithinCapacity(): Promise<number> {
    const agents = await this.agents.find({ where: { status: AgentStatus.ACTIVE, mode: 'autonomous' as any } });
    const orgs = new Set(
      agents.filter((a) => readAlwaysOn(a.alwaysOn)?.pausedReason?.code === 'CAPACITY_EXHAUSTED').map((a) => a.organizationId),
    );
    let resumed = 0;
    for (const org of orgs) {
      resumed += await this.resumeWithinCapacity(org).catch((err: any) => {
        this.logger.warn(`[ALWAYS_ON] Could not resume agents of organization ${org}: ${err?.message ?? err}`);
        return 0;
      });
    }
    return resumed;
  }

  /** The repeatable capacity check, replaced at boot. */
  private async scheduleCapacityCheck(): Promise<void> {
    await this.queue.add(
      ALWAYS_ON_CAPACITY_JOB,
      {},
      { repeat: { every: capacityCheckMinutes() * 60_000 }, jobId: 'always-on-capacity', removeOnComplete: 10, removeOnFail: 10 },
    );
  }

  // ---------------------------------------------------------------------
  // The daily summary
  // ---------------------------------------------------------------------

  private digestJobId(agentId: string): string {
    return `always-on-digest-${agentId}`;
  }

  /** When this agent's summary goes out (always-on-digest.ts). */
  async digestTimingFor(agent: Agent, config: AlwaysOnConfig | null): Promise<DigestTiming> {
    const org = await this.organizations
      .findOne({ where: { id: agent.organizationId }, select: { id: true, settings: true } as any })
      .catch(() => null);
    const ownerId = agentOwnerUserId(agent);
    const owner = ownerId && this.users
      ? await this.users.findOne({ where: { id: ownerId }, select: { id: true, timezone: true } as any }).catch(() => null)
      : null;
    return digestTiming(config, org, owner?.timezone ?? null);
  }

  /**
   * The daily summary (`report: 'daily_digest'`): one message about the
   * last 24 hours, where the reports go and to the owner's notifications.
   * Nothing on a day with nothing in it, and once a day however often the
   * queue fires.
   */
  async digest(agentId: string, organizationId: string, firedAt = new Date()): Promise<'posted' | 'quiet' | 'off' | 'already'> {
    const agent = await this.agents.findOne({ where: { id: agentId, organizationId } });
    const config = readAlwaysOn(agent?.alwaysOn);
    if (!agent || !config?.enabled || config.report !== 'daily_digest') {
      await this.removeDigest(agentId);
      return 'off';
    }
    const timing = await this.digestTimingFor(agent, config);
    const once = await this.redis.set(`always-on:digest:${agentId}:${localDay(firedAt, timing.timezone)}`, firedAt.toISOString(), 'PX', 2 * DIGEST_WINDOW_MS, 'NX');
    if (once !== 'OK') return 'already';

    const since = new Date(firedAt.getTime() - DIGEST_WINDOW_MS);
    const wakes = await this.wakes.find({ where: { agentId, createdAt: MoreThan(since) } });
    const runs = (await this.runs.find({ where: { agentId, organizationId, createdAt: MoreThan(since) } })).filter(
      (r) => r.metadata?.triggerType === 'always_on',
    );
    const live = await this.liveRun(agent);
    const waiting = live?.status === AgentRunStatus.WAITING_APPROVAL ? await this.waitingFor(live) : [];
    let base = process.env.FRONTEND_URL || 'https://app.almyty.com';
    while (base.endsWith('/')) base = base.slice(0, -1);
    const text = digestText({
      agentName: agent.name,
      wakes: wakes.map((w) => ({ source: w.source, status: w.status })),
      runs: runs.map((r) => ({ status: r.status })),
      acted: await this.actedOn(runs),
      waiting,
      approvalsUrl: `${base}/approvals`,
      agentUrl: `${base}/agents/${agent.id}/always-on`,
    });
    if (!text) return 'quiet';

    const poster = this.poster();
    if (poster && config.reportTo) {
      await poster.post(
        agent,
        { kind: 'digest', id: agent.id, status: 'completed', output: text, userId: agentOwnerUserId(agent), metadata: { triggerType: 'always_on' } },
        config.reportTo,
        { timezone: timing.timezone },
      );
    }
    await this.notifyOwner(agent, 'agent.report', `${agent.name}: daily summary`, text, `/agents/${agent.id}/always-on`, { digest: true });
    return 'posted';
  }

  /** Tools that change something, and how often the runs used each. */
  private async actedOn(runs: AgentRun[]): Promise<Array<{ name: string; times: number }>> {
    const counts = new Map<string, number>();
    for (const run of runs) {
      for (const s of (run.steps ?? []) as any[]) {
        if (s?.type !== 'tool_call' || s.error || s.output?.status === 'waiting_approval') continue;
        const id = s.input?.toolId;
        if (typeof id === 'string') counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    if (!counts.size) return [];
    const tools = await this.tools.find({ where: { id: In([...counts.keys()]) } as any });
    return tools
      .filter((t) => !isReadOnlyTool(t as any))
      .map((t) => ({ name: t.name, times: counts.get(t.id) ?? 0 }))
      .sort((a, b) => b.times - a.times || a.name.localeCompare(b.name));
  }

  /** What a run waiting for approval waits on: the tools it asked about, by name. */
  private async waitingFor(run: AgentRun): Promise<string[]> {
    const ids = [
      ...new Set(
        ((run.steps ?? []) as any[])
          .filter((s) => s?.type === 'tool_call' && s.output?.status === 'waiting_approval')
          .map((s) => s.input?.toolId)
          .filter((id): id is string => typeof id === 'string'),
      ),
    ];
    if (!ids.length) return ['something it wants to do'];
    const tools = await this.tools.find({ where: { id: In(ids) } as any });
    const names = tools.map((t) => t.name);
    return names.length ? names : ['something it wants to do'];
  }

  async removeDigest(agentId: string): Promise<void> {
    try {
      const jobs = await this.queue.getRepeatableJobs();
      for (const job of jobs) {
        if (job.name === ALWAYS_ON_DIGEST_JOB && job.id === this.digestJobId(agentId)) await this.queue.removeRepeatableByKey(job.key);
      }
    } catch (err: any) {
      this.logger.warn(`Could not remove the daily summary of agent ${agentId}: ${err?.message ?? err}`);
    }
  }

  // ---------------------------------------------------------------------
  // Reporting
  // ---------------------------------------------------------------------

  /** Whether a run did something besides looking: a tool call that is not read-only and ran. */
  private async acted(run: AgentRun): Promise<boolean> {
    const calls = (run.steps ?? []).filter((s: any) => s?.type === 'tool_call' && !s.error && s.output?.status !== 'waiting_approval');
    const ids = [...new Set(calls.map((s: any) => s.input?.toolId).filter((id: unknown) => typeof id === 'string'))] as string[];
    if (!ids.length) return false;
    const tools = await this.tools.find({ where: { id: In(ids) } as any });
    return tools.some((t) => !isReadOnlyTool(t as any));
  }

  /**
   * Finish a run another listener is ending (a rejected proposal): wait a
   * moment for it to be marked done, then hand it to onRunFinished.
   */
  async afterRunEnds(runId: string, attempts = 10, waitMs = 300): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      const run = await this.runs.findOne({ where: { id: runId }, select: { id: true, status: true, metadata: true } as any });
      if (!run || run.metadata?.triggerType !== 'always_on') return;
      if (run.isDone?.() ?? ['completed', 'failed', 'cancelled', 'timeout'].includes(run.status)) {
        await this.onRunFinished(runId);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  /**
   * A run of the standing thread ended: answer the owner where they wrote,
   * report where the reports go, and look at the inbox again (wakes that
   * came in after its last step are still queued).
   */
  async onRunFinished(runId: string): Promise<void> {
    try {
      const run = await this.runs.findOne({ where: { id: runId } });
      if (!run || run.metadata?.triggerType !== 'always_on' || !run.isDone()) return;
      const claim = await this.runs.update({ id: run.id, deliveredAt: IsNull() }, { deliveredAt: new Date() });
      if (!claim.affected) return;
      const agent = await this.agents.findOne({ where: { id: run.agentId, organizationId: run.organizationId } });
      if (!agent) return;
      const config = readAlwaysOn(agent.alwaysOn);
      const poster = this.poster();
      const result: ScheduledResult = {
        kind: 'run',
        id: run.id,
        status: run.status,
        output: run.output,
        userId: run.userId ?? null,
        error: run.error ?? null,
        executionTime: run.executionTime,
        totalCost: run.totalCost,
        totalTokens: run.totalTokens,
        metadata: run.metadata ?? {},
      };

      const replies: ChannelDelivery[] = Array.isArray(run.metadata?.replyTo) ? run.metadata.replyTo : [];
      if (poster) {
        for (const delivery of replies) await poster.post(agent, result, delivery);
      }
      // A daily summary reports once a day (digest), not after each run.
      const perRun = config?.report !== 'daily_digest';
      const wantsReport = perRun && config?.reportTo && (config.report === 'every_wake' || (await this.acted(run)));
      const alreadyThere = replies.some((r) => r.channelId === config?.reportTo?.channelId && r.to === config?.reportTo?.to);
      if (wantsReport && poster && config?.reportTo && !alreadyThere) {
        await poster.post(agent, result, config.reportTo);
      }
      if (run.status === AgentRunStatus.COMPLETED && perRun && (config?.report === 'every_wake' || (await this.acted(run)))) {
        const text = typeof run.output === 'string' ? run.output : (run.output as any)?.text ?? '';
        await this.notifyOwner(agent, 'agent.report', `${agent.name} reported`, bounded(String(text || 'It finished a wake.'), 280), `/agents/${agent.id}/runs/${run.id}`);
      } else if (run.status !== AgentRunStatus.COMPLETED) {
        await this.notifyOwner(agent, 'run.failed', `${agent.name} stopped`, bounded(run.error || `The run ended ${run.status}.`, 280), `/agents/${agent.id}/runs/${run.id}`);
      }
    } catch (err: any) {
      this.logger.error(`[ALWAYS_ON] Could not finish run ${runId}: ${err?.message ?? err}`);
    } finally {
      const run = await this.runs.findOne({ where: { id: runId }, select: { id: true, agentId: true, organizationId: true, metadata: true } as any }).catch(() => null);
      if (run?.metadata?.triggerType === 'always_on') {
        const waiting = await this.wakes.count({ where: { agentId: run.agentId, status: 'queued' } }).catch(() => 0);
        if (waiting) await this.enqueueProcess(run.agentId, run.organizationId).catch(() => undefined);
      }
    }
  }

  /** A proposal of an always-on run is waiting for the owner: say so where reports go. */
  private async onApprovalRequested(row: { runId?: string | null; id: string; reason?: string | null; organizationId: string }): Promise<void> {
    if (!row?.runId) return;
    const run = await this.runs.findOne({ where: { id: row.runId } });
    if (!run || run.metadata?.triggerType !== 'always_on') return;
    const agent = await this.agents.findOne({ where: { id: run.agentId, organizationId: run.organizationId } });
    const config = readAlwaysOn(agent?.alwaysOn);
    const poster = this.poster();
    if (!agent || !poster) return;
    const targets: ChannelDelivery[] = [
      ...(Array.isArray(run.metadata?.replyTo) ? run.metadata.replyTo : []),
      ...(config?.reportTo ? [config.reportTo] : []),
    ];
    if (!targets.length) return;
    const text = `${agent.name} wants to do something and is waiting for your OK: ${row.reason ?? 'see Approvals'}. Approve or reject it in Approvals.`;
    const seen = new Set<string>();
    for (const delivery of targets) {
      const key = `${delivery.channelId}:${delivery.to ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await poster.post(
        agent,
        // The run's own metadata: the poster records its outcome onto the
        // run, and a stub here would wipe what the run carries (its trigger).
        { kind: 'run', id: run.id, status: 'completed', output: text, userId: run.userId ?? null, metadata: run.metadata ?? {} },
        delivery,
      );
    }
  }

  private async notifyOwner(
    agent: Agent,
    type: 'agent.report' | 'agent.paused' | 'run.failed',
    title: string,
    body: string,
    link?: string,
    // What the email says besides: a daily summary (digest), a pause that ends on its own (resumesItself).
    emailExtra?: { digest?: boolean; resumesItself?: boolean },
  ): Promise<void> {
    const owner = agentOwnerUserId(agent);
    if (!owner || !this.notifications) return;
    const path = link ?? `/agents/${agent.id}`;
    let base = process.env.FRONTEND_URL || 'https://app.almyty.com';
    while (base.endsWith('/')) base = base.slice(0, -1);
    await this.notifications
      .emit({
        type: type as any,
        organizationId: agent.organizationId,
        userIds: [owner],
        title,
        body,
        link: path,
        // The email, for whoever has it on: the agent, what happened, and a link.
        email: { template: type, params: { agentName: agent.name, message: body, error: body, agentUrl: `${base}${path}`, triggerType: 'always_on', ...(emailExtra ?? {}) } },
      } as any)
      .catch(() => undefined);
  }

  private async recordAudit(agent: Agent, action: AuditAction, userId: string | null | undefined, details: Record<string, any>): Promise<void> {
    await this.audit
      ?.log({
        organizationId: agent.organizationId,
        userId: userId ?? undefined,
        action,
        resourceType: AuditResource.AGENT,
        resourceId: agent.id,
        resourceName: agent.name,
        details,
      })
      .catch((err: any) => this.logger.warn(`Could not audit ${action} for agent ${agent.id}: ${err?.message ?? err}`));
  }

  // ---------------------------------------------------------------------
  // Event sources
  // ---------------------------------------------------------------------

  /**
   * A connection event. Wakes the always-on agents that hold a grant on the
   * connection and listed the event.
   */
  async connectionEvent(event: { organizationId: string; connectionId: string; event: ConnectionWakeEvent; name?: string; agentIds: string[] }): Promise<number> {
    let woken = 0;
    const day = new Date().toISOString().slice(0, 10);
    for (const agentId of event.agentIds) {
      const agent = await this.agents.findOne({ where: { id: agentId, organizationId: event.organizationId } });
      const config = readAlwaysOn(agent?.alwaysOn);
      if (!config?.enabled || !config.wakeOn.connectionEvents?.includes(event.event)) continue;
      const words: Record<ConnectionWakeEvent, string> = {
        expiring: 'is about to expire',
        expired: 'has expired',
        rotation_due: 'is due for a new key',
      };
      const row = await this.wake(agentId, event.organizationId, 'connection', {
        summary: `the connection "${event.name ?? event.connectionId}" ${words[event.event]}`,
        dedupeKey: `connection:${event.connectionId}:${event.event}:${day}`,
        sourceRef: event.connectionId,
        payload: { connectionId: event.connectionId, event: event.event },
      });
      if (row) woken++;
    }
    return woken;
  }

  /** A connection event from the bus: the agents with a live grant on the connection. */
  async onConnectionEvent(event: ConnectionEvent): Promise<number> {
    const grants = await this.grants.find({
      where: { connectionId: event.connectionId, organizationId: event.organizationId, principalType: 'agent' },
    });
    const now = Date.now();
    const agentIds = [...new Set(grants.filter((g) => !g.expiresAt || g.expiresAt.getTime() > now).map((g) => g.principalId))];
    if (!agentIds.length) return 0;
    return this.connectionEvent({ ...event, agentIds });
  }
  /** "Wake now" on the agent page. */
  async wakeNow(agentId: string, organizationId: string, userId?: string | null): Promise<AgentWake | null> {
    const agent = await this.loadAgent(agentId, organizationId);
    const config = readAlwaysOn(agent.alwaysOn);
    if (!config?.enabled) throw new BadRequestException('Turn Always on on first.');
    return this.wake(agentId, organizationId, 'manual', {
      summary: 'you asked it to wake now',
      dedupeKey: `manual:${Date.now()}:${userId ?? ''}`,
    });
  }

  /** The always-on agents a channel belongs to (one at most: a channel has one agent), with how the channel wakes it. */
  async channelRole(agentId: string, organizationId: string, channelId: string | null): Promise<{ agent: Agent; config: AlwaysOnConfig; listed: boolean; ownerChannel: boolean } | null> {
    if (!channelId) return null;
    const agent = await this.agents.findOne({ where: { id: agentId, organizationId } });
    const config = readAlwaysOn(agent?.alwaysOn);
    if (!agent || !config?.enabled) return null;
    const listed = (config.wakeOn.channelIds ?? []).includes(channelId);
    const ownerChannel = config.ownerChannel?.channelId === channelId;
    if (!listed && !ownerChannel) return null;
    return { agent, config, listed, ownerChannel };
  }

  /**
   * A message that arrived on one of the agent's channels (docs/always-on.md,
   * "Channel messages"). Decides whether Always on takes it:
   *
   * - A Webhook channel it wakes on: the delivery becomes a wake and nothing
   *   else (no conversation of its own). `consumed`.
   * - The owner's own channel, from the owner's own address: the message
   *   joins the standing thread and the answer goes back there. `consumed`.
   * - Any other channel it wakes on: the sender keeps their own chat, as
   *   always, and the agent gets one line saying someone wrote. Their words
   *   never enter the standing thread, so one visitor cannot leak into
   *   another's answers. `continue`.
   * - A message the agent's own bot sent: dropped by sender, so a report it
   *   posts into a channel it listens to cannot wake it again.
   */
  async routeInbound(msg: InboundForAlwaysOn): Promise<'consumed' | 'continue'> {
    if (!msg.gatewayId || !msg.agentId) return 'continue';
    const channel = await this.channels
      .findOne({ where: { gatewayId: msg.gatewayId, organizationId: msg.organizationId } })
      .catch(() => null);
    if (!channel || channel.agentId !== msg.agentId) return 'continue';
    const role = await this.channelRole(msg.agentId, msg.organizationId, channel.id);
    if (!role) return 'continue';
    const key = msg.deliveryId ? `${channel.id}:${msg.deliveryId}` : `${channel.id}:${msg.senderId ?? ''}:${Date.now()}`;

    if (msg.fromBot) {
      await this.recordAudit(role.agent, AuditAction.WAKE_DROPPED, null, {
        reason: 'the agent\'s own message', channelId: channel.id,
      });
      return channel.type === ChannelType.WEBHOOK && role.listed ? 'consumed' : 'continue';
    }

    if (channel.type === ChannelType.WEBHOOK) {
      if (!role.listed) return 'continue';
      await this.wake(msg.agentId, msg.organizationId, 'webhook', {
        summary: describeWebhook(channel.name, msg.text),
        dedupeKey: `webhook:${key}`,
        sourceRef: channel.id,
        // What was sent, for the agent (wakeMessage); the summary is the line people read.
        payload: { channelId: channel.id, text: bounded(msg.text, 4000) },
      });
      return 'consumed';
    }

    // Email senders can be faked; Slack, Teams and the other platforms sign
    // who wrote. So email from the owner's address counts as the owner only
    // when they said so (ownerChannel.trustEmail); otherwise it is a note
    // like anyone else's.
    const ownerAddress = role.ownerChannel && sameAddress(msg.senderId, role.config.ownerChannel!.address);
    const untrustedEmail = channel.type === ChannelType.EMAIL && !role.config.ownerChannel?.trustEmail;
    if (ownerAddress && !untrustedEmail) {
      await this.wake(msg.agentId, msg.organizationId, 'channel', {
        summary: `your owner wrote on ${channel.name}`,
        dedupeKey: `owner:${key}`,
        sourceRef: channel.id,
        ownerMessage: {
          text: msg.text,
          replyTo: { kind: 'channel', channelId: channel.id, to: role.config.ownerChannel!.address, label: 'you' },
        },
      });
      return 'consumed';
    }

    if (role.listed || ownerAddress) {
      const who = msg.senderName ? bounded(msg.senderName, 60) : 'someone';
      await this.wake(msg.agentId, msg.organizationId, 'channel', {
        summary: `${who} wrote on ${channel.name} (they have their own chat; you do not see it here)`,
        dedupeKey: `channel:${key}`,
        sourceRef: channel.id,
        // A line about someone else's chat does not start a run of its own
        // when a timer will come anyway: it waits for the next wake. A busy
        // channel would otherwise cost a run per message and pause the
        // agent at its hourly limit.
        passive: !!role.config.wakeOn.timer,
      });
    }
    return 'continue';
  }
}
