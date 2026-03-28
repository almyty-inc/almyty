import { Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bull';
import { InjectQueue } from '@nestjs/bull';
import { AgentRuntimeService } from './agent-runtime.service';

@Processor('agent-runtime')
export class AgentRuntimeProcessor {
  private readonly logger = new Logger(AgentRuntimeProcessor.name);

  constructor(
    private readonly runtimeService: AgentRuntimeService,
    @InjectQueue('agent-runtime')
    private readonly runtimeQueue: Queue,
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
        this.logger.log(`Run ${runId} is waiting for input`);
      } else {
        this.logger.log(`Run ${runId} completed`);
      }
    } catch (error) {
      this.logger.error(`Step processing failed for run ${runId}: ${error.message}`, error.stack);
      throw error; // Let BullMQ handle retries
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
