import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
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
    const agent = await this.agentsService.getAgent(agentId, organizationId);

    // Update agent settings with schedule config
    const settings = { ...(agent.settings || {}) };
    settings.schedule = {
      enabled: true,
      intervalMinutes,
      input,
    } as AgentScheduleConfig;

    agent.settings = settings;
    const saved = await this.agentRepo.save(agent);

    // Add repeatable job to BullMQ
    await this.addRepeatableJob(saved);

    this.logger.log(`[SCHEDULE] Agent ${agentId} scheduled every ${intervalMinutes} minutes via BullMQ`);
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

      let restoredCount = 0;
      for (const agent of agents) {
        const schedule = agent.settings?.schedule as AgentScheduleConfig | undefined;
        if (schedule?.enabled) {
          await this.addRepeatableJob(agent);
          restoredCount++;
        }
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
    const minutes = schedule?.intervalMinutes || 60;
    const input = schedule?.input || {};

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

    try {
      // Verify agent is still active and schedule is still enabled
      const agent = await this.agentRepo.findOne({ where: { id: agentId } });
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
