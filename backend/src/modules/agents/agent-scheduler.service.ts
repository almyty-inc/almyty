import { BadRequestException, Inject, Injectable, Logger, OnModuleInit, Optional, forwardRef } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { InjectQueue, Process, Processor } from '@nestjs/bull';
import { Job, Queue } from 'bull';

import { Agent, AgentStatus } from '../../entities/agent.entity';
import { AgentsService } from './agents.service';
import { AgentExecutionEngine } from './agent-execution.engine';
import { findModelNotFound, isModelNotFoundError } from '../llm-providers/model-errors';
import { agentOwnerUserId } from './agent-owner';
import { AgentExecution, AgentExecutionStatus } from '../../entities/agent-execution.entity';
import {
  ExecutionAccessService,
  UserPrincipal,
  userPrincipal,
} from '../../common/authorization/execution-access.service';
import { User } from '../../entities/user.entity';
import { hasEffectiveMembership } from '../../common/authorization/membership';
import {
  ScheduleTiming,
  describeTiming,
  nextRuns,
  normalizeTiming,
  repeatFor,
  timingOf,
} from './agent-schedule-spec';
import {
  ChannelDelivery,
  SCHEDULED_RESULT_POSTER,
  ScheduleDelivery,
  ScheduledResultPoster,
} from './scheduled-result-poster';

export { validateIntervalMinutes } from './agent-schedule-spec';

/**
 * A schedule as stored on `agent.settings.schedule`. The timing fields are
 * ScheduleTiming's: `kind` 'interval' with `intervalMinutes` (also what a
 * schedule saved before kinds existed is read as), or 'days'/'monthly'
 * with `time`, `days`/`dayOfMonth` and `timezone`.
 */
export interface AgentScheduleConfig extends Partial<ScheduleTiming> {
  enabled: boolean;
  intervalMinutes?: number;
  input: Record<string, any>;
  /** Where the result goes besides the run history. Absent: nowhere else. */
  deliverTo?: ScheduleDelivery | null;
  /** Set when the scheduler paused this schedule on its own (see pauseForBrokenModel). */
  pausedReason?: AgentModelIssue;
}

/** What the schedule endpoints say about a schedule, besides its stored settings. */
export interface ScheduleView {
  schedule: AgentScheduleConfig | null;
  /** The schedule in plain words, e.g. "Every weekday at 8:00, Europe/Berlin". */
  summary: string | null;
  /** The next time it fires, when it is on. */
  nextRunAt: string | null;
}

/** A schedule request: the timing, the input, and where the result goes. */
export interface ScheduleRequest extends Partial<ScheduleTiming> {
  input?: Record<string, any>;
  deliverTo?: ScheduleDelivery | null;
}

import { NotificationsService } from '../notifications/notifications.service';
import { AgentRuntimeService } from './agent-runtime.service';
import { AgentWebhookService } from './agent-webhook.service';
import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { runsOnAutonomousRuntime } from './agent-invocation';
import { ScheduledResult } from './scheduled-result-poster';

/** What a scheduled tick asks an autonomous agent: the input's message, else the input itself. */
export function scheduledTask(input: Record<string, any> | null | undefined): string {
  if (typeof input?.message === 'string' && input.message.trim()) return input.message;
  if (input && Object.keys(input).length > 0) return JSON.stringify(input);
  return 'Do your scheduled task now.';
}

/** A finished workflow execution, as the poster reads it. */
export function resultOfExecution(execution: AgentExecution): ScheduledResult {
  return {
    kind: 'execution',
    id: execution.id,
    status: execution.status,
    output: execution.output,
    userId: execution.userId ?? null,
    error: execution.error ?? null,
    executionTime: execution.executionTime,
    totalCost: execution.totalCost,
    totalTokens: execution.totalTokens,
    metadata: execution.metadata ?? {},
  };
}

