import { InjectQueue, OnQueueFailed, Process, Processor } from '@nestjs/bull';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Job, Queue } from 'bull';

import { ModelCatalogService } from './model-catalog.service';

export const MODEL_CATALOG_SYNC_QUEUE = 'model-catalog-sync';
export const MODEL_CATALOG_BACKFILL_JOB = 'backfill';

/** Stable id so replicas booting together queue the backfill once. */
const BACKFILL_JOB_ID = 'model-catalog-backfill';

/**
 * One-shot catalog backfill at boot: every active LLM provider that has no
 * cards yet gets its model list imported, so organizations set up before
 * the catalog existed can route without anyone syncing by hand. From then
 * on the provider lifecycle hooks keep cards current. Off under
 * NODE_ENV=test and when MODEL_CATALOG_BACKFILL=off.
 */
@Processor(MODEL_CATALOG_SYNC_QUEUE)
export class CatalogSyncProcessor implements OnApplicationBootstrap {
  private readonly logger = new Logger(CatalogSyncProcessor.name);

  constructor(
    @InjectQueue(MODEL_CATALOG_SYNC_QUEUE) private readonly queue: Queue,
    private readonly catalog: ModelCatalogService,
  ) {}

  isEnabled(): boolean {
    return process.env.NODE_ENV !== 'test' && process.env.MODEL_CATALOG_BACKFILL?.trim().toLowerCase() !== 'off';
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.log('Model catalog backfill disabled (NODE_ENV=test or MODEL_CATALOG_BACKFILL=off)');
      return;
    }
    try {
      await this.queue.add(
        MODEL_CATALOG_BACKFILL_JOB,
        { reason: 'bootstrap' },
        { jobId: BACKFILL_JOB_ID, removeOnComplete: true, removeOnFail: true },
      );
      this.logger.log('Model catalog backfill queued');
    } catch (error: any) {
      // Best-effort: a Redis hiccup at bootstrap must not take the API down.
      this.logger.error(`Failed to queue model catalog backfill: ${error.message}`);
    }
  }

  @Process(MODEL_CATALOG_BACKFILL_JOB)
  async handleBackfill(_job?: Job): Promise<{ providers: number; synced: number; created: number; failed: number }> {
    const result = await this.catalog.backfill();
    this.logger.log(
      `Model catalog backfill: ${result.synced} of ${result.providers} provider(s) synced, ${result.created} card(s) created, ${result.failed} failed`,
    );
    return result;
  }

  @OnQueueFailed()
  onFailed(job: Job, error: Error): void {
    this.logger.error(`Model catalog sync job ${job?.id} failed: ${error.message}`);
  }
}
