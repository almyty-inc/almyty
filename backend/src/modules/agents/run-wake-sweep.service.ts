import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bull';
import { In, IsNull, LessThan, LessThanOrEqual, Or, Repository } from 'typeorm';

import { AgentRun } from '../../entities/agent-run.entity';
import { CLAIMABLE_STATUSES, runLeaseConfig } from './run-lease';

const SWEEP_BATCH = 200;

/**
 * The wake sweep (durable runs step 3, docs/design/durable-runs.md).
 *
 * A run's queue job is only a nudge: what says a run needs a worker is its
 * row, `nextWakeAt` passed and no live lease. Each run is nudged by its own
 * writer (the step's continuation, a sleep's wake, an input or an approval
 * resuming it), and this sweep nudges any run whose time is more than the
 * grace past with nobody holding it: the nudge was lost (a Redis restart,
 * an enqueue that failed), or the worker holding it died and its lease
 * lapsed, in which case the nudged worker takes the run over.
 *
 * The nudge names the step the run is at, so it does nothing if the run's
 * own nudge got there first. Its job id is the run and the due time, kept
 * only while queued, so every pod sweeping at once still queues one job,
 * and a later pass can queue another if that one found nothing to claim.
 */
@Injectable()
export class RunWakeSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RunWakeSweepService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @InjectRepository(AgentRun)
    private readonly runRepository: Repository<AgentRun>,
    @InjectQueue('agent-runtime')
    private readonly runtimeQueue: Queue,
  ) {}

  onModuleInit(): void {
    const { sweepIntervalMs } = runLeaseConfig();
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.sweep()
        .catch((err) => this.logger.warn(`Wake sweep failed: ${err?.message ?? err}`))
        .finally(() => {
          this.running = false;
        });
    }, sweepIntervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Nudge the runs that are due past the grace and that no worker holds. Returns how many. */
  async sweep(now = new Date()): Promise<number> {
    const { wakeGraceMs } = runLeaseConfig();
    const due = await this.runRepository.find({
      where: {
        status: In(CLAIMABLE_STATUSES),
        nextWakeAt: LessThanOrEqual(new Date(now.getTime() - wakeGraceMs)),
        leaseExpiresAt: Or(IsNull(), LessThan(now)),
      },
      select: { id: true, currentStep: true, nextWakeAt: true } as any,
      order: { nextWakeAt: 'ASC' },
      take: SWEEP_BATCH,
    });
    let nudged = 0;
    for (const run of due) {
      const at = new Date(run.nextWakeAt as Date).getTime();
      try {
        await this.runtimeQueue.add('next-step', { runId: run.id, seq: now.getTime(), step: run.currentStep }, {
          jobId: `wake:${run.id}:${at}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: true,
          removeOnFail: true,
        });
        nudged++;
      } catch (err: any) {
        this.logger.warn(`Could not nudge run ${run.id}: ${err?.message ?? err}`);
      }
    }
    if (nudged) this.logger.log(`Wake sweep nudged ${nudged} run(s) past due with no worker holding them`);
    return nudged;
  }
}
