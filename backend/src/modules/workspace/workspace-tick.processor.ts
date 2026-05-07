import { Processor, Process, OnQueueError } from '@nestjs/bull';
import { Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Job, Queue } from 'bull';

import { RunnerService } from '../runner/runner.service';
import { WorkspaceService } from './workspace.service';
import { HEARTBEAT_INTERVAL_MS } from '../runner/runner-state';

export const WORKSPACE_TICK_QUEUE = 'workspace-tick';
export const WORKSPACE_TICK_JOB = 'workspace-tick';

/**
 * Single periodic job that drives:
 *
 *   1. Runner state-machine ticks (online -> stale, stale -> offline).
 *   2. Workspace TTL sweep (active -> expired).
 *   3. Stranding fan-out: when (1) flips a runner to offline, every
 *      active workspace pinned to it is marked stranded.
 *
 * Configured to run at HEARTBEAT_INTERVAL_MS cadence (30s). Repeated
 * via a recurring job; addRepeatable on module init keeps the schedule
 * idempotent across restarts (Bull dedupes by jobId).
 */
@Processor(WORKSPACE_TICK_QUEUE)
export class WorkspaceTickProcessor implements OnModuleInit {
  private readonly logger = new Logger(WorkspaceTickProcessor.name);

  constructor(
    @InjectQueue(WORKSPACE_TICK_QUEUE) private readonly queue: Queue,
    private readonly runners: RunnerService,
    private readonly workspaces: WorkspaceService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Schedule the recurring tick. Bull treats addRepeatable as
    // idempotent when the (name, repeat) tuple matches, so calling
    // this on every module init is safe.
    await this.queue.add(
      WORKSPACE_TICK_JOB,
      {},
      {
        repeat: { every: HEARTBEAT_INTERVAL_MS },
        removeOnComplete: true,
        removeOnFail: 100,
        jobId: 'workspace-tick-recurring',
      },
    );
  }

  @Process(WORKSPACE_TICK_JOB)
  async tick(_job: Job): Promise<void> {
    const now = new Date();
    const tick = await this.runners.tick(now);
    if (tick.markStrandedFor.length > 0) {
      await this.workspaces.markStrandedForRunners(tick.markStrandedFor);
    }
    const expired = await this.workspaces.sweepExpired(now);
    if (tick.transitioned > 0 || expired.length > 0) {
      this.logger.log(
        `tick: runners checked=${tick.checked} transitioned=${tick.transitioned} ` +
          `stranded_for=${tick.markStrandedFor.length} expired=${expired.length}`,
      );
    }
  }

  @OnQueueError()
  onError(err: Error): void {
    this.logger.error(`workspace-tick queue error: ${err.message}`);
  }
}
