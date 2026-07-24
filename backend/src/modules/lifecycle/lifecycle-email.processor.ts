import { InjectQueue, OnQueueFailed, Process, Processor } from '@nestjs/bull';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Job, Queue } from 'bull';

import { LifecycleEmailService } from './lifecycle-email.service';

export const LIFECYCLE_EMAIL_QUEUE = 'lifecycle-email';

/** Job names on the lifecycle queue. */
export const LIFECYCLE_WELCOME_JOB = 'welcome';
export const LIFECYCLE_NUDGE_SWEEP_JOB = 'nudge-sweep';

/**
 * Stable jobId for the repeatable sweep registration so restarts don't
 * stack duplicate schedules, and a changed cron evicts the stale one.
 */
const SWEEP_REPEAT_JOB_ID = 'lifecycle-nudge-sweep';

/**
 * Default sweep cron: once a day at 15:00 UTC (a reasonable send window
 * across US/EU business hours). Override with LIFECYCLE_SWEEP_CRON.
 * MARKETING: refine copy + cadence
 */
const DEFAULT_SWEEP_CRON = '0 15 * * *';

/**
 * BullMQ/Bull processor for new-signup activation emails.
 *
 *   - `welcome` ({ userId })   -> LifecycleEmailService.sendWelcome
 *   - `nudge-sweep` ()         -> LifecycleEmailService.runNudgeSweep
 *
 * The sweep is registered as a repeatable DAILY job on bootstrap. The
 * per-send opt-in gate (LIFECYCLE_EMAILS_ENABLED) lives inside the
 * service, so the queue can stay armed while the feature is off: every
 * handler simply no-ops. Registration is skipped under NODE_ENV=test.
 */
@Processor(LIFECYCLE_EMAIL_QUEUE)
export class LifecycleEmailProcessor implements OnApplicationBootstrap {
  private readonly logger = new Logger(LifecycleEmailProcessor.name);

  constructor(
    @InjectQueue(LIFECYCLE_EMAIL_QUEUE) private readonly queue: Queue,
    private readonly lifecycleEmails: LifecycleEmailService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;

    const cron = (process.env.LIFECYCLE_SWEEP_CRON || DEFAULT_SWEEP_CRON).trim();

    try {
      // Evict a stale registration whose cron differs from the current
      // env (repeatable jobs are keyed by their repeat options, so a
      // changed cron would otherwise leave the old schedule running).
      const existing = await this.queue.getRepeatableJobs();
      for (const repeatable of existing) {
        if (repeatable.id === SWEEP_REPEAT_JOB_ID && repeatable.cron !== cron) {
          await this.queue.removeRepeatableByKey(repeatable.key);
        }
      }

      await this.queue.add(
        LIFECYCLE_NUDGE_SWEEP_JOB,
        {},
        {
          jobId: SWEEP_REPEAT_JOB_ID,
          repeat: { cron },
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
      this.logger.log(`Lifecycle nudge sweep scheduled: "${cron}"`);
    } catch (error: any) {
      // Best-effort — a Redis hiccup at bootstrap must not take the API down.
      this.logger.error(`Failed to schedule lifecycle nudge sweep: ${error.message}`);
    }
  }

  @Process(LIFECYCLE_WELCOME_JOB)
  async handleWelcome(job: Job<{ userId: string }>): Promise<void> {
    const userId = job.data?.userId;
    if (!userId) return;
    await this.lifecycleEmails.sendWelcome(userId);
  }

  @Process(LIFECYCLE_NUDGE_SWEEP_JOB)
  async handleNudgeSweep(): Promise<{ scanned: number; sent: number }> {
    return this.lifecycleEmails.runNudgeSweep();
  }

  @OnQueueFailed()
  onFailed(job: Job, error: Error): void {
    this.logger.error(`Lifecycle job ${job?.id} (${job?.name}) failed: ${error.message}`);
  }
}
