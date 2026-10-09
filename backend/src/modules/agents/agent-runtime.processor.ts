import { Processor, Process, OnQueueFailed } from '@nestjs/bull';
import { Logger, Optional } from '@nestjs/common';
import { Job, Queue } from 'bull';
import { InjectQueue } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Workspace } from '../../entities/workspace.entity';
import { releaseRunWorkspaces } from '../workspace/run-end-release';
import { AgentRuntimeService } from './agent-runtime.service';
import { Agent } from '../../entities/agent.entity';
import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { runWithRequestContext } from '../../common/request-context';
import { AgentSchedulerService } from './agent-scheduler.service';
import {
  ALWAYS_ON_CAPACITY_JOB,
  ALWAYS_ON_DIGEST_JOB,
  ALWAYS_ON_TICK_JOB,
  ALWAYS_ON_WAKE_JOB,
  AlwaysOnService,
  LEGACY_HEARTBEAT_JOB,
} from './always-on/always-on.service';

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
    // A finished run's runner workspaces are released at once.
    @Optional()
    @InjectRepository(Workspace)
    private readonly workspaceRepository?: Repository<Workspace>,
    // Hands a finished scheduled run's result to its channel or webhook.
    // Optional for the positional unit tests.
    @Optional()
    private readonly scheduler?: AgentSchedulerService,
    // Always on: its timer and wake jobs run here, and a finished run of a
    // standing thread reports through it. Optional for the positional tests.
    @Optional()
    private readonly alwaysOn?: AlwaysOnService,
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
            // Finished (completed, failed, cancelled or timed out): its
            // runner workspaces are released now, freeing the runner.
            await releaseRunWorkspaces(this.workspaceRepository, runId, this.runRepository);
            // A scheduled run's result goes where its schedule said.
            await this.finished(runId);
          }
        } catch (error) {
          this.logger.error(`Step processing failed for run ${runId}: ${error.message}`, error.stack);
          throw error; // Let BullMQ handle retries; onFailed records the last one
        }
      },
    );
  }

  /**
   * Always on's timer (docs/always-on.md). The tick only writes a wake; the
   * wake job decides whether that becomes a run, so a timer and a webhook
   * arriving together are one run on the standing thread, not two.
   */
  @Process(ALWAYS_ON_TICK_JOB)
  async handleAlwaysOnTick(job: Job<{ agentId: string; organizationId: string }>) {
    const { agentId, organizationId } = job.data;
    if (!this.alwaysOn) return;
    await this.alwaysOn.tick(agentId, organizationId);
  }

  /**
   * A heartbeat job left in Redis from before Always on: it fires as a tick.
   * Boot removes these (AlwaysOnService.restoreTimers); this catches one
   * that fires first.
   */
  @Process(LEGACY_HEARTBEAT_JOB)
  async handleLegacyHeartbeat(job: Job<{ agentId: string; organizationId: string }>) {
    return this.handleAlwaysOnTick(job);
  }

  /** Turn an always-on agent's queued wakes into a run on its standing thread. */
  @Process(ALWAYS_ON_WAKE_JOB)
  async handleAlwaysOnWake(job: Job<{ agentId: string; organizationId: string }>) {
    const { agentId, organizationId } = job.data;
    if (!this.alwaysOn) return;
    const outcome = await this.alwaysOn.process(agentId, organizationId);
    this.logger.debug(`Always on for agent ${agentId}: ${outcome}`);
  }

  /** An always-on agent's daily summary (report: 'daily_digest'). */
  @Process(ALWAYS_ON_DIGEST_JOB)
  async handleAlwaysOnDigest(job: Job<{ agentId: string; organizationId: string }>) {
    const { agentId, organizationId } = job.data;
    if (!this.alwaysOn) return;
    const outcome = await this.alwaysOn.digest(agentId, organizationId);
    this.logger.debug(`Daily summary for agent ${agentId}: ${outcome}`);
  }

  /** Turn agents paused for capacity back on where the plan has room again. */
  @Process(ALWAYS_ON_CAPACITY_JOB)
  async handleAlwaysOnCapacity() {
    if (!this.alwaysOn) return;
    const resumed = await this.alwaysOn.resumeAllWithinCapacity();
    if (resumed) this.logger.log(`Always on: ${resumed} agent(s) back on, their plans have room again`);
  }

  /** Everything a finished run hands on: its scheduled result, its always-on report. */
  private async finished(runId: string): Promise<void> {
    await this.scheduler?.deliverScheduledRun(runId);
    await this.alwaysOn?.onRunFinished(runId);
  }
  @Process('timeout-check')
  async handleTimeoutCheck(job: Job<{ runId: string }>) {
    const { runId } = job.data;
    this.logger.debug(`Checking timeout for run ${runId}`);

    try {
      // This will be checked in processStep via checkLimits
      const result = await this.runtimeService.processStep(runId);
      if (result === 'done') {
        await releaseRunWorkspaces(this.workspaceRepository, runId, this.runRepository);
        await this.finished(runId);
      }
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
      // A timer or wake job has no run of its own: the log line above is the
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

    await releaseRunWorkspaces(this.workspaceRepository, runId, this.runRepository);
    await this.finished(runId);
    this.logger.error(`Run ${runId} marked FAILED after exhausted retries: ${error?.message}`);
  }
}
