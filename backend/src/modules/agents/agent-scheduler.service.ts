import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue, Process, Processor } from '@nestjs/bull';
import { Job, Queue } from 'bull';

import { Agent, AgentStatus } from '../../entities/agent.entity';
import { AgentsService } from './agents.service';
import { AgentExecutionEngine } from './agent-execution.engine';

export interface AgentScheduleConfig {
  enabled: boolean;
  intervalMinutes: number;
  input: Record<string, any>;
}

const QUEUE_NAME = 'agent-scheduler';

/** Bounds on intervalMinutes. Below the floor we'd flood Redis; above the
 *  ceiling BullMQ can mishandle the timestamp arithmetic. */
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 60 * 24 * 365; // 1 year

function validateIntervalMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BadRequestException('intervalMinutes must be a finite number');
  }
  if (value < MIN_INTERVAL_MINUTES || value > MAX_INTERVAL_MINUTES) {
    throw new BadRequestException(
      `intervalMinutes must be between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES}`,
    );
  }
  return Math.floor(value);
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
  ) {}

  async onModuleInit() {
    await this.restoreSchedules();
  }

  async scheduleAgent(
    agentId: string,
    organizationId: string,
    intervalMinutes: number,
    input: Record<string, any> = {},
  ): Promise<Agent> {
    const validated = validateIntervalMinutes(intervalMinutes);
    const agent = await this.agentsService.getAgent(agentId, organizationId);

    // Update agent settings with schedule config
    const settings = { ...(agent.settings || {}) };
    settings.schedule = {
      enabled: true,
      intervalMinutes: validated,
      input,
    } as AgentScheduleConfig;

    agent.settings = settings;
    const saved = await this.agentRepo.save(agent);

    // Add repeatable job to BullMQ
    await this.addRepeatableJob(saved);

    this.logger.log(`[SCHEDULE] Agent ${agentId} scheduled every ${validated} minutes via BullMQ`);
    return saved;
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

      const agents = await this.agentRepo.find({
        where: { status: AgentStatus.ACTIVE },
      });

      // The repeatable-job table is now empty (we just cleared it), so call
      // the cleanup-free enqueue helper directly. The previous shape called
      // addRepeatableJob -> removeRepeatableJob -> getRepeatableJobs inside
      // every iteration, which made restore O(N^2) on startup.
      let restoredCount = 0;
      for (const agent of agents) {
        const schedule = agent.settings?.schedule as AgentScheduleConfig | undefined;
        if (!schedule?.enabled) continue;

        // Skip silently if a stored schedule is corrupted — restore must
        // not crash the whole boot path because one row has a bad value.
        let minutes: number;
        try {
          minutes = validateIntervalMinutes(schedule.intervalMinutes);
        } catch (err: any) {
          this.logger.warn(`[RESTORE] Skipping agent ${agent.id}: ${err.message}`);
          continue;
        }

        await this.enqueueRepeatableJob(agent, minutes, schedule.input || {});
        restoredCount++;
      }

      if (restoredCount > 0) {
        this.logger.log(`[RESTORE] Restored ${restoredCount} scheduled agent(s) via BullMQ`);
      }
    } catch (err: any) {
      this.logger.error(`[RESTORE] Failed to restore schedules: ${err.message}`);
    }
  }

  private async addRepeatableJob(agent: Agent): Promise<void> {
    // Remove existing job for this agent first
    await this.removeRepeatableJob(agent.id);

    const schedule = agent.settings?.schedule as AgentScheduleConfig | undefined;
    const minutes = schedule?.intervalMinutes
      ? validateIntervalMinutes(schedule.intervalMinutes)
      : 60;
    const input = schedule?.input || {};

    await this.enqueueRepeatableJob(agent, minutes, input);
  }

  private async enqueueRepeatableJob(
    agent: Agent,
    minutes: number,
    input: Record<string, any>,
  ): Promise<void> {
    await this.schedulerQueue.add(
      'execute-agent',
      {
        agentId: agent.id,
        organizationId: agent.organizationId,
        userId: agent.createdBy || 'system',
        input,
      },
      {
        repeat: { every: minutes * 60 * 1000 },
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

  @Process('execute-agent')
  async handleScheduledExecution(job: Job): Promise<void> {
    const { agentId, organizationId, userId, input } = job.data;

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

      this.logger.log(`[SCHEDULED_RUN] Executing agent ${agentId}`);
      await this.executionEngine.execute(
        agent,
        organizationId,
        userId,
        {
          input,
          metadata: { triggerType: 'scheduled' },
        },
      );
    } catch (err: any) {
      this.logger.error(`[SCHEDULED_RUN] Failed for agent ${agentId}: ${err.message}`);
    }
  }

  async getScheduledAgents(): Promise<{ agentId: string; interval: number; nextRun: Date }[]> {
    const jobs = await this.schedulerQueue.getRepeatableJobs();
    return jobs.map(job => ({
      agentId: job.id?.replace('schedule-', '') || 'unknown',
      interval: job.every ? job.every / 60000 : 0,
      nextRun: new Date(job.next),
    }));
  }
}
