import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Agent, AgentStatus } from '../../entities/agent.entity';
import { AgentsService } from './agents.service';
import { AgentExecutionEngine } from './agent-execution.engine';

export interface AgentScheduleConfig {
  enabled: boolean;
  intervalMinutes: number;
  input: Record<string, any>;
}

@Injectable()
export class AgentSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(AgentSchedulerService.name);
  private scheduledJobs: Map<string, NodeJS.Timeout> = new Map();

  constructor(
    private readonly agentsService: AgentsService,
    private readonly executionEngine: AgentExecutionEngine,
    @InjectRepository(Agent)
    private readonly agentRepo: Repository<Agent>,
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

    // Start the interval
    this.startInterval(saved);

    this.logger.log(`[SCHEDULE] Agent ${agentId} scheduled every ${intervalMinutes} minutes`);
    return saved;
  }

  async unscheduleAgent(agentId: string, organizationId: string): Promise<Agent> {
    const agent = await this.agentsService.getAgent(agentId, organizationId);

    // Clear existing timer
    this.clearInterval(agentId);

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

    this.logger.log(`[UNSCHEDULE] Agent ${agentId} unscheduled`);
    return saved;
  }

  async restoreSchedules(): Promise<void> {
    try {
      const agents = await this.agentRepo.find({
        where: { status: AgentStatus.ACTIVE },
      });

      let restoredCount = 0;
      for (const agent of agents) {
        const schedule = agent.settings?.schedule as AgentScheduleConfig | undefined;
        if (schedule?.enabled) {
          this.startInterval(agent);
          restoredCount++;
        }
      }

      if (restoredCount > 0) {
        this.logger.log(`[RESTORE] Restored ${restoredCount} scheduled agent(s)`);
      }
    } catch (err: any) {
      this.logger.error(`[RESTORE] Failed to restore schedules: ${err.message}`);
    }
  }

  private startInterval(agent: Agent): void {
    // Clear any existing interval for this agent
    this.clearInterval(agent.id);

    const schedule = agent.settings?.schedule as AgentScheduleConfig | undefined;
    const minutes = schedule?.intervalMinutes || 60;
    const input = schedule?.input || {};

    const timer = setInterval(async () => {
      try {
        this.logger.log(`[SCHEDULED_RUN] Executing agent ${agent.id} (scheduled)`);
        await this.executionEngine.execute(
          agent,
          agent.organizationId,
          agent.createdBy || 'system',
          {
            input,
            metadata: { triggerType: 'scheduled' },
          },
        );
      } catch (err: any) {
        this.logger.error(`Scheduled execution failed for agent ${agent.id}: ${err.message}`);
      }
    }, minutes * 60 * 1000);

    this.scheduledJobs.set(agent.id, timer);
  }

  private clearInterval(agentId: string): void {
    const existing = this.scheduledJobs.get(agentId);
    if (existing) {
      clearInterval(existing);
      this.scheduledJobs.delete(agentId);
    }
  }

  getScheduledAgentIds(): string[] {
    return Array.from(this.scheduledJobs.keys());
  }
}