/** A finished autonomous run, as the poster reads it. */
export function resultOfRun(run: AgentRun): ScheduledResult {
  return {
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
}

/**
 * Recorded on agent.settings.modelIssue when a vendor reports that the
 * model an agent is configured with no longer exists. Cleared when the
 * schedule is re-enabled (i.e. someone has looked at it).
 */
export interface AgentModelIssue {
  code: 'MODEL_NOT_FOUND';
  model: string;
  providerId?: string;
  message: string;
  detectedAt: string;
}


const QUEUE_NAME = 'agent-scheduler';

type BrokenModel = { code: 'MODEL_NOT_FOUND'; model: string; providerId?: string; message: string };

/** A MODEL_NOT_FOUND note recorded on any node of a finished execution. */
export function brokenModelFrom(nodeResults: Record<string, any> | undefined | null): BrokenModel | undefined {
  for (const r of Object.values(nodeResults ?? {})) {
    if (r && r.errorCode === 'MODEL_NOT_FOUND') {
      return { code: 'MODEL_NOT_FOUND', model: r.errorModel ?? 'unknown', providerId: r.errorProviderId, message: r.error ?? 'Model not available' };
    }
  }
  return undefined;
}

function asIssue(err: unknown): BrokenModel | undefined {
  const e = err as any;
  return e && e.code === 'MODEL_NOT_FOUND' && typeof e.model === 'string' ? e : undefined;
}

@Injectable()
@Processor(QUEUE_NAME)
export class AgentSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(AgentSchedulerService.name);

  constructor(
    private readonly agentsService: AgentsService,
    private readonly executionEngine: AgentExecutionEngine,
    @InjectRepository(Agent)
    private readonly agentRepo: Repository<Agent>,
    @InjectQueue(QUEUE_NAME)
    private readonly schedulerQueue: Queue,
    // Fire-time authorization: a tick runs as the agent's owner now, and
    // only if that owner may still run the agent.
    private readonly executionAccess: ExecutionAccessService,
    @InjectRepository(AgentExecution)
    private readonly executionRepo: Repository<AgentExecution>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    // Reaches the channel poster the gateways module provides (see
    // scheduled-result-poster.ts). Optional so the positional unit tests
    // construct the service; without it a channel delivery is refused.
    @Optional()
    private readonly moduleRef?: ModuleRef,
    @Optional()
    private readonly notifications?: NotificationsService,
    // Runs an autonomous agent's scheduled tick (the workflow engine runs
    // the others). Optional so the positional unit tests construct this.
    @Optional()
    @Inject(forwardRef(() => AgentRuntimeService))
    private readonly runtime?: AgentRuntimeService,
    @Optional()
    @InjectRepository(AgentRun)
    private readonly runRepo?: Repository<AgentRun>,
    @Optional()
    private readonly webhooks?: AgentWebhookService,
  ) {}

  async onModuleInit() {
    // Emergency-disable gate. Set DISABLE_AGENT_SCHEDULER=true on the
    // pod to skip both restore-on-boot and execution. Used to bisect
    // whether a runaway scheduled agent is the cause of pod OOMs in
    // production — clear this once root cause is identified.
    if (process.env.DISABLE_AGENT_SCHEDULER === 'true') {
      this.logger.warn('[SCHEDULER_DISABLED] DISABLE_AGENT_SCHEDULER=true — skipping schedule restore on boot');
      return;
    }
    await this.restoreSchedules();
  }

  /** The channel poster, or null on an install where the gateways module is not loaded. */
  private poster(): ScheduledResultPoster | null {
    try {
      return (this.moduleRef?.get(SCHEDULED_RESULT_POSTER, { strict: false }) as ScheduledResultPoster) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Turn an agent's schedule on, or change it.
   *
   * `timing` is either a number of minutes (the original "every N
   * minutes" call) or a ScheduleRequest: a time of day on chosen days or
   * one day of the month, in a time zone -- the zone of `actingUserId`'s
   * profile when the request names none, else UTC -- plus the input and
   * where the result goes.
   */
  async scheduleAgent(
    agentId: string,
    organizationId: string,
    timing: number | ScheduleRequest,
    input: Record<string, any> = {},
    actingUserId?: string | null,
  ): Promise<Agent> {
    const request: ScheduleRequest =
      typeof timing === 'number' || timing == null ? { kind: 'interval', intervalMinutes: timing as number } : timing;
    const zone = await this.profileZone(actingUserId);
    const validated = normalizeTiming(request as Record<string, any>, zone);
    const agent = await this.agentsService.getAgent(agentId, organizationId);

    // Say no here rather than at the first tick.
    //
    // handleScheduledExecution refuses to run a non-ACTIVE agent and
    // removes the job, and restoreSchedules only restores ACTIVE ones --
    // but nothing stopped you scheduling a draft. The schedule saved,
    // the card counted down to the next run, and the job quietly deleted
    // itself the first time it fired. Agents are created as DRAFT, so
    // this was the default outcome for anyone who set a schedule before
    // activating.
    if (agent.status !== AgentStatus.ACTIVE) {
      throw new BadRequestException(
        'Activate this agent before scheduling it. A schedule on an inactive agent never runs.',
      );
    }

    const deliverTo = await this.checkDelivery(agent, request.deliverTo);

    // Update agent settings with schedule config
    const settings = { ...(agent.settings || {}) };
    settings.schedule = {
      enabled: true,
      ...validated,
      input: request.input ?? input,
      ...(deliverTo ? { deliverTo } : {}),
    } as AgentScheduleConfig;
    // Re-enabling is the acknowledgement: whoever did it has seen the note.
    delete settings.modelIssue;

    agent.settings = settings;

    const saved = await this.agentRepo.save(agent);

    // Add repeatable job to Bull
    await this.addRepeatableJob(saved);

    this.logger.log(`[SCHEDULE] Agent ${agentId} scheduled: ${describeTiming(validated)}`);
    return saved;
  }

  /** The time zone on a person's profile, if they set one. */
  private async profileZone(userId?: string | null): Promise<string | null> {
    if (!userId) return null;
    const user = await this.userRepo
      .findOne({ where: { id: userId }, select: { id: true, timezone: true } as any })
      .catch(() => null);
    return user?.timezone ?? null;
  }

  /** Validate where the result goes; null for nowhere else. */
  private async checkDelivery(agent: Agent, deliverTo: ScheduleDelivery | null | undefined): Promise<ScheduleDelivery | null> {
    if (!deliverTo) return null;
    if (deliverTo.kind === 'webhook') {
      if (!agent.webhookUrl) {
        throw new BadRequestException('This agent has no webhook URL. Add one first, or send the result somewhere else.');
      }
      return { kind: 'webhook' };
    }
    if (deliverTo.kind === 'channel') {
      const poster = this.poster();
      if (!poster) throw new BadRequestException('Posting to a channel is not available on this install.');
      return poster.checkDestination(agent, deliverTo);
    }
    throw new BadRequestException('Send the result to a webhook or one of the agent\'s channels.');
  }

  /**
   * The schedule as the page shows it: the stored settings, the same
   * thing in plain words, and when it next fires. An interval's next run
   * is the queue's (it counts from when the repeat was registered); a
   * time of day's is computed from its cron expression and zone, the way
   * the queue computes it.
   */
  async describeSchedule(agent: Agent, now = new Date()): Promise<ScheduleView> {
    const schedule = (agent.settings?.schedule as AgentScheduleConfig | undefined) ?? null;
    if (!schedule) return { schedule: null, summary: null, nextRunAt: null };
    let summary: string | null = null;
    try {
      summary = describeTiming(timingOf(schedule));
    } catch {
      summary = null;
    }
    let nextRunAt: string | null = null;
    if (schedule.enabled) {
      try {
        const timing = timingOf(schedule);
        if (timing.kind === 'interval') {
          const jobs = await this.schedulerQueue.getRepeatableJobs();
          const job = jobs.find((j) => j.id === `schedule-${agent.id}`);
          nextRunAt = job?.next ? new Date(job.next).toISOString() : null;
        } else {
          nextRunAt = nextRuns(timing, now, 1)[0]?.toISOString() ?? null;
        }
      } catch {
        nextRunAt = null;
      }
    }
    return { schedule, summary, nextRunAt };
  }

  /**
   * What a schedule would do, without saving it: the plain words and the
   * next few runs. The schedule page shows this while a person is still
   * choosing.
   */
  async previewSchedule(
    request: ScheduleRequest,
    actingUserId?: string | null,
    now = new Date(),
  ): Promise<{ summary: string; nextRuns: string[]; timezone: string | null }> {
    const timing = normalizeTiming(request as Record<string, any>, await this.profileZone(actingUserId));
    return {
      summary: describeTiming(timing),
      nextRuns: nextRuns(timing, now, 3).map((d) => d.toISOString()),
      timezone: timing.timezone ?? null,
    };
  }

  /** The agent's channels a scheduled result can be posted to. */
  async deliveryOptions(agentId: string, organizationId: string) {
    const agent = await this.agentsService.getAgent(agentId, organizationId);
    const poster = this.poster();
    return {
      webhookUrl: agent.webhookUrl ?? null,
      channels: poster ? await poster.destinations(agent) : [],
    };
  }

  /**
   * Stop a schedule whose model the vendor has retired, and leave a note
   * on the agent (settings.modelIssue + schedule.pausedReason) that the
   * UI surfaces. Re-enabling the schedule after fixing the model clears it.
   */
  /**
   * The user a scheduled run acts as. `null` is an agent with no recorded
   * owner, which runs as nobody (agentOwnerUserId). `undefined` is an
   * owner who can no longer run it: the account is inactive or is no
   * longer an effective member of the agent's organization.
   */
  private async scheduleOwner(agent: Agent): Promise<string | null | undefined> {
    const ownerId = agentOwnerUserId(agent);
    if (!ownerId) return null;
    const user = await this.userRepo
      .findOne({ where: { id: ownerId }, relations: { organizationMemberships: true } })
      .catch(() => null);
    if (!user || user.isActive === false) return undefined;
    return hasEffectiveMembership(user.organizationMemberships, agent.organizationId) ? user.id : undefined;
  }


  /** Pause a schedule whose owner can no longer run it, and say why. */
  private async pauseForOwner(agent: Agent): Promise<void> {
    const settings = { ...(agent.settings || {}) };
    if (settings.schedule) {
      settings.schedule = {
        ...settings.schedule,
        enabled: false,
        pausedReason: {
          code: 'OWNER_NOT_MEMBER',
          message:
            'The member who owns this agent is no longer active in the organization, so its schedule was paused. Re-enable it as a current member to start it again.',
          detectedAt: new Date().toISOString(),
        } as any,
      };
    }
    agent.settings = settings;
    await this.agentRepo.save(agent);
    await this.removeRepeatableJob(agent.id);
    this.logger.warn(`[SCHEDULED_RUN] Paused schedule for agent ${agent.id}: its owner is not a current member`);
  }

  async pauseForBrokenModel(agentId: string, organizationId: string, err: unknown): Promise<void> {
    const agent = await this.agentRepo.findOne({ where: { id: agentId, organizationId } });
    if (!agent) return;
    const cause = findModelNotFound(err) ?? asIssue(err);
    const issue: AgentModelIssue = {
      code: 'MODEL_NOT_FOUND',
      model: cause?.model ?? 'unknown',
      providerId: cause?.providerId,
      message: cause?.message ?? (err as Error)?.message ?? 'Model not available',
      detectedAt: new Date().toISOString(),
    };
    const settings = { ...(agent.settings || {}) };
    if (settings.schedule) {
      settings.schedule = { ...settings.schedule, enabled: false, pausedReason: issue };
    }
    settings.modelIssue = issue;
    agent.settings = settings;
    await this.agentRepo.save(agent);
    await this.removeRepeatableJob(agentId);
    this.logger.warn(
      `[SCHEDULED_RUN] Paused schedule for agent ${agentId}: model "${issue.model}" is no longer served by its provider`,
    );
  }

  /**
   * Stop a schedule whose owner can no longer run its agent -- they left
   * the agent's team, or the organization, or the agent became somebody
   * else's private agent. Not a silent skip: a FAILED execution is written
   * with a reason a person can act on (it shows in the agent's run
   * history), and the schedule is disabled with the same reason on
   * `schedule.pausedReason`. Re-enabling it -- by someone who can run the
   * agent, since a schedule runs as the agent's owner -- starts it again.
   */
  async pauseForLostAccess(agent: Agent, principal: UserPrincipal, reason: string): Promise<void> {
    const message = principal.userId
      ? `Scheduled run refused: the agent's owner (${principal.userId}) can no longer run this agent ` +
        `(${reason}). The schedule has been paused.`
      : `Scheduled run refused: this agent has no owner who can run it (${reason}). The schedule has been paused.`;
    try {
      await this.executionRepo.save(
        this.executionRepo.create({
          agentId: agent.id,
          organizationId: agent.organizationId,
          userId: principal.userId,
          status: AgentExecutionStatus.FAILED,
          input: {},
          error: message,
          metadata: { triggerType: 'scheduled', refusedBy: 'execution_access' },
        }),
      );
    } catch (err: any) {
      this.logger.error(`[SCHEDULED_RUN] Could not record the refused run for agent ${agent.id}: ${err.message}`);
    }
    const settings = { ...(agent.settings || {}) };
    if (settings.schedule) {
      settings.schedule = {
        ...settings.schedule,
        enabled: false,
        pausedReason: { code: 'OWNER_CANNOT_RUN', message, detectedAt: new Date().toISOString() } as any,
      };
    }
    agent.settings = settings;
    await this.agentRepo.save(agent);
    await this.removeRepeatableJob(agent.id);
    this.logger.warn(`[SCHEDULED_RUN] Paused schedule for agent ${agent.id}: ${message}`);
  }

  async unscheduleAgent(agentId: string, organizationId: string): Promise<Agent> {

    const agent = await this.agentsService.getAgent(agentId, organizationId);

    // Remove repeatable job from BullMQ
    await this.removeRepeatableJob(agentId);

    // Update settings
    const settings = { ...(agent.settings || {}) };
    if (settings.schedule) {
      settings.schedule = {
        ...settings.schedule,
        enabled: false,
      };
    }

    agent.settings = settings;
    const saved = await this.agentRepo.save(agent);

    this.logger.log(`[UNSCHEDULE] Agent ${agentId} unscheduled — BullMQ job removed`);
    return saved;
  }


  async restoreSchedules(): Promise<void> {
    try {
      // Clean up any orphaned repeatable jobs first
      const existingJobs = await this.schedulerQueue.getRepeatableJobs();
      for (const job of existingJobs) {
        await this.schedulerQueue.removeRepeatableByKey(job.key);
      }

      // ACTIVE only, matching the gate in handleScheduledExecution:
      // restoring a draft agent's job would only have it removed again on
      // its first tick. Scheduling a non-active agent is refused up front
      // instead, in scheduleAgent.
      const agents = await this.agentRepo.find({
        where: { status: AgentStatus.ACTIVE },
      });

      // The repeatable-job table is now empty (we just cleared it), so call
      // the cleanup-free enqueue helper directly. The previous shape called
      // addRepeatableJob -> removeRepeatableJob -> getRepeatableJobs inside
      // every iteration, which made restore O(N^2) on startup.
      let restoredCount = 0;
      const failed: Agent[] = [];
      for (const agent of agents) {
        const schedule = agent.settings?.schedule as AgentScheduleConfig | undefined;
        if (!schedule?.enabled) continue;

        // Skip silently if a stored schedule is corrupted — restore must
        // not crash the whole boot path because one row has a bad value.
        let repeat: ReturnType<typeof repeatFor>;
        try {
          repeat = repeatFor(timingOf(schedule));
        } catch (err: any) {
          this.logger.warn(`[RESTORE] Skipping agent ${agent.id}: ${err.message}`);
          continue;
        }

        // Per agent, so one failure does not abandon the rest.
        //
        // This block clears every repeatable job before rebuilding them,
        // and a throw part-way through used to escape to the outer catch
        // — which logged one line and let the process finish booting
        // with the queue emptied and only partly repopulated. Nothing in
        // the UI changed, because `settings.schedule.enabled` stays
        // true, so the agent went on reading as "scheduled every 15
        // minutes" and never ran again until somebody toggled it.
        try {
          await this.enqueueRepeatableJob(agent, repeat, schedule.input || {});
          restoredCount++;
        } catch (err: any) {
          failed.push(agent);
          this.logger.error(`[RESTORE] Could not restore agent ${agent.id}: ${err.message}`);
        }
      }

      if (restoredCount > 0) {
        this.logger.log(`[RESTORE] Restored ${restoredCount} scheduled agent(s)`);
      }

      // Say so on the agents themselves, through the same channel
      // pauseForBrokenModel uses, so the schedule card stops claiming a
      // next run that is not coming.
      for (const agent of failed) {
        try {
          const settings = { ...(agent.settings || {}) };
          if (settings.schedule) {
            settings.schedule = {
              ...settings.schedule,
              enabled: false,
              pausedReason: {
                code: 'RESTORE_FAILED',
                message:
                  'This schedule could not be restored when the service restarted. Re-enable it to start it again.',
                detectedAt: new Date().toISOString(),
              } as any,
            };
          }
          agent.settings = settings;
          await this.agentRepo.save(agent);
        } catch (err: any) {
          this.logger.error(`[RESTORE] Could not mark agent ${agent.id} as unrestored: ${err.message}`);
        }
      }
      if (failed.length > 0) {
        this.logger.error(`[RESTORE] ${failed.length} schedule(s) could not be restored and were paused`);
      }
    } catch (err: any) {
      this.logger.error(`[RESTORE] Failed to restore schedules: ${err.message}`);
    }
  }

  private async addRepeatableJob(agent: Agent): Promise<void> {
    // Remove existing job for this agent first
    await this.removeRepeatableJob(agent.id);

    const schedule = agent.settings?.schedule as AgentScheduleConfig | undefined;
    const repeat = schedule ? repeatFor(timingOf(schedule)) : { every: 60 * 60 * 1000 };
    const input = schedule?.input || {};

    await this.enqueueRepeatableJob(agent, repeat, input);
  }

  /**
   * One repeatable job per agent, keyed `schedule-<agentId>`. `repeat` is
   * `{ every }` for an interval or `{ cron, tz }` for a time of day; Bull
   * evaluates the cron expression in the zone, so the run follows the
   * wall clock there across daylight saving changes.
   */
  private async enqueueRepeatableJob(
    agent: Agent,
    repeat: ReturnType<typeof repeatFor>,
    input: Record<string, any>,
  ): Promise<void> {
    await this.schedulerQueue.add(
      'execute-agent',
      {
        agentId: agent.id,
        organizationId: agent.organizationId,
        // No user in the payload: the run is the agent's current owner's,
        // read when it fires (handleScheduledExecution).
        input,
      },
      {
        repeat,
        jobId: `schedule-${agent.id}`,
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );
  }

  private async removeRepeatableJob(agentId: string): Promise<void> {
    try {
      const jobs = await this.schedulerQueue.getRepeatableJobs();
      for (const job of jobs) {
        if (job.id === `schedule-${agentId}`) {
          await this.schedulerQueue.removeRepeatableByKey(job.key);
          this.logger.log(`[REMOVE_JOB] Removed repeatable job for agent ${agentId}`);
        }
      }
    } catch (err: any) {
      this.logger.warn(`[REMOVE_JOB] Failed to remove job for agent ${agentId}: ${err.message}`);
    }
  }

  /**
   * A scheduled run that did not start because its channel may not take a
   * post now (the channel is off, or its spend limit is reached). Written
   * as a failed run with the reason, and the owner is told, the same way a
   * failed scheduled run is.
   */
  private async refuseForChannel(agent: Agent, owner: string | null, delivery: ChannelDelivery, reason: string): Promise<void> {
    const message = `Not run: ${reason}`;
    try {
      await this.executionRepo.save(
        this.executionRepo.create({
          agentId: agent.id,
          organizationId: agent.organizationId,
          userId: owner,
          status: AgentExecutionStatus.FAILED,
          input: {},
          error: message,
          metadata: {
            triggerType: 'scheduled',
            channelDelivery: {
              status: 'skipped',
              channelId: delivery.channelId,
              destination: delivery.label ?? delivery.to,
              error: reason,
              at: new Date().toISOString(),
            },
          },
        }),
      );
    } catch (err: any) {
      this.logger.error(`[SCHEDULED_RUN] Could not record the skipped run for agent ${agent.id}: ${err.message}`);
    }
    const recipient = agent.visibility === 'private' ? agentOwnerUserId(agent) : owner;
    if (!recipient || !this.notifications) return;
    await this.notifications
      .emit({
        type: 'run.failed',
        organizationId: agent.organizationId,
        userIds: [recipient],
        title: `Scheduled run skipped: ${agent.name}`,
        body: message,
        link: `/agents/${agent.id}`,
      })
      .catch(() => undefined);
  }

  @Process('execute-agent')
  async handleScheduledExecution(job: Job): Promise<void> {
    // Same emergency gate as onModuleInit. The repeatable job entries
    // already exist in Redis from prior boots; setting the env var
    // alone wouldn't stop them firing without also short-circuiting
    // the processor.
    if (process.env.DISABLE_AGENT_SCHEDULER === 'true') {
      this.logger.warn('[SCHEDULER_DISABLED] dropping scheduled-execution job');
      return;
    }

    const { agentId, organizationId, input } = job.data;

    if (!agentId || !organizationId) {
      this.logger.warn(`[SCHEDULED_RUN] Missing agentId/organizationId in job payload — dropping`);
      return;
    }

    try {
      // Verify agent is still active. Scope to organizationId so a stale or
      // crafted job payload can never run an agent against the wrong org —
      // it just looks like the agent doesn't exist and the job is removed.
      const agent = await this.agentRepo.findOne({ where: { id: agentId, organizationId } });
      if (!agent || agent.status !== AgentStatus.ACTIVE) {
        this.logger.warn(`[SCHEDULED_RUN] Agent ${agentId} is not active — skipping`);
        await this.removeRepeatableJob(agentId);
        return;
      }

      const schedule = agent.settings?.schedule as AgentScheduleConfig | undefined;
      if (!schedule?.enabled) {
        this.logger.warn(`[SCHEDULED_RUN] Agent ${agentId} schedule disabled — removing job`);
        await this.removeRepeatableJob(agentId);
        return;
      }

      // A scheduled run acts as the agent's creator. It used to take the
      // user id written into the job when the schedule was set and run as
      // them on every tick, whether or not they were still in the
      // organization -- a removed member's schedule kept running with
      // their identity (and their private tools and credentials). An
      // owner has to be an active, current member at tick time; an agent
      // with no recorded owner runs as nobody (see agentOwnerUserId).
      const owner = await this.scheduleOwner(agent);
      if (owner === undefined) {
        await this.pauseForOwner(agent);
        return;
      }

      this.logger.log(`[SCHEDULED_RUN] Executing agent ${agentId}`);
      // Then the scope: the owner, as they are now, must still be allowed
      // to run this agent (a team agent whose owner left the team stops,
      // visibly, instead of running for somebody outside it).
      const principal = userPrincipal(owner ?? null, 'schedule');
      const access = await this.executionAccess.canExecute(principal, agent);
      if (!access.allowed) {
        await this.pauseForLostAccess(agent, principal, access.reason);
        return;
      }

      // A result bound for a channel is only worth a run the channel can
      // take: one switched off, or whose spend limit is reached, would
      // refuse the post after the run had been paid for.
      const delivery = schedule.deliverTo?.kind === 'channel' ? schedule.deliverTo : null;
      const poster = delivery ? this.poster() : null;
      if (delivery) {
        const admitted = poster
          ? await poster.admit(agent, delivery)
          : { ok: false as const, reason: 'posting to a channel is not available on this install' };
        if (!admitted.ok) {
          await this.refuseForChannel(agent, owner, delivery, (admitted as { reason: string }).reason);
          return;
        }
      }

      // Run it on the engine that owns the agent: an autonomous agent on
      // the autonomous runtime, a workflow on the workflow engine -- the
      // same dispatch every other entry point makes (runsOnAutonomousRuntime).
      // Sending an autonomous agent to the workflow engine ran its (empty)
      // pipeline, which finished at once with no output.
      if (runsOnAutonomousRuntime(agent)) {
        if (!this.runtime) throw new Error('The autonomous runtime is not available on this server');
        await this.runtime.startRun(agent.id, organizationId, owner, scheduledTask(input), {
          principal,
          // Where the result goes is decided now and carried by the run, so
          // it is posted when the run finishes (deliverScheduledRun), on
          // whichever worker that is, without holding this queue meanwhile.
          metadata: { triggerType: 'scheduled', scheduledDelivery: schedule.deliverTo ?? null, scheduleTimezone: schedule.timezone ?? null },
        });
        return;
      }

      const execution = await this.executionEngine.execute(
        agent,
        organizationId,
        owner,
        {
          input,
          metadata: { triggerType: 'scheduled' },
          principal,
        },
      );
      // The engine reports node failures in the returned execution rather
      // than throwing, so look there for a model the vendor retired.
      const broken = brokenModelFrom(execution?.nodeResults);
      if (broken) {
        await this.pauseForBrokenModel(agentId, organizationId, broken);
      }
      if (delivery && poster && execution?.id) {
        await poster.post(agent, resultOfExecution(execution), delivery, { timezone: schedule.timezone });
      }
    } catch (err: any) {
      this.logger.error(`[SCHEDULED_RUN] Failed for agent ${agentId}: ${err.message}`);
      // A model the vendor no longer serves will fail identically on every
      // tick until someone changes it. Pause the schedule and record why,
      // so the dashboard can show "pick a new model" instead of an alert
      // firing every interval.
      if (isModelNotFoundError(err)) {
        await this.pauseForBrokenModel(agentId, organizationId, err);
      }

    }
  }

  /**
   * Hand on the result of a scheduled autonomous run once it has finished:
   * to the channel or the webhook its schedule named when it started.
   * Called by the runtime's step processor whenever a run ends, on
   * whichever worker ran its last step; `deliveredAt` is claimed first, so
   * a step processed twice cannot post twice.
   */
  async deliverScheduledRun(runId: string): Promise<void> {
    try {
      if (!this.runRepo) return;
      const run = await this.runRepo.findOne({ where: { id: runId } });
      if (!run || run.metadata?.triggerType !== 'scheduled' || !run.isDone()) return;
      const claim = await this.runRepo.update({ id: run.id, deliveredAt: IsNull() }, { deliveredAt: new Date() });
      if (!claim.affected) return;

      const agent = await this.agentRepo.findOne({ where: { id: run.agentId, organizationId: run.organizationId } });
      if (!agent) return;

      // A model the vendor retired fails the same way on every tick: pause
      // the schedule, as a workflow run's does. The step processor recorded
      // the issue on the agent while this run failed.
      const issue = agent.settings?.modelIssue as AgentModelIssue | undefined;
      if (run.status === AgentRunStatus.FAILED && issue?.code === 'MODEL_NOT_FOUND' && Date.parse(issue.detectedAt) >= run.createdAt.getTime() - 1000) {
        await this.pauseForBrokenModel(agent.id, agent.organizationId, issue);
      }

      const delivery = run.metadata?.scheduledDelivery as ScheduleDelivery | null | undefined;
      const result = resultOfRun(run);
      if (delivery?.kind === 'channel') {
        const poster = this.poster();
        if (poster) await poster.post(agent, result, delivery, { timezone: run.metadata?.scheduleTimezone ?? undefined });
      } else if (delivery?.kind === 'webhook' && this.webhooks) {
        await this.webhooks.sendExecutionWebhook(agent, result as any, {
          chosen: true,
          record: async (outcome) => {
            await this.runRepo!.update({ id: run.id }, { metadata: { ...(run.metadata ?? {}), webhookDelivery: outcome } });
          },
        });
      }
    } catch (err: any) {
      this.logger.error(`[SCHEDULED_RUN] Could not hand on the result of run ${runId}: ${err?.message ?? err}`);
    }
  }

  async getScheduledAgents(): Promise<{ agentId: string; interval: number; cron: string | null; nextRun: Date }[]> {
    const jobs = await this.schedulerQueue.getRepeatableJobs();
    return jobs.map(job => ({
      agentId: job.id?.replace('schedule-', '') || 'unknown',
      interval: job.every ? Number(job.every) / 60000 : 0,
      cron: job.cron ?? null,
      nextRun: new Date(job.next),
    }));
  }
}
