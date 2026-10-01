import { InjectQueue, Process, Processor } from '@nestjs/bull';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bull';

import { AgentChannelsService } from './agent-channels.service';

export const CHANNEL_HOUSEKEEPING_QUEUE = 'channel-housekeeping';

/** Job name for the hourly clear-out of app icons uploaded and never saved. */
export const UNSAVED_ICON_SWEEP_JOB = 'unsaved-icon-sweep';

/**
 * Stable jobId for the repeatable sweep so restarts and replicas do not
 * stack duplicate schedules, and a changed cron evicts the stale one.
 */
export const ICON_SWEEP_REPEAT_JOB_ID = 'channel-unsaved-icon-sweep';

/** Hourly, away from the artifact sweep's minute. */
const DEFAULT_ICON_SWEEP_CRON = '43 * * * *';

/**
 * Channel housekeeping that has nothing to do with builds.
 *
 * Registered on every process, whatever APP_BUILD_MODE says: a deployment
 * with builds off everywhere still has branding pages, and so still has
 * icons uploaded and never saved. The repeatable job is keyed by a fixed
 * jobId, so however many replicas arm it, Redis holds one schedule and
 * each run is consumed by exactly one of them.
 */
@Processor(CHANNEL_HOUSEKEEPING_QUEUE)
export class ChannelHousekeepingProcessor implements OnApplicationBootstrap {
  private readonly logger = new Logger(ChannelHousekeepingProcessor.name);

  constructor(
    @InjectQueue(CHANNEL_HOUSEKEEPING_QUEUE) private readonly queue: Queue,
    private readonly channels: AgentChannelsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    await this.schedule();
  }

  /** Arm the hourly sweep. Best-effort: a Redis hiccup must not take the API down. */
  async schedule(): Promise<void> {
    const cron = (process.env.UNSAVED_ICON_SWEEP_CRON || DEFAULT_ICON_SWEEP_CRON).trim();
    try {
      // Repeatable jobs are keyed by their repeat options, so a changed
      // cron would otherwise leave the old schedule running alongside.
      for (const repeatable of await this.queue.getRepeatableJobs()) {
        if (repeatable.id === ICON_SWEEP_REPEAT_JOB_ID && repeatable.cron !== cron) {
          await this.queue.removeRepeatableByKey(repeatable.key);
        }
      }
      await this.queue.add(
        UNSAVED_ICON_SWEEP_JOB,
        {},
        { jobId: ICON_SWEEP_REPEAT_JOB_ID, repeat: { cron }, removeOnComplete: true, removeOnFail: true },
      );
      this.logger.log(`Unsaved icon sweep scheduled: "${cron}"`);
    } catch (error: any) {
      this.logger.error(`Failed to schedule unsaved icon sweep: ${error.message}`);
    }
  }

  @Process(UNSAVED_ICON_SWEEP_JOB)
  async sweep(): Promise<void> {
    const icons = await this.channels.sweepUnsavedIcons();
    if (icons > 0) this.logger.log(`Cleared ${icons} unsaved app icons`);
  }
}
