import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';

import { Organization } from '../../entities/organization.entity';
import { LlmProvider } from '../../entities/llm-provider.entity';
import { LlmProvidersModule } from '../llm-providers/llm-providers.module';

import { EmbeddingService } from './embedding.service';

import { CanonicalMemory } from './canonical/canonical-memory.entity';
import { CanonicalMemoryWorkspaceConfig } from './canonical/canonical-memory-config.entity';
import { CanonicalMemorySoftcapWarning } from './canonical/canonical-memory-softcap-warning.entity';
import {
  CanonicalMemoryService,
  EMBEDDING_QUEUE_NAME,
} from './canonical/canonical-memory.service';
import { CanonicalMemoryController } from './canonical/canonical-memory.controller';
import { CanonicalMemoryEmbeddingProcessor } from './canonical/embedding-worker.processor';
import { AlmytyNativeBackend } from './canonical/backends/almyty-native.backend';
import { AnthropicMemoryToolBackend } from './canonical/backends/anthropic-memory-tool.backend';
import { Mem0Backend } from './canonical/backends/mem0.backend';
import { ZepBackend } from './canonical/backends/zep.backend';
import { SupermemoryBackend } from './canonical/backends/supermemory.backend';
import { VertexMemoryBankBackend } from './canonical/backends/vertex-memory-bank.backend';
import { MemoryRouter } from './canonical/memory-router.service';

/**
 * Memory module.
 *
 * Houses the canonical-schema-v1 implementation. The legacy
 * `MemoryService` / `MemoryController` / `Memory` entity have been
 * removed (see canonical-schema spec §13: greenfield). Callers
 * outside this module use `CanonicalMemoryService`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      CanonicalMemory,
      CanonicalMemoryWorkspaceConfig,
      CanonicalMemorySoftcapWarning,
      Organization,
      LlmProvider,
    ]),
    BullModule.registerQueue({ name: EMBEDDING_QUEUE_NAME }),
    forwardRef(() => LlmProvidersModule),
  ],
  providers: [
    EmbeddingService,
    CanonicalMemoryService,
    CanonicalMemoryEmbeddingProcessor,
    AlmytyNativeBackend,
    AnthropicMemoryToolBackend,
    Mem0Backend,
    ZepBackend,
    SupermemoryBackend,
    VertexMemoryBankBackend,
    MemoryRouter,
  ],
  controllers: [CanonicalMemoryController],
  exports: [CanonicalMemoryService, EmbeddingService, MemoryRouter],
})
export class MemoryModule {}
