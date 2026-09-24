import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';

import { Agent, AgentPauseReason } from '../../entities/agent.entity';

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
   *
   * `pausedReason` is set when the system turned the heartbeat off on its
   * own (its owner can no longer run the agent), so the agent page can say
   * why instead of leaving only a failed run behind. A heartbeat someone
   * switched off by hand carries none, and turning it back on (which
   * rewrites the heartbeat) clears it.
   */
  async disableHeartbeat(agentId: string, organizationId: string, pausedReason?: AgentPauseReason): Promise<Agent> {
    const agent = await this.agentRepository.findOne({ where: { id: agentId, organizationId } });
    if (!agent) throw new NotFoundException('Agent not found');

    const { pausedReason: _previous, ...heartbeat } = (agent.heartbeat ?? {}) as Agent['heartbeat'];
    agent.heartbeat = { ...heartbeat, enabled: false, ...(pausedReason ? { pausedReason } : {}) } as Agent['heartbeat'];
    await this.agentRepository.save(agent);

    await this.disableHeartbeatJob(agentId);

    this.logger.log(`Heartbeat disabled for agent ${agentId}${pausedReason ? `: ${pausedReason.code}` : ''}`);
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
