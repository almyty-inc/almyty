import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';

import { CanonicalMemoryService, EMBEDDING_QUEUE_NAME } from './canonical-memory.service';

/**
 * Async embedding worker. Pulls memory ids off the queue, calls
 * `CanonicalMemoryService.fillEmbedding` which delegates to
 * `EmbeddingService` and updates the row with the vector + final
 * `embedding_status`.
 *
 * Retries are handled by BullMQ (3 attempts with exponential
 * backoff, configured at enqueue time). Permanent failures land
 * in `removeOnFail = 100` so the job stays inspectable.
 */
@Processor(EMBEDDING_QUEUE_NAME)
export class CanonicalMemoryEmbeddingProcessor {
  private readonly logger = new Logger(CanonicalMemoryEmbeddingProcessor.name);

  constructor(private readonly memoryService: CanonicalMemoryService) {}

  @Process('embed')
  async handle(job: Job<{ memory_id: string }>): Promise<void> {
    const { memory_id } = job.data;
    if (!memory_id) {
      this.logger.warn(`embed job ${job.id} missing memory_id`);
      return;
    }
    try {
      await this.memoryService.fillEmbedding(memory_id);
    } catch (err: any) {
      // Re-throw so BullMQ counts the attempt; the service has
      // already persisted the embedding_error on the row.
      this.logger.error(`embed job ${job.id} failed for ${memory_id}: ${err.message}`);
      throw err;
    }
  }
}
