import { InjectQueue, OnQueueFailed, Process, Processor } from '@nestjs/bull';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Job, Queue } from 'bull';

import { ApplyToCatalogResult, PriceFeedService } from './price-feed.service';

export const MODEL_PRICE_FEED_QUEUE = 'model-price-feed';
export const MODEL_PRICE_FEED_JOB = 'refresh';

/** Stable ids so restarts do not stack schedules and a cron change can evict the old one. */
const REPEAT_JOB_ID = 'model-price-feed';
const BOOTSTRAP_JOB_ID = 'model-price-feed-bootstrap';

/** Daily at 04:00 UTC, an hour after the provider usage pull. */
const DEFAULT_CRON = '0 4 * * *';

/**
 * Daily model price refresh: pull both feeds, then write prices onto every
 * catalog card. Cadence via MODEL_PRICE_FEED_CRON (or =off), always off
 * under NODE_ENV=test and when MODEL_PRICE_FEED_DISABLED=true. A replica
 * that boots with an empty Redis cache also queues one immediate refresh
 * so cards are not unpriced until 04:00.
 */
@Processor(MODEL_PRICE_FEED_QUEUE)
export class PriceFeedProcessor implements OnApplicationBootstrap {
  private readonly logger = new Logger(PriceFeedProcessor.name);

  constructor(
    @InjectQueue(MODEL_PRICE_FEED_QUEUE) private readonly queue: Queue,
    private readonly priceFeed: PriceFeedService,
  ) {}

  /** The configured cron, or undefined when the refresh is turned off. */
  cron(): string | undefined {
    const raw = process.env.MODEL_PRICE_FEED_CRON?.trim();
    if (raw && raw.toLowerCase() === 'off') return undefined;
    return raw && raw.length > 0 ? raw : DEFAULT_CRON;
  }

  isEnabled(): boolean {
    return (
      process.env.NODE_ENV !== 'test' &&
      !this.priceFeed.isDisabled() &&
      this.cron() !== undefined
    );
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.log(
        'Model price feed refresh disabled (NODE_ENV=test, MODEL_PRICE_FEED_CRON=off or MODEL_PRICE_FEED_DISABLED=true)',
      );
      return;
    }

    const cron = this.cron() as string;

    try {
      // Repeatable jobs are keyed by their repeat options, so a changed
      // cron would leave the old schedule running unless evicted.
      const existing = await this.queue.getRepeatableJobs();
      for (const repeatable of existing) {
        if (repeatable.id === REPEAT_JOB_ID && repeatable.cron !== cron) {
          await this.queue.removeRepeatableByKey(repeatable.key);
        }
      }

      await this.queue.add(
        MODEL_PRICE_FEED_JOB,
        {},
        {
          jobId: REPEAT_JOB_ID,
          repeat: { cron },
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
      this.logger.log(`Model price feed refresh registered: "${cron}"`);

      if (!this.priceFeed.hasData()) {
        // The fixed jobId dedupes across replicas booting at the same time.
        await this.queue.add(
          MODEL_PRICE_FEED_JOB,
          { reason: 'bootstrap' },
          { jobId: BOOTSTRAP_JOB_ID, removeOnComplete: true, removeOnFail: true },
        );
        this.logger.log('Model price feed cache empty, queued an immediate refresh');
      }
    } catch (error: any) {
      // Scheduling is best-effort; a Redis hiccup at bootstrap must not take the API down.
      this.logger.error(`Failed to schedule model price feed refresh: ${error.message}`);
    }
  }

  @Process(MODEL_PRICE_FEED_JOB)
  async handleRefresh(_job?: Job): Promise<ApplyToCatalogResult> {
    await this.priceFeed.refresh();
    const result = await this.priceFeed.applyToCatalog();
    this.logger.log(
      `Model price feed applied: ${result.priced} priced, ${result.unpriced} unpriced, ${result.flagged} flagged`,
    );
    return result;
  }

  @OnQueueFailed()
  onFailed(job: Job, error: Error): void {
    this.logger.error(`Model price feed job ${job?.id} failed: ${error.message}`);
  }
}
