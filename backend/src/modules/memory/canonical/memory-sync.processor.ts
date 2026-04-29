import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';

import { MemorySyncService } from './memory-sync.service';

export const SYNC_QUEUE_NAME = 'canonical-memory-sync';

/**
 * Sync processor. Wakes up periodically (cadence configured at
 * module bootstrap) and reconciles every scope that has a
 * mirror_backend configured.
 */
@Processor(SYNC_QUEUE_NAME)
export class CanonicalMemorySyncProcessor {
  private readonly logger = new Logger(CanonicalMemorySyncProcessor.name);

  constructor(private readonly sync: MemorySyncService) {}

  @Process('sync-all')
  async handle(_job: Job): Promise<{ scopes: number }> {
    const results = await this.sync.syncAll();
    const moved = results.reduce((s, r) => s + r.to_mirror + r.to_primary, 0);
    if (moved > 0) {
      this.logger.log(
        `sync pass: ${results.length} scopes; ${moved} items moved across primaries/mirrors`,
      );
    }
    return { scopes: results.length };
  }
}
