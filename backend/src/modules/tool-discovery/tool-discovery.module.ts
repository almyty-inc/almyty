import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';

import { MemoryModule } from '../memory/memory.module';
import { ToolDiscoveryService } from './tool-discovery.service';
import { TOOL_EMBEDDING_QUEUE, ToolEmbeddingService } from './tool-embedding.service';
import { ToolEmbeddingProcessor } from './tool-embedding.processor';

/**
 * Tool discovery (docs/design/code-mode.md, part B): search_tools and
 * get_tool over a caller's scope, with hybrid keyword and embedding
 * ranking, and the embeddings that feed it.
 */
@Module({
  imports: [BullModule.registerQueue({ name: TOOL_EMBEDDING_QUEUE }), forwardRef(() => MemoryModule)],
  providers: [ToolDiscoveryService, ToolEmbeddingService, ToolEmbeddingProcessor],
  exports: [ToolDiscoveryService, ToolEmbeddingService],
})
export class ToolDiscoveryModule {}
