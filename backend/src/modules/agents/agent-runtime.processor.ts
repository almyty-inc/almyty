import { Processor, Process, OnQueueFailed } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bull';
import { InjectQueue } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentRuntimeService } from './agent-runtime.service';
import { Agent } from '../../entities/agent.entity';
import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { runWithRequestContext } from '../../common/request-context';

/**
 * A run in one of these is finished; a late queue failure must not
 * reopen it or overwrite the reason it actually ended with.
 */
const TERMINAL_RUN_STATUSES: AgentRunStatus[] = [
  AgentRunStatus.COMPLETED,
  AgentRunStatus.FAILED,
  AgentRunStatus.CANCELLED,
  AgentRunStatus.TIMEOUT,
];

@Processor('agent-runtime')
export class AgentRuntimeProcessor {
  private readonly logger = new Logger(AgentRuntimeProcessor.name);

  constructor(
    private readonly runtimeService: AgentRuntimeService,
    @InjectQueue('agent-runtime')
    private readonly runtimeQueue: Queue,
    @InjectRepository(Agent)
    private readonly agentRepository: Repository<Agent>,
    @InjectRepository(AgentRun)
    private readonly runRepository: Repository<AgentRun>,
  ) {}

  @Process('next-step')
  async handleNextStep(job: Job<{ runId: string; seq?: number; requestId?: string }>) {
    const { runId, seq = 0 } = job.data;

    // Open the correlation scope for this job. The id was minted by the
    // request that started the run and rides in the job payload, so every
    // log line and every row this step writes joins back to it; a job with
    // no id (an older payload, a repeatable job) gets a fresh one rather
    // than none.
    return runWithRequestContext(
      {
        requestId: job.data?.requestId,
        runId,
        queue: 'agent-runtime',
        jobId: String(job.id),
      },
      async () => {
        this.logger.debug(`Processing step for run ${runId}`);

        try {
          const result = await this.runtimeService.processStep(runId);

          if (result === 'continue') {
            // Enqueue the next step
            // Deterministic jobId so a duplicate continuation of the same step
            // (e.g. two workers that both processed this step) collapses to one
            // queued job instead of double-executing. The seq only ever
            // increments, so sequential steps never collide and can't stall.
            await this.runtimeQueue.add(
              'next-step',
              { runId, seq: seq + 1, requestId: job.data?.requestId },
              {
                jobId: `step:${runId}:${seq + 1}`,
                delay: 100, // Small delay to avoid tight loops
                attempts: 3,
                backoff: { type: 'exponential', delay: 2000 },
                removeOnComplete: 100,
                removeOnFail: 50,
              },
            );
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
          throw error; // Let BullMQ handle retries; onFailed records the last one
        }
      },
    );
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
      // Rethrow. Swallowing this made a failing timeout check disappear
      // entirely: no retry, no failed job, and the run left in whatever
      // non-terminal state it was in with nothing recorded anywhere.
      // onFailed below is what turns the last attempt into a row.
      this.logger.error(`Timeout check failed for run ${runId}: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * The failure of last resort.
   *
   * There was no handler here at all. Jobs are enqueued with
   * `attempts: 3, removeOnFail: 50`, and `handleNextStep` only logged and
   * rethrew — so when the third attempt failed, nothing was written: the
   * run's `status` stayed `running`, its `error` stayed null, and the only
   * record of why the queue gave up was a Redis job that the next 50
   * failures (or a Redis restart) would evict. The run reaper eventually
   * swept the row to TIMEOUT after 30 minutes with a generic message,
   * which is both late and wrong about the cause.
   *
   * On the final attempt the reason goes onto the run, in the same shape
   * the reconcile loop uses for a deployment — the row records what went
   * wrong — plus an error step, so the run's own timeline shows where it
   * stopped instead of ending mid-sequence.
   */
  @OnQueueFailed()
  async onFailed(job: Job, error: Error): Promise<void> {
    const attemptsMade = job?.attemptsMade ?? 0;
    const maxAttempts = job?.opts?.attempts ?? 1;
    const isFinalAttempt = attemptsMade >= maxAttempts;

    this.logger.error(
      `Queue job ${job?.name ?? 'unknown'} (${job?.id}) failed on attempt ` +
        `${attemptsMade}/${maxAttempts}: ${error?.message}`,
    );

    if (!isFinalAttempt) return;

    const runId = (job?.data as any)?.runId;
    if (!runId) {
      // A heartbeat job has no run of its own — the log line above is the
      // whole record, and there is no row to put it on.
      return;
    }

    try {
      await this.recordExhaustedRetries(runId, job, error, attemptsMade);
    } catch (writeError: any) {
      // Never throw out of a failure handler; that would replace a
      // recorded failure with an unrecorded one.
      this.logger.error(
        `Could not record the exhausted-retry failure of run ${runId}: ${writeError?.message}`,
      );
    }
  }

  private async recordExhaustedRetries(
    runId: string,
    job: Job,
    error: Error,
    attemptsMade: number,
  ): Promise<void> {
    const run = await this.runRepository.findOne({ where: { id: runId } });
    if (!run) return;

    const statusBefore = run.status;
    if (TERMINAL_RUN_STATUSES.includes(statusBefore)) {
      // Already finished — the reason it finished with is the true one.
      return;
    }

    const reason = (
      `The queue gave up on this run after ${attemptsMade} attempt(s) at step ` +
      `'${job?.name ?? 'next-step'}': ${error?.message || 'unknown error'}`
    ).slice(0, 2000);

    const steps = [
      ...(Array.isArray(run.steps) ? run.steps : []),
      {
        type: 'error',
        error: reason,
        timestamp: new Date().toISOString(),
      },
    ];

    // Guarded on the status we read, so a step that reached a terminal
    // state between that read and this write is not reopened.
    const res = await this.runRepository.update(
      { id: runId, status: statusBefore },
      { status: AgentRunStatus.FAILED, error: reason, steps },
    );
    if ((res.affected ?? 0) === 0) {
      this.logger.warn(
        `Run ${runId} changed status while recording an exhausted-retry failure; left as found`,
      );
      return;
    }

    this.logger.error(`Run ${runId} marked FAILED after exhausted retries: ${error?.message}`);
  }
}
