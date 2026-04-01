import { Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bull';
import { InjectQueue } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentRuntimeService } from './agent-runtime.service';
import { Agent } from '../../entities/agent.entity';

@Processor('agent-runtime')
export class AgentRuntimeProcessor {
  private readonly logger = new Logger(AgentRuntimeProcessor.name);

  constructor(
    private readonly runtimeService: AgentRuntimeService,
    @InjectQueue('agent-runtime')
    private readonly runtimeQueue: Queue,
    @InjectRepository(Agent)
    private readonly agentRepository: Repository<Agent>,
  ) {}

  @Process('next-step')
  async handleNextStep(job: Job<{ runId: string }>) {
    const { runId } = job.data;
    this.logger.debug(`Processing step for run ${runId}`);

    try {
      const result = await this.runtimeService.processStep(runId);

      if (result === 'continue') {
        // Enqueue the next step
        await this.runtimeQueue.add('next-step', { runId }, {
          delay: 100, // Small delay to avoid tight loops
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: 100,
          removeOnFail: 50,
        });
        this.logger.debug(`Enqueued next step for run ${runId}`);
      } else if (result === 'waiting') {
        // Run is either sleeping (delayed resume enqueued by runtime) or waiting for user input.
        // Do NOT enqueue the next step — it will be resumed by the runtime when appropriate.
        this.logger.log(`Run ${runId} is waiting (sleeping or awaiting user input)`);
      } else {
        this.logger.log(`Run ${runId} completed`);
      }
    } catch (error) {
      this.logger.error(`Step processing failed for run ${runId}: ${error.message}`, error.stack);
      throw error; // Let BullMQ handle retries
    }
  }

  @Process('heartbeat')
  async handleHeartbeat(job: Job<{ agentId: string; organizationId: string }>) {
    const { agentId, organizationId } = job.data;
    this.logger.log(`Processing heartbeat for agent ${agentId}`);

    try {
      const agent = await this.agentRepository.findOne({ where: { id: agentId, organizationId } });
      if (!agent || !agent.heartbeat?.enabled || !agent.heartbeat?.prompt) {
        this.logger.warn(`Heartbeat skipped for agent ${agentId}: not configured or disabled`);
        return;
      }

      await this.runtimeService.startRun(
        agentId,
        organizationId,
        'system',
        agent.heartbeat.prompt,
        { maxSteps: 10 },
      );

      this.logger.log(`Heartbeat run started for agent ${agentId}`);
    } catch (error) {
      this.logger.error(`Heartbeat failed for agent ${agentId}: ${error.message}`, error.stack);
      throw error;
    }
  }

  @Process('timeout-check')
  async handleTimeoutCheck(job: Job<{ runId: string }>) {
    const { runId } = job.data;
    this.logger.debug(`Checking timeout for run ${runId}`);

    try {
      // This will be checked in processStep via checkLimits
      await this.runtimeService.processStep(runId);
    } catch (error) {
      this.logger.error(`Timeout check failed for run ${runId}: ${error.message}`);
    }
  }
}
