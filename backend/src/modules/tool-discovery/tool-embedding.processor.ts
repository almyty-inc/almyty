import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';

import { TOOL_EMBEDDING_QUEUE, ToolEmbeddingService } from './tool-embedding.service';

/** Embeds tools for search_tools (tool-embedding.service.ts). */
@Processor(TOOL_EMBEDDING_QUEUE)
export class ToolEmbeddingProcessor {
  private readonly logger = new Logger(ToolEmbeddingProcessor.name);

  constructor(private readonly embeddings: ToolEmbeddingService) {}

  @Process('embed')
  async embed(job: Job<{ toolId: string }>): Promise<void> {
    if (!job.data?.toolId) return;
    try {
      await this.embeddings.embedTool(job.data.toolId);
    } catch (err: any) {
      // Rethrow so the queue counts the attempt.
      this.logger.warn(`Embedding tool ${job.data.toolId} failed: ${err?.message ?? err}`);
      throw err;
    }
  }

  @Process('backfill')
  async backfill(): Promise<void> {
    const queued = await this.embeddings.backfill();
    if (queued) this.logger.log(`Queued ${queued} tool(s) without an embedding`);
  }
}
