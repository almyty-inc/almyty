import { Module, OnApplicationBootstrap, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule, InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';

import { Organization } from '../../entities/organization.entity';
import { LlmProvider } from '../../entities/llm-provider.entity';
import { Credential } from '../../entities/credential.entity';
import { LlmProvidersModule } from '../llm-providers/llm-providers.module';
import { CredentialsModule } from '../credentials/credentials.module';

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
import {
  CanonicalMemoryTtlSweeperProcessor,
  TTL_SWEEPER_QUEUE_NAME,
} from './canonical/ttl-sweeper.processor';
import { AlmytyNativeBackend } from './canonical/backends/almyty-native.backend';
import { AnthropicMemoryToolBackend } from './canonical/backends/anthropic-memory-tool.backend';
import { Mem0Backend } from './canonical/backends/mem0.backend';
import { ZepBackend } from './canonical/backends/zep.backend';
import { SupermemoryBackend } from './canonical/backends/supermemory.backend';
import { VertexMemoryBankBackend } from './canonical/backends/vertex-memory-bank.backend';
import { MemoryRouter } from './canonical/memory-router.service';
import { BackendCredentialsResolver } from './canonical/backend-credentials.resolver';
import { DocumentChunkerService } from './canonical/document-chunker.service';

/**
 * Memory module.
 *
 * Houses the canonical-schema-v1 implementation. The legacy
 * `MemoryService` / `MemoryController` / `Memory` entity have been
 * removed (see canonical-schema spec §13: greenfield). Callers
 * outside this module use `CanonicalMemoryService`.
 *
 * Background jobs:
 *   - canonical-memory-embedding (per-write async embedding)
 *   - canonical-memory-ttl-sweeper (every 60s — flips valid_until on
 *     memory-mode rows whose TTL has expired, per spec §7.5)
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      CanonicalMemory,
      CanonicalMemoryWorkspaceConfig,
      CanonicalMemorySoftcapWarning,
      Organization,
      LlmProvider,
      Credential,
    ]),
    BullModule.registerQueue(
      { name: EMBEDDING_QUEUE_NAME },
      { name: TTL_SWEEPER_QUEUE_NAME },
    ),
    forwardRef(() => LlmProvidersModule),
    forwardRef(() => CredentialsModule),
  ],
  providers: [
    EmbeddingService,
    CanonicalMemoryService,
    CanonicalMemoryEmbeddingProcessor,
    CanonicalMemoryTtlSweeperProcessor,
    AlmytyNativeBackend,
    AnthropicMemoryToolBackend,
    Mem0Backend,
    ZepBackend,
    SupermemoryBackend,
    VertexMemoryBankBackend,
    MemoryRouter,
    BackendCredentialsResolver,
    DocumentChunkerService,
  ],
  controllers: [CanonicalMemoryController],
  exports: [CanonicalMemoryService, EmbeddingService, MemoryRouter, DocumentChunkerService],
})
export class MemoryModule implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(TTL_SWEEPER_QUEUE_NAME) private readonly ttlQueue: Queue,
  ) {}

  /**
   * Schedule the TTL sweeper as a repeating BullMQ job. Idempotent —
   * BullMQ deduplicates repeatable jobs by their key (queue + name +
   * cron), so module reloads (HMR / blue-green deploys / autoscaling)
   * don't pile up duplicate schedules.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.ttlQueue.add(
      'sweep',
      {},
      {
        repeat: { every: 60_000 },
        // BullMQ's docs recommend a stable jobId so duplicate registrations
        // resolve to the same scheduled job rather than appending.
        jobId: 'canonical-memory-ttl-sweeper:repeat',
        removeOnComplete: 50,
        removeOnFail: 50,
      },
    );
  }
}
