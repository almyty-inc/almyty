import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';

import { Agent } from '../../entities/agent.entity';

@Injectable()
export class AgentHeartbeatHelper {
  private readonly logger = new Logger(AgentHeartbeatHelper.name);

  constructor(
    @InjectRepository(Agent)
    private readonly agentRepository: Repository<Agent>,
    @InjectQueue('agent-runtime')
    private readonly runtimeQueue: Queue,
  ) {}

  async enableHeartbeat(agentId: string, organizationId: string, intervalMinutes: number, prompt: string): Promise<Agent> {
    const agent = await this.agentRepository.findOne({ where: { id: agentId, organizationId } });
    if (!agent) throw new NotFoundException('Agent not found');

    // Remove any existing heartbeat job for this agent
    await this.disableHeartbeatJob(agentId);

    // Save heartbeat config on the agent
    agent.heartbeat = { enabled: true, intervalMinutes, prompt };
    await this.agentRepository.save(agent);

    // Create a repeating job
    await this.runtimeQueue.add(
      'heartbeat',
      { agentId, organizationId },
      {
        repeat: { every: intervalMinutes * 60 * 1000 },
        jobId: `heartbeat-${agentId}`,
        removeOnComplete: 50,
        removeOnFail: 20,
      },
    );

    this.logger.log(`Heartbeat enabled for agent ${agentId}: every ${intervalMinutes}m`);
    return agent;
  }

  /**
   * Disable heartbeat: removes the repeating BullMQ job and updates the agent.
   */
  async disableHeartbeat(agentId: string, organizationId: string): Promise<Agent> {
    const agent = await this.agentRepository.findOne({ where: { id: agentId, organizationId } });
    if (!agent) throw new NotFoundException('Agent not found');

    agent.heartbeat = { ...agent.heartbeat, enabled: false } as any;
    await this.agentRepository.save(agent);

    await this.disableHeartbeatJob(agentId);

    this.logger.log(`Heartbeat disabled for agent ${agentId}`);
    return agent;
  }

  /**
   * Remove the repeating heartbeat job from the queue.
   */
  async disableHeartbeatJob(agentId: string): Promise<void> {
    try {
      const repeatableJobs = await this.runtimeQueue.getRepeatableJobs();
      for (const job of repeatableJobs) {
        if (job.id === `heartbeat-${agentId}`) {
          await this.runtimeQueue.removeRepeatableByKey(job.key);
        }
      }
    } catch (err) {
      this.logger.warn(`Failed to remove heartbeat job for agent ${agentId}: ${err.message}`);
    }
  }
}
